"""Web Push (VAPID) — opt-in "notify me when someone new joins nearby".

Pure browser-native push, no third-party service. Subscriptions live in
db.push_subscriptions (unique endpoint); the opt-in flag is
users.notify_new_nearby. users.py fires notify_new_nearby() when a user
saves their FIRST intro video.
"""
import json
import os
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel
from pywebpush import WebPushException, webpush

from auth import current_user
from core import NEARBY_RADIUS_KM, db, haversine_km, logger

router = APIRouter()

VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "")
VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY", "")
VAPID_SUBJECT = os.environ.get("VAPID_SUBJECT", "mailto:admin@nice2meechu.com")


class PushSubscribeReq(BaseModel):
    subscription: dict  # PushSubscription.toJSON(): {endpoint, keys:{p256dh,auth}, ...}


class PushUnsubscribeReq(BaseModel):
    endpoint: Optional[str] = None  # omit to drop ALL of the user's subscriptions


@router.get("/push/public-key")
async def push_public_key():
    if not VAPID_PUBLIC_KEY:
        raise HTTPException(500, "VAPID keys not configured")
    return {"public_key": VAPID_PUBLIC_KEY}


@router.get("/push/status")
async def push_status(user=Depends(current_user)):
    count = await db.push_subscriptions.count_documents({"user_id": user["id"]})
    return {"enabled": bool(user.get("notify_new_nearby")), "subscriptions": count}


@router.post("/push/subscribe")
async def push_subscribe(req: PushSubscribeReq, user=Depends(current_user)):
    sub = req.subscription or {}
    endpoint = sub.get("endpoint")
    keys = sub.get("keys") or {}
    if not endpoint or not keys.get("p256dh") or not keys.get("auth"):
        raise HTTPException(400, "Malformed push subscription")
    await db.push_subscriptions.update_one(
        {"endpoint": endpoint},
        {"$set": {
            "endpoint": endpoint,
            "keys": {"p256dh": keys["p256dh"], "auth": keys["auth"]},
            "user_id": user["id"],
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }},
        upsert=True,
    )
    await db.users.update_one({"id": user["id"]}, {"$set": {"notify_new_nearby": True}})
    return {"ok": True, "enabled": True}


@router.post("/push/unsubscribe")
async def push_unsubscribe(req: PushUnsubscribeReq, user=Depends(current_user)):
    if req.endpoint:
        await db.push_subscriptions.delete_one({"endpoint": req.endpoint, "user_id": user["id"]})
    else:
        await db.push_subscriptions.delete_many({"user_id": user["id"]})
    remaining = await db.push_subscriptions.count_documents({"user_id": user["id"]})
    if remaining == 0:
        await db.users.update_one({"id": user["id"]}, {"$set": {"notify_new_nearby": False}})
    return {"ok": True, "enabled": remaining > 0}


def _send_one(sub_doc: dict, payload_json: str):
    """Sync pywebpush call — run via threadpool. Returns None on success,
    or the HTTP status code on failure (404/410 → stale, delete)."""
    try:
        webpush(
            subscription_info={
                "endpoint": sub_doc["endpoint"],
                "keys": {"p256dh": sub_doc["keys"]["p256dh"], "auth": sub_doc["keys"]["auth"]},
            },
            data=payload_json,
            vapid_private_key=VAPID_PRIVATE_KEY,
            vapid_claims={"sub": VAPID_SUBJECT},  # fresh dict each call — pywebpush mutates it
            timeout=15,
        )
        return None
    except WebPushException as ex:
        return getattr(getattr(ex, "response", None), "status_code", -1)
    except Exception:  # noqa: BLE001
        return -1


