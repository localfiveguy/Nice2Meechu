"""Founder-only admin endpoints + the inactive-user video cleanup worker."""
import asyncio
import os
import re
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool

from auth import current_user
from core import ADMIN_EMAILS, _geocode_city, _get_gcs_bucket, db, logger

router = APIRouter()


@router.get("/admin/find-user")
async def admin_find_user(q: str = "", user=Depends(current_user)):
    """Founder tool: locate accounts by name/email/codename/handle/home city
    (or exact id). Open signed-in in a browser: /api/admin/find-user?q=steve
    Each result includes a ready-made delete_url."""
    _require_admin(user)
    if len(q.strip()) < 2:
        raise HTTPException(400, "q must be at least 2 characters")
    q = q.strip()
    rx = {"$regex": re.escape(q), "$options": "i"}
    out = []
    async for u in db.users.find(
        {"$or": [{"email": rx}, {"name": rx}, {"first_name": rx}, {"codename": rx},
                 {"handle": rx}, {"home_city": rx}, {"id": q}]},
        {"_id": 0, "id": 1, "email": 1, "name": 1, "first_name": 1, "codename": 1,
         "handle": 1, "home_city": 1, "city": 1, "is_demo": 1, "created_at": 1,
         "google_sub": 1, "apple_sub": 1, "video_url": 1},
    ).limit(25):
        out.append({
            "id": u["id"],
            "codename": u.get("codename"),
            "first_name": u.get("first_name"),
            "email": u.get("email"),
            "handle": u.get("handle"),
            "home_city": u.get("home_city"),
            "browsing_city": u.get("city"),
            "created_at": u.get("created_at"),
            "signin": "+".join(filter(None, [
                "google" if u.get("google_sub") else None,
                "apple" if u.get("apple_sub") else None,
            ])) or "legacy",
            "has_video": bool(u.get("video_url")),
            "is_demo": bool(u.get("is_demo")),
            "delete_url": f"/api/admin/delete-user?id={u['id']}&confirm=DELETE",
            "set_home_city_url": f"/api/admin/set-home-city?id={u['id']}&city=REPLACE_ME&confirm=SET",
        })
    return {"count": len(out), "users": out}


@router.get("/admin/delete-user")
async def admin_delete_user(id: str = "", confirm: str = "", user=Depends(current_user)):
    """Founder tool: permanently wipe a (duplicate) account and everything it
    owns. GET so it runs from a phone browser. Guarded by admin auth, an
    explicit confirm=DELETE, and hard refusals for demo accounts and any
    account on the admin list (you can't nuke your main account)."""
    _require_admin(user)
    if confirm != "DELETE":
        raise HTTPException(400, "Add &confirm=DELETE to the address to really delete")
    target = await db.users.find_one({"id": id}, {"_id": 0})
    if not target:
        raise HTTPException(404, "No user with that id")
    if target.get("is_demo"):
        raise HTTPException(403, "Demo accounts are managed automatically")
    if (target.get("email") or "").lower() in ADMIN_EMAILS:
        raise HTTPException(403, "Refusing to delete an admin account")
    uid = target["id"]
    await db.messages.delete_many({"$or": [{"from_user_id": uid}, {"to_user_id": uid}]})
    await db.matches.delete_many({"user_ids": uid})
    await db.swipes.delete_many({"$or": [{"user_id": uid}, {"target_user_id": uid}]})
    await db.user_sessions.delete_many({"user_id": uid})
    await db.push_subscriptions.delete_many({"user_id": uid})
    await db.signatures.delete_many({"user_id": uid})
    await db.users.delete_one({"id": uid})
    # Best-effort: remove their intro video blobs from GCS too.
    try:
        bucket = _get_gcs_bucket()
        def _purge_blobs():
            for ext in ("mp4", "webm", "mov"):
                blob = bucket.blob(f"user_videos/{uid}.{ext}")
                if blob.exists():
                    blob.delete()
        await run_in_threadpool(_purge_blobs)
    except Exception:  # noqa: BLE001
        logger.exception("delete-user: GCS video purge failed for %s (account already deleted)", uid)
    logger.info("ADMIN delete-user: %s (%s / %s) removed by %s",
                uid, target.get("codename"), target.get("email"), user.get("email"))
    return {"ok": True, "deleted": uid, "codename": target.get("codename"), "email": target.get("email")}


