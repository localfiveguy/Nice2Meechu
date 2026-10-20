"""Nice2Meechu backend entrypoint — wires the modular routers together.

Route logic lives in: auth.py, users.py, feed.py, messaging.py, media.py,
demos.py, admin.py. Shared config/helpers live in core.py; request models
in models.py. This file only assembles the app: routers, static mounts,
CORS, and startup/shutdown lifecycle (migrations + background workers).
"""
import asyncio
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.middleware.cors import CORSMiddleware

import admin
import auth
import demos
import export_db
import import_db
import feed
import media
import messaging
import push
import users
from admin import inactive_cleanup_loop
from core import ROOT_DIR, _strip_city_noise, client, db, logger

app = FastAPI()


# Kubernetes liveness/readiness probes hit /health directly on the backend
# port (no /api prefix) — without this route the probes 404 and the
# production deployment is marked unhealthy.
@app.get("/health")
async def health():
    return {"status": "ok"}


for module in (auth, users, feed, messaging, media, demos, admin, export_db, import_db, push):
    app.include_router(module.router, prefix="/api")

# Serve sample intro videos through the backend so the production CDN
# preserves Content-Type (video/mp4) and byte-range support — required for
# mobile browser playback. The frontend static deploy was returning
# application/octet-stream which silently breaks <video> autoplay on mobile.
_VIDEOS_DIR = ROOT_DIR / "videos"
if _VIDEOS_DIR.is_dir():
    app.mount("/api/videos", StaticFiles(directory=str(_VIDEOS_DIR)), name="videos")

# User-recorded intros land here (persistent disk). Created on first upload.
_USER_VIDEOS_DIR = ROOT_DIR / "user_videos"
_USER_VIDEOS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/api/user-videos", StaticFiles(directory=str(_USER_VIDEOS_DIR)), name="user_videos")

