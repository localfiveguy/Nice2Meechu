"""Founder-only admin endpoints + the inactive-user video cleanup worker."""
import asyncio
import os
import re
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool

from auth import current_user
from core import ADMIN_EMAILS, _get_gcs_bucket, db, logger

router = APIRouter()


def _require_admin(user):
    """Reject the request unless the caller's email is in ADMIN_EMAILS env."""
    if not ADMIN_EMAILS:
        raise HTTPException(403, "Admin not configured")
    if (user.get("email") or "").lower() not in ADMIN_EMAILS:
        raise HTTPException(403, "Forbidden")


@router.get("/admin/funnel")
async def admin_funnel(user=Depends(current_user)):
    """Founder-only dashboard data — server-side onboarding & engagement funnel.
    Use this instead of waiting 24h for GA4 to backfill. Gated by ADMIN_EMAILS.
    """
    _require_admin(user)

    real_users_q = {"is_demo": {"$ne": True}}
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
    real_user_ids = await db.users.distinct("id", real_users_q)
    real_user_set = set(real_user_ids)
    liked_someone = len([u for u in likers if u in real_user_set])

    match_user_ids = await db.matches.distinct("user_ids")
    got_a_match = len([u for u in match_user_ids if u in real_user_set])

    matches_total = await db.matches.count_documents({})
    messages_total = await db.messages.count_documents({})
    reports_total = await db.reports.count_documents({})

    now = datetime.now(timezone.utc)
    seven_ago = (now - timedelta(days=7)).isoformat()
    thirty_ago = (now - timedelta(days=30)).isoformat()
    signups_7d = await db.users.count_documents({**real_users_q, "created_at": {"$gte": seven_ago}})
    signups_30d = await db.users.count_documents({**real_users_q, "created_at": {"$gte": thirty_ago}})

    # Top 10 cities by real users
    pipeline = [
        {"$match": {**real_users_q, "city": {"$nin": [None, ""]}}},
        {"$group": {"_id": "$city", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
        {"$limit": 10},
    ]
    top_cities = []
    async for doc in db.users.aggregate(pipeline):
        top_cities.append({"city": doc["_id"], "count": doc["count"]})

    funnel = [
        {"step": "signed_up", "count": total},
        {"step": "accepted_community_rules", "count": accepted_rules},
        {"step": "set_handle", "count": set_handle},
        {"step": "set_city", "count": set_city},
        {"step": "recorded_intro", "count": recorded_video},
        {"step": "liked_someone", "count": liked_someone},
        {"step": "got_a_match", "count": got_a_match},
    ]
    # Conversion % vs. previous step
    prev = None
    for step in funnel:
        if prev and prev["count"]:
            step["conv_from_prev_pct"] = round(100 * step["count"] / prev["count"], 1)
        else:
            step["conv_from_prev_pct"] = 100.0 if prev is None else 0.0
        prev = step

    return {
        "generated_at": now.isoformat(),
        "totals": {
            "real_users": total,
            "matches": matches_total,
            "messages": messages_total,
            "reports": reports_total,
        },
        "funnel": funnel,
        "recent": {"signups_7d": signups_7d, "signups_30d": signups_30d},
        "top_cities": top_cities,
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