@router.get("/admin/set-home-city")
async def admin_set_home_city(id: str = "", city: str = "", confirm: str = "", user=Depends(current_user)):
    """Founder tool: correct a user's saved home town (where their video shows
    in feeds). GET so it runs from a phone browser, e.g.:
    /api/admin/set-home-city?id=<uid>&city=Erial,%20NJ,%20USA&confirm=SET
    The label is geocoded fresh (no cache) so home coords stay honest."""
    _require_admin(user)
    city = city.strip()[:120]
    if not id or len(city) < 2:
        raise HTTPException(400, "Need id and city, e.g. ?id=<uid>&city=Erial, NJ, USA")
    if confirm != "SET":
        raise HTTPException(400, "Add &confirm=SET to the address to really change it")
    target = await db.users.find_one({"id": id}, {"_id": 0, "id": 1, "codename": 1, "email": 1,
                                                  "home_city": 1, "is_demo": 1})
    if not target:
        raise HTTPException(404, "No user with that id")
    if target.get("is_demo"):
        raise HTTPException(403, "Demo accounts are managed automatically")
    lat, lng = await _geocode_city(city, use_cache=False)
    if lat is None:
        raise HTTPException(422, f"Could not geocode '{city}' — check spelling, include state/country")
    await db.users.update_one(
        {"id": id},
        {"$set": {"home_city": city, "home_lat": lat, "home_lng": lng}},
    )
    logger.info("ADMIN set-home-city: %s (%s) %r -> %r by %s",
                id, target.get("codename"), target.get("home_city"), city, user.get("email"))
    return {"ok": True, "id": id, "codename": target.get("codename"),
            "old_home_city": target.get("home_city"), "new_home_city": city,
            "home_lat": lat, "home_lng": lng}


@router.get("/admin/diagnose-feed")
async def diagnose_feed(user=Depends(current_user)):
    """Production visibility for the Tokyo-in-Marlton saga: dumps the viewer's
    stored location, the geocode cache entry, the computed browse center, and
    every local/nearby feed candidate with raw home coords + video URL prefix.
    Open in a signed-in browser: /api/admin/diagnose-feed"""
    _require_admin(user)
    from feed import _browse_center, _local_candidates, _same_town_candidates

    viewer_city = (user.get("city") or "").strip().split(",")[0].strip().lower()
    base_filter = {
        "id": {"$ne": user["id"]},
        "video_url": {"$ne": None, "$exists": True},
    }
    locals_ = await _local_candidates(base_filter, viewer_city) if viewer_city else []
    lat, lng, healed = await _browse_center(user, locals_) if viewer_city else (None, None, False)
    same_town = []
    if lat is not None:
        same_town = await _same_town_candidates(base_filter, lat, lng, {c["id"] for c in locals_})
    geo = await db.city_geo.find_one(
        {"key": (user.get("city") or "").strip().lower()}, {"_id": 0}
    )

    def slim(u):
        d = {k: u.get(k) for k in (
            "id", "codename", "first_name", "home_city", "home_lat", "home_lng",
            "lat", "lng", "city", "is_demo", "created_at",
        )}
        d["video_url_prefix"] = (u.get("video_url") or "")[:70]
        d["near_km"] = u.get("_near_km")
        return d

    return {
        "build": "v1.6.8-town-label-match",
        "you": {k: user.get(k) for k in (
            "id", "email", "city", "city_lat", "city_lng", "lat", "lng",
            "home_city", "home_lat", "home_lng",
        )},
        "geocache_entry_for_your_city": geo,
        "browse_center": {"lat": lat, "lng": lng, "healed_this_request": healed},
        "locals_count": len(locals_),
        "locals": [slim(u) for u in locals_],
        "same_town_count": len(same_town),
        "same_town": [slim(u) for u in same_town],
    }