def _radius_covers(subscriber: dict, new_lat, new_lng, new_city_key: str) -> bool:
    """True when the new user's home falls inside this subscriber's world:
    same home city, or within their nearby_radius_km of their home center."""
    sub_city = (subscriber.get("home_city") or "").split(",")[0].strip().lower()
    if new_city_key and sub_city == new_city_key:
        return True
    c_lat = subscriber.get("home_lat") or subscriber.get("city_lat") or subscriber.get("lat")
    c_lng = subscriber.get("home_lng") or subscriber.get("city_lng") or subscriber.get("lng")
    if c_lat is None or new_lat is None:
        return False
    radius = subscriber.get("nearby_radius_km") or NEARBY_RADIUS_KM
    return haversine_km(c_lat, c_lng, new_lat, new_lng) <= radius


async def _matching_recipient_ids(new_user: dict, new_lat, new_lng, new_city_key: str) -> list:
    recipients = []
    async for u in db.users.find(
        {"notify_new_nearby": True, "id": {"$ne": new_user["id"]}},
        {"_id": 0, "id": 1, "home_city": 1, "home_lat": 1, "home_lng": 1,
         "city_lat": 1, "city_lng": 1, "lat": 1, "lng": 1, "nearby_radius_km": 1},
    ).limit(2000):
        if _radius_covers(u, new_lat, new_lng, new_city_key):
            recipients.append(u["id"])
    return recipients


async def _deliver_to_subscriptions(recipient_ids: list, payload_json: str) -> int:
    """Send the payload to every subscription of the given users; prune
    stale endpoints (404/410). Returns the number of successful pushes."""
    sent = 0
    async for sub in db.push_subscriptions.find({"user_id": {"$in": recipient_ids}}, {"_id": 0}):
        status = await run_in_threadpool(_send_one, sub, payload_json)
        if status is None:
            sent += 1
        elif status in (404, 410):
            await db.push_subscriptions.delete_one({"endpoint": sub["endpoint"]})
    return sent


async def notify_user(user_id: str, body: str, url: str = "/", tag: Optional[str] = None) -> int:
    """Push a single-line notification to one opted-in user. Used for match
    and new-message events. `tag` lets same-thread notifications collapse
    instead of stacking. No-op for demos / opted-out / unconfigured VAPID."""
    if not (VAPID_PRIVATE_KEY and VAPID_PUBLIC_KEY):
        return 0
    u = await db.users.find_one({"id": user_id}, {"_id": 0, "notify_new_nearby": 1})
    if not u or not u.get("notify_new_nearby"):
        return 0
    payload = {"title": "Nice2Meechu", "body": body, "url": url}
    if tag:
        payload["tag"] = tag
    sent = await _deliver_to_subscriptions([user_id], json.dumps(payload))
    logger.info("notify_user: %d push(es) to %s (%s)", sent, user_id, tag or "untagged")
    return sent


async def notify_new_nearby(new_user: dict) -> dict:
    """Push '👋 Someone new just joined near <City>' to every opted-in user
    whose radius covers the new user's home. Fire-and-forget from users.py."""
    if not (VAPID_PRIVATE_KEY and VAPID_PUBLIC_KEY):
        return {"sent": 0, "reason": "vapid not configured"}

    new_lat = new_user.get("home_lat") or new_user.get("city_lat") or new_user.get("lat")
    new_lng = new_user.get("home_lng") or new_user.get("city_lng") or new_user.get("lng")
    city_short = (new_user.get("home_city") or new_user.get("city") or "").split(",")[0].strip()
    if not city_short and new_lat is None:
        return {"sent": 0, "reason": "no location"}

    recipients = await _matching_recipient_ids(new_user, new_lat, new_lng, city_short.lower())
    if not recipients:
        return {"sent": 0, "reason": "no recipients in range"}

    payload = json.dumps({
        "title": "Nice2Meechu",
        "body": f"👋 Someone new just joined near {city_short or 'you'} — come say hi!",
        "url": "/",
    })
    sent = await _deliver_to_subscriptions(recipients, payload)
    logger.info("notify_new_nearby: %d recipients, %d pushes sent (new user in %s)",
                len(recipients), sent, city_short)
    return {"sent": sent, "recipients": len(recipients)}