# Pre-rendered social share cards (Instagram/Facebook story + feed). Generated
# offline by /app/scripts/make_share_cards.py — served as static PNGs so the
# operator can preview/download them at /api/share-cards/<name>.png.
_SHARE_CARDS_DIR = ROOT_DIR.parent / "share_cards"  # repo-root/share_cards (was hard-coded /app/)
if _SHARE_CARDS_DIR.is_dir():
    app.mount("/api/share-cards", StaticFiles(directory=str(_SHARE_CARDS_DIR)), name="share_cards")

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    # SEC-001: explicit origin allowlist — never "*" with credentialed cookies,
    # otherwise any website the user visits can read/act on their session.
    allow_origins=[o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def _repair_mismatched_user_coords():
    """One-shot migration: any NON-demo user whose stored coordinates disagree
    (>100 km) with a FRESH geocode of their stored city labels gets home_lat/
    home_lng/city_lat/city_lng overwritten from that fresh geocode. Repairs
    accounts poisoned during the cached-geocode era. Cached coordinates are
    never used — every value written comes straight from Photon this run."""
    if await db.migrations.find_one({"id": "repair_user_coords_v1"}):
        return
    from core import _geocode_city, haversine_km

    fresh_this_run: dict = {}

    async def fresh(label: str) -> tuple:
        key = label.strip().lower()
        if key not in fresh_this_run:
            fresh_this_run[key] = await _geocode_city(label, use_cache=False)
        return fresh_this_run[key]

    fixed = 0
    async for u in db.users.find(
        {"is_demo": {"$ne": True}},
        {"_id": 0, "id": 1, "city": 1, "home_city": 1,
         "city_lat": 1, "city_lng": 1, "home_lat": 1, "home_lng": 1},
    ):
        update = {}
        for label_f, lat_f, lng_f in (
            ("city", "city_lat", "city_lng"),
            ("home_city", "home_lat", "home_lng"),
        ):
            label = (u.get(label_f) or "").strip()
            if not label:
                continue
            g_lat, g_lng = await fresh(label)
            if g_lat is None:
                continue
            s_lat, s_lng = u.get(lat_f), u.get(lng_f)
            if s_lat is None or haversine_km(s_lat, s_lng, g_lat, g_lng) > 100:
                update[lat_f] = g_lat
                update[lng_f] = g_lng
        if update:
            await db.users.update_one({"id": u["id"]}, {"$set": update})
            fixed += 1
            logger.warning("coord repair: user %s → %s", u["id"], update)
    await db.migrations.insert_one({
        "id": "repair_user_coords_v1",
        "at": datetime.now(timezone.utc).isoformat(),
        "fixed": fixed,
    })
    logger.info("Coord-repair migration complete: %d users fixed", fixed)


async def dedupe_codenames() -> int:
    """Reassign fresh unique codenames to accounts sharing one — anonymous
    identities must never be confusable. Demos keep theirs (canonical,
    name-derived); among real users the OLDEST account keeps the name."""
    from core import generate_unique_codename
    fixed = 0
    dups = db.users.aggregate([
        {"$group": {"_id": "$codename", "n": {"$sum": 1}, "ids": {"$push": "$id"}}},
        {"$match": {"n": {"$gt": 1}, "_id": {"$ne": None}}},
    ])
    async for grp in dups:
        holders = []
        async for u in db.users.find(
            {"id": {"$in": grp["ids"]}}, {"_id": 0, "id": 1, "is_demo": 1, "created_at": 1}
        ):
            holders.append(u)
        # demos first (never renamed), then oldest real account keeps the name.
        # created_at is a datetime in old docs and an ISO string in new ones —
        # str() of both sorts chronologically.
        holders.sort(key=lambda u: (not u.get("is_demo"), str(u.get("created_at") or "")))
        for u in holders[1:]:
            if u.get("is_demo"):
                continue
            await db.users.update_one(
                {"id": u["id"]}, {"$set": {"codename": await generate_unique_codename()}}
            )
            fixed += 1
    return fixed


@app.on_event("startup")
async def _welcome_tour_backfill():
    """One-shot: mark every EXISTING account as having seen the welcome tour —
    only accounts created after this ships get the 3-step intro."""
    if await db.migrations.find_one({"id": "welcome_tour_backfill_v1"}):
        return
    r = await db.users.update_many(
        {"welcome_tour_done": {"$exists": False}}, {"$set": {"welcome_tour_done": True}}
    )
    await db.migrations.insert_one({
        "id": "welcome_tour_backfill_v1",
        "at": datetime.now(timezone.utc).isoformat(),
        "marked": r.modified_count,
    })


@app.on_event("startup")
async def _unique_codenames():
    """One-shot: the original codename pool had only 100 combos, so different
    people ended up with identical codenames (two 'Ember Orbit's in prod)."""
    if await db.migrations.find_one({"id": "unique_codenames_v1"}):
        return
    fixed = await dedupe_codenames()
    await db.migrations.insert_one({
        "id": "unique_codenames_v1",
        "at": datetime.now(timezone.utc).isoformat(),
        "fixed": fixed,
    })
    if fixed:
        logger.info("Codename dedupe: reassigned %d duplicate codenames", fixed)


@app.on_event("startup")
async def _move_signatures_off_user_docs():
    """One-shot: community-rules signature PNGs (~100 KB base64 each) used to
    be stored ON the user doc, bloating every /auth/me response to megabytes.
    Move them into db.signatures and unset the field."""
    if await db.migrations.find_one({"id": "move_signatures_v1"}):
        return
    moved = 0
    async for u in db.users.find(
        {"signature_data_url": {"$exists": True}},
        {"_id": 0, "id": 1, "signature_data_url": 1, "agreed_to_rules_at": 1},
    ):
        await db.signatures.update_one(
            {"user_id": u["id"]},
            {"$set": {"data_url": u["signature_data_url"], "at": u.get("agreed_to_rules_at")}},
            upsert=True,
        )
        await db.users.update_one({"id": u["id"]}, {"$unset": {"signature_data_url": ""}})
        moved += 1
    await db.migrations.insert_one({
        "id": "move_signatures_v1",
        "at": datetime.now(timezone.utc).isoformat(),
        "moved": moved,
    })
    if moved:
        logger.info("Signature migration: moved %d signatures off user docs", moved)


@app.on_event("startup")
async def _transcode_webm_intros():
    """One-shot migration (runs in the background so startup stays fast):
    iOS Safari can't play webm, so every real user's stored .webm intro gets
    re-encoded to H.264 mp4 in GCS and their video_url repointed. Idempotent
    across environments — the bucket is shared, so an mp4 rendered by preview
    is simply reused when production runs its own pass; webm originals are
    kept so the other environment's un-migrated URLs never 404."""
    if await db.migrations.find_one({"id": "transcode_webm_videos_v1"}):
        return
    asyncio.create_task(_run_webm_transcode_migration())


async def _run_webm_transcode_migration():
    import re
    import tempfile as _tempfile

    from starlette.concurrency import run_in_threadpool

    from core import _get_gcs_bucket
    from transcode import transcode_to_mp4

    pat = re.compile(r"^https://storage\.googleapis\.com/([^/]+)/(user_videos/[^?]+)\.webm(?:\?.*)?$")
    fixed = failed = 0
    try:
        bucket = _get_gcs_bucket()
    except Exception:
        # No marker written → retries on next startup once GCS is reachable.
        logger.exception("webm transcode migration: GCS unavailable, deferred")
        return
    async for u in db.users.find(
        {"is_demo": {"$ne": True}, "video_url": {"$regex": r"\.webm(\?|$)"}},
        {"_id": 0, "id": 1, "video_url": 1},
    ):
        m = pat.match(u.get("video_url") or "")
        if not m or m.group(1) != bucket.name:
            continue
        stem = m.group(2)
        try:
            def _ensure_mp4() -> bool:
                mp4_blob = bucket.blob(f"{stem}.mp4")
                if mp4_blob.exists():
                    return True
                webm_blob = bucket.blob(f"{stem}.webm")
                if not webm_blob.exists():
                    return False
                with _tempfile.TemporaryDirectory() as td:
                    src, dst = f"{td}/in.webm", f"{td}/out.mp4"
                    webm_blob.download_to_filename(src)
                    transcode_to_mp4(src, dst)
                    mp4_blob.cache_control = "public, max-age=31536000"
                    mp4_blob.upload_from_filename(
                        dst, content_type="video/mp4",
                        predefined_acl="publicRead", timeout=120,
                    )
                return True

            if not await run_in_threadpool(_ensure_mp4):
                failed += 1
                logger.warning("webm→mp4 migration: source blob missing for user %s", u["id"])
                continue
            stamp = int(datetime.now(timezone.utc).timestamp())
            new_url = f"https://storage.googleapis.com/{bucket.name}/{stem}.mp4?v={stamp}"
            await db.users.update_one({"id": u["id"]}, {"$set": {"video_url": new_url}})
            fixed += 1
            logger.info("webm→mp4 migrated: user %s", u["id"])
        except Exception:  # noqa: BLE001
            failed += 1
            logger.exception("webm→mp4 migration failed for user %s", u["id"])
    await db.migrations.insert_one({
        "id": "transcode_webm_videos_v1",
        "at": datetime.now(timezone.utc).isoformat(),
        "fixed": fixed,
        "failed": failed,
    })
    logger.info("webm→mp4 migration complete: %d fixed, %d failed", fixed, failed)


@app.on_event("startup")
async def _flush_geocode_cache():
    """Flush the 'cached forever' city→coords cache on every deploy.
    Production's cache held entries poisoned during the pre-geocoder era
    (e.g. 'marlton…' → Tokyo coords), which re-centered the nearby scan on
    Tokyo forever and even wrote the poison back onto user docs. Photon
    re-populates lazily, so a per-deploy flush is cheap and definitive."""
    try:
        r = await db.city_geo.delete_many({})
        if r.deleted_count:
            logger.info("Flushed %d geocode cache entries", r.deleted_count)
    except Exception:
        logger.exception("geocode cache flush failed (non-fatal)")


@app.on_event("startup")
async def _ensure_user_indexes():
    """Unique indexes stop concurrent sign-ins from creating duplicate
    accounts (find-then-insert race). Partial filters skip docs where the
    field is absent/null."""
    try:
        for field in ("email", "google_sub", "apple_sub"):
            await db.users.create_index(
                field,
                unique=True,
                partialFilterExpression={field: {"$type": "string"}},
                name=f"uniq_{field}",
            )
    except Exception:
        logger.exception("user index creation failed (non-fatal)")


@app.on_event("startup")
async def _retire_legacy_sample_demos():
    """Delete old stock-video demo users (handles luna/kai/rumi/sol/indie/noa
    whose video_url pointed at the deprecated /api/videos/v{n}.mp4 stock files).
    New Sora 2 demos use demo-NN ids + /api/videos/demo_NN.mp4.
    """
    try:
        result = await db.users.delete_many(
            {"is_demo": True, "video_url": {"$regex": r"/v\d+\.mp4$"}},
        )
        if result.deleted_count:
            logger.info("Retired %d legacy stock-video demo users", result.deleted_count)
    except Exception:  # noqa: BLE001
        logger.exception("legacy demo cleanup failed (non-fatal)")


_INACTIVE_CLEANUP_TASK: Optional[asyncio.Task] = None


@app.on_event("startup")
async def _start_inactive_cleanup_scheduler():
    global _INACTIVE_CLEANUP_TASK
    _INACTIVE_CLEANUP_TASK = asyncio.create_task(inactive_cleanup_loop())


@app.on_event("startup")
async def _migrate_strip_city_noise():
    """One-shot retro-cleanup: any user whose stored `city` carries a
    " Township" / " Twp." / " Borough" suffix gets it stripped, so they
    rejoin the same feed bucket as users who picked the clean name. Safe
    to re-run on every startup — Mongo's update_one is idempotent and the
    query only touches matching docs."""
    try:
        query = {
            "$or": [
                {"city": {"$regex": r"\s+(Township|Twp\.?|Borough)(,|$)", "$options": "i"}},
                {"city": {"$regex": r"^(City of|Town of|Borough of|Township of)\s+", "$options": "i"}},
            ]
        }
        cursor = db.users.find(query, {"_id": 0, "id": 1, "city": 1})
        updates = 0
        async for u in cursor:
            old = u.get("city") or ""
            # The `city` is stored as "Place, State, Country" — only the first
            # part (place name) carries the noise, so split, clean, re-join.
            parts = [seg.strip() for seg in old.split(",")]
            if not parts:
                continue
            cleaned_first = _strip_city_noise(parts[0])
            if cleaned_first == parts[0]:
                continue
            new_city = ", ".join([cleaned_first] + parts[1:])
            await db.users.update_one(
                {"id": u["id"]},
                {"$set": {"city": new_city}},
            )
            updates += 1
        if updates:
            logger.info("City-noise migration: cleaned %d user city strings", updates)
    except Exception:  # noqa: BLE001
        logger.exception("City-noise migration failed (non-fatal)")


@app.on_event("startup")
async def _migrate_home_city():
    """Backfill for the home-vs-browsing city split: any user without a
    home_city inherits their current city (and its best-known coordinates).
    Idempotent — only touches docs where home_city doesn't exist yet."""
    try:
        res = await db.users.update_many(
            {"home_city": {"$exists": False}},
            [{"$set": {
                "home_city": "$city",
                "home_lat": {"$ifNull": ["$city_lat", "$lat"]},
                "home_lng": {"$ifNull": ["$city_lng", "$lng"]},
            }}],
        )
        if res.modified_count:
            logger.info("Home-city migration: backfilled %d users", res.modified_count)
    except Exception:  # noqa: BLE001
        logger.exception("Home-city migration failed (non-fatal)")


@app.on_event("shutdown")
async def _stop_inactive_cleanup_scheduler():
    if _INACTIVE_CLEANUP_TASK and not _INACTIVE_CLEANUP_TASK.done():
        _INACTIVE_CLEANUP_TASK.cancel()


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