def _require_admin(user):
    """Reject the request unless the caller's email is in ADMIN_EMAILS env."""
    if not ADMIN_EMAILS:
        raise HTTPException(403, "Admin not configured")
    if (user.get("email") or "").lower() not in ADMIN_EMAILS:
        raise HTTPException(403, "Forbidden")


async def _funnel_steps(real_users_q: dict) -> list:
    """Ordered onboarding/engagement funnel with per-step conversion %."""
    total = await db.users.count_documents(real_users_q)
    accepted_rules = await db.users.count_documents({**real_users_q, "agreed_to_rules_at": {"$exists": True}})
    set_handle = await db.users.count_documents({**real_users_q, "handle": {"$nin": [None, ""]}})
    set_city = await db.users.count_documents({**real_users_q, "city": {"$nin": [None, ""]}})
    recorded_video = await db.users.count_documents({
        **real_users_q,
        "video_url": {"$regex": r"^https?://"},  # only real recordings (HTTP/GCS URLs)
    })

    # Distinct real-user IDs who liked someone / ended up in a match.
    likers = await db.swipes.distinct("user_id", {"is_like": True})
    real_user_set = set(await db.users.distinct("id", real_users_q))
    liked_someone = len([u for u in likers if u in real_user_set])
    match_user_ids = await db.matches.distinct("user_ids")
    got_a_match = len([u for u in match_user_ids if u in real_user_set])

    funnel = [
        {"step": "signed_up", "count": total},
        {"step": "accepted_community_rules", "count": accepted_rules},
        {"step": "set_handle", "count": set_handle},
        {"step": "set_city", "count": set_city},
        {"step": "recorded_intro", "count": recorded_video},
        {"step": "liked_someone", "count": liked_someone},
        {"step": "got_a_match", "count": got_a_match},
    ]
    prev = None
    for step in funnel:
        if prev and prev["count"]:
            step["conv_from_prev_pct"] = round(100 * step["count"] / prev["count"], 1)
        else:
            step["conv_from_prev_pct"] = 100.0 if prev is None else 0.0
        prev = step
    return funnel


