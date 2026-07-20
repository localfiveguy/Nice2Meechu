"""Nice2Meechu backend entrypoint — wires the modular routers together.

Route logic lives in: auth.py, users.py, feed.py, messaging.py, media.py,
demos.py, admin.py. Shared config/helpers live in core.py; request models
in models.py. This file only assembles the app: routers, static mounts,
CORS, and startup/shutdown lifecycle (migrations + background workers).
"""
import asyncio
import os
from pathlib import Path
from typing import Optional

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.middleware.cors import CORSMiddleware

import admin
import auth
import demos
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


for module in (auth, users, feed, messaging, media, demos, admin, push):
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
_SHARE_CARDS_DIR = Path("/app/share_cards")
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
