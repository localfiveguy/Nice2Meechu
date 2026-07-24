"""Web Push (VAPID) — opt-in match & message notifications.

Pure browser-native push, no third-party service. Subscriptions live in
db.push_subscriptions (unique endpoint); the opt-in flag is
users.notify_new_nearby (legacy field name — now gates match/message pushes;
the "someone new joined nearby" broadcast was removed by owner request)."""
import json
import os
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel
from pywebpush import WebPushException, webpush

from auth import current_user
from core import db, logger

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