async def _top_cities(real_users_q: dict) -> list:
    pipeline = [
        {"$match": {**real_users_q, "city": {"$nin": [None, ""]}}},
        {"$group": {"_id": "$city", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
        {"$limit": 10},
    ]
    return [
        {"city": doc["_id"], "count": doc["count"]}
        async for doc in db.users.aggregate(pipeline)
    ]


@router.get("/admin/funnel")
async def admin_funnel(user=Depends(current_user)):
    """Founder-only dashboard data — server-side onboarding & engagement funnel.
    Use this instead of waiting 24h for GA4 to backfill. Gated by ADMIN_EMAILS.
    """
    _require_admin(user)

    real_users_q = {"is_demo": {"$ne": True}}
    funnel = await _funnel_steps(real_users_q)

    now = datetime.now(timezone.utc)
    seven_ago = (now - timedelta(days=7)).isoformat()
    thirty_ago = (now - timedelta(days=30)).isoformat()

    return {
        "generated_at": now.isoformat(),
        "totals": {
            "real_users": funnel[0]["count"],
            "matches": await db.matches.count_documents({}),
            "messages": await db.messages.count_documents({}),
            "reports": await db.reports.count_documents({}),
        },
        "funnel": funnel,
        "recent": {
            "signups_7d": await db.users.count_documents({**real_users_q, "created_at": {"$gte": seven_ago}}),
            "signups_30d": await db.users.count_documents({**real_users_q, "created_at": {"$gte": thirty_ago}}),
        },
        "top_cities": await _top_cities(real_users_q),
    }


async def _run_inactive_cleanup(days: int, dry_run: bool) -> dict:
    """Internal worker for inactive-user video cleanup. Pulled out of the API
    handler so the same logic can be invoked by the daily background scheduler.

    Deletes intro videos from GCS for users who haven't signed in within the
    last `days` days, then nulls `video_url`/`transcript` on the user record
    so they re-record on next sign-in. The user account itself is preserved.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    query = {
        "is_demo": {"$ne": True},
        "video_url": {"$regex": r"^https?://"},
        "$or": [
            {"last_seen_at": {"$lt": cutoff}},
            {"last_seen_at": {"$exists": False}},
        ],
    }
    candidates = await db.users.find(
        query,
        {"_id": 0, "id": 1, "email": 1, "video_url": 1, "last_seen_at": 1},
    ).to_list(5000)

    if dry_run:
        return {
            "dry_run": True,
            "cutoff": cutoff,
            "candidate_count": len(candidates),
            "candidates": [
                {"id": c["id"], "email": c.get("email"), "last_seen_at": c.get("last_seen_at")}
                for c in candidates[:50]
            ],
        }

    bucket = _get_gcs_bucket()
    deleted_keys: list = []
    failed_keys: list = []
    for c in candidates:
        url = c.get("video_url") or ""
        m = re.search(r"/nicemeechu/(user_videos/[^?]+)", url)
        if not m:
            continue
        key = m.group(1)
        try:
            await run_in_threadpool(lambda k=key: bucket.blob(k).delete())
            deleted_keys.append(key)
        except Exception as exc:  # noqa: BLE001
            failed_keys.append({"key": key, "error": str(exc)})
        await db.users.update_one(
            {"id": c["id"]},
            {"$set": {
                "video_url": None,
                "transcript": None,
                "inactivity_cleaned_at": datetime.now(timezone.utc).isoformat(),
            }},
        )

    return {
        "dry_run": False,
        "cutoff": cutoff,
        "candidate_count": len(candidates),
        "deleted_count": len(deleted_keys),
        "failed": failed_keys,
    }


@router.post("/admin/inactive-cleanup")
async def admin_inactive_cleanup(days: int = 90, dry_run: bool = True, user=Depends(current_user)):
    """Delete intro videos (from GCS) for users who haven't signed in within
    the last `days` days. Sets `video_url` to None on the user record so they
    re-record on next sign-in. Keeps the user account itself intact (only the
    video is removed) — that's friendlier than full account deletion AND
    keeps storage costs predictable.

    `dry_run=True` (the default) returns the would-affect set without doing
    anything. Pass `?dry_run=false` to actually delete.
    """
    _require_admin(user)
    if days < 14:
        raise HTTPException(400, "Minimum days=14 to avoid accidents")
    return await _run_inactive_cleanup(days=days, dry_run=dry_run)


async def inactive_cleanup_loop():
    """Daily inactivity-cleanup background loop. Runs every 24h while the
    process is alive — sleeps an initial delay first so the first pass doesn't
    compete with cold-start traffic. Toggleable via INACTIVE_CLEANUP_ENABLED."""
    enabled = os.environ.get("INACTIVE_CLEANUP_ENABLED", "true").lower() in ("1", "true", "yes")
    if not enabled:
        logger.info("Inactive-cleanup scheduler disabled via env")
        return
    days = int(os.environ.get("INACTIVE_CLEANUP_DAYS", "90"))
    interval_s = int(os.environ.get("INACTIVE_CLEANUP_INTERVAL_SECONDS", str(24 * 60 * 60)))
    # Initial delay (15 min) keeps the heavy GCS sweep out of cold-start traffic.
    await asyncio.sleep(int(os.environ.get("INACTIVE_CLEANUP_INITIAL_DELAY_SECONDS", "900")))
    while True:
        try:
            result = await _run_inactive_cleanup(days=days, dry_run=False)
            logger.info(
                "Inactive-cleanup pass complete: %d candidates, %d deleted",
                result.get("candidate_count", 0),
                result.get("deleted_count", 0),
            )
        except Exception:  # noqa: BLE001
            logger.exception("Inactive-cleanup pass failed (will retry next cycle)")
        await asyncio.sleep(interval_s)
