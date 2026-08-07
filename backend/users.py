"""User profile: onboarding, community rules, location/home, GDPR endpoints,
safety (report/block), and intro-video uploads."""
import shutil
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Cookie, Depends, File, Header, HTTPException, Response, UploadFile
from fastapi.concurrency import run_in_threadpool

from auth import current_user
from core import _OG_CACHE, _geocode_city, _get_gcs_bucket, _rng, db, haversine_km, logger
from models import (
    BlockReq,
    CityPositionReq,
    LocationUpdate,
    NearbyRadiusReq,  # legacy, endpoint removed
    OnboardingReq,
    ReportReq,
    RulesAcceptReq,
    VideoUploadReq,
)

router = APIRouter()


@router.post("/users/onboarding")
async def onboarding(req: OnboardingReq, user=Depends(current_user)):
    first_name = req.first_name.strip()[:40]
    if not first_name:
        raise HTTPException(400, "First name is required")
    if not 13 <= req.age <= 120:
        raise HTTPException(400, "Age must be between 13 and 120")

    # Auto-generate a handle from first_name + 3-char suffix if user doesn't already have one
    handle = user.get("handle")
    if not handle:
        suffix = "".join(_rng.choices("abcdefghjkmnpqrstuvwxyz23456789", k=3))
        base = "".join(c for c in first_name.lower() if c.isalnum()) or "user"
        handle = f"{base}.{suffix}"

    update = {
        "handle": handle,
        "first_name": first_name,
        "city": req.city.strip()[:120],
        # Onboarding city is BOTH the browsing city and the home city (where
        # this user's video appears). Later "explore" changes only browsing.
        "home_city": req.city.strip()[:120],
        "age": req.age,
        "vibes": (req.vibes or [])[:5],
        "language": req.language or "en",
        "avatar_emoji": req.avatar_emoji or "🌙",
    }
    # If city coordinates were supplied (Photon pick) AND we don't already have
    # device-geolocation lat/lng, seed lat/lng from the city for distance calcs.
    if req.city_lat is not None and req.city_lng is not None:
        if not user.get("lat") or not user.get("lng"):
            update["lat"] = req.city_lat
            update["lng"] = req.city_lng
        # Always keep the city's canonical coordinates separately
        update["city_lat"] = req.city_lat
        update["city_lng"] = req.city_lng
        update["home_lat"] = req.city_lat
        update["home_lng"] = req.city_lng
    else:
        update["home_lat"] = user.get("lat")
        update["home_lng"] = user.get("lng")
    await db.users.update_one({"id": user["id"]}, {"$set": update})
    user.update(update)
    for h in {user.get("handle"), update["handle"]}:
        if h:
            _OG_CACHE.pop(h.lower(), None)
    return {"user": user}


@router.post("/users/community-rules")
async def accept_rules(req: RulesAcceptReq, user=Depends(current_user)):
    # Require at least 7 items checked (matches the 7 community-rule lines)
    if len(req.accepted_items) < 7:
        raise HTTPException(400, "All community rules must be accepted")
    if not req.signature_data_url or not req.signature_data_url.startswith("data:image/"):
        raise HTTPException(400, "Signature is required")
    now = datetime.now(timezone.utc).isoformat()
    update = {
        "agreed_to_rules_at": now,
        "agreed_rules_items": req.accepted_items,
    }
    # The signature PNG (~100 KB base64) lives in its own collection — storing
    # it on the user doc once bloated every /auth/me response to megabytes.
    await db.signatures.update_one(
        {"user_id": user["id"]},
        {"$set": {"data_url": req.signature_data_url[:200_000], "at": now}},
        upsert=True,
    )
    await db.users.update_one({"id": user["id"]}, {"$set": update})
    user.update(update)
    return {"user": user}


@router.post("/users/location")
async def update_location(req: LocationUpdate, user=Depends(current_user)):
    lat, lng = req.lat, req.lng
    update = {}
    if req.city and req.city.strip():
        city_clean = req.city.strip()[:120]
        # Never store coords that contradict the city label — a stale client
        # (or a poisoned popular-cities entry) once wrote city="Marlton" with
        # Tokyo coordinates. If the supplied coords are >100 km from where the
        # label geocodes to, the label wins.
        g_lat, g_lng = await _geocode_city(city_clean)
        if g_lat is not None and haversine_km(lat, lng, g_lat, g_lng) > 100:
            logger.warning(
                "update_location: coords (%.3f,%.3f) contradict city %r — using geocoded (%.3f,%.3f)",
                lat, lng, city_clean, g_lat, g_lng,
            )
            lat, lng = g_lat, g_lng
        update["city"] = city_clean
        update["city_lat"] = lat
        update["city_lng"] = lng
        if req.set_home:
            # Home city = where this user's video appears in others' feeds.
            update["home_city"] = city_clean
            update["home_lat"] = lat
            update["home_lng"] = lng
    update["lat"] = lat
    update["lng"] = lng
    await db.users.update_one({"id": user["id"]}, {"$set": update})
    return {"ok": True}


@router.post("/users/welcome-tour-done")
async def welcome_tour_done(user=Depends(current_user)):
    await db.users.update_one({"id": user["id"]}, {"$set": {"welcome_tour_done": True}})
    return {"ok": True}


@router.get("/users/me")
async def me(user=Depends(current_user)):
    return {"user": user}


@router.post("/users/me/city-position")
async def save_city_position(req: CityPositionReq, user=Depends(current_user)):
    """Remember the last-watched index per city so the viewer resumes there
    when they switch away and come back. Stored as a sparse dict on the user
    record: city_positions: {"tokyo": 5, "berlin": 2}."""
    city_key = (req.city or "").strip().lower().split(",")[0].strip()
    if not city_key:
        raise HTTPException(400, "city required")
    idx = max(0, int(req.index))
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {f"city_positions.{city_key}": idx}},
    )
    return {"ok": True, "city": city_key, "index": idx}


@router.delete("/users/me")
async def delete_my_account(
    user=Depends(current_user),
    response: Response = None,
    authorization: Optional[str] = Header(None),
    session_token: Optional[str] = Cookie(None),
):
    """GDPR Art. 17 / CCPA right to delete. Wipes the user and all data
    they own (messages, swipes, matches involving them, sessions).
    Demo users protected — cannot self-delete via this endpoint.
    """
    uid = user["id"]
    if user.get("is_demo"):
        raise HTTPException(403, "Demo users cannot be deleted via API")
    await db.messages.delete_many({"$or": [{"from_user_id": uid}, {"to_user_id": uid}]})
    await db.matches.delete_many({"user_ids": uid})
    await db.swipes.delete_many({"$or": [{"user_id": uid}, {"target_user_id": uid}]})
    await db.user_sessions.delete_many({"user_id": uid})
    await db.users.delete_one({"id": uid})
    if response is not None:
        response.delete_cookie("session_token", path="/")
    return {"ok": True, "deleted": uid}


@router.get("/users/me/export")
async def export_my_data(user=Depends(current_user)):
    """GDPR Art. 20 (right to data portability) — return a machine-readable
    JSON dump of everything we hold about the signed-in user.
    Includes: profile, sessions metadata (no tokens leaked), swipes, matches,
    messages they sent OR received, reports they filed, and age-check audits.
    """
    uid = user["id"]

    # Strip server-only fields from the profile copy we hand back.
    profile = {k: v for k, v in user.items() if k not in ("_id",)}

    swipes = await db.swipes.find(
        {"$or": [{"user_id": uid}, {"target_user_id": uid}]}, {"_id": 0}
    ).to_list(10_000)
    matches = await db.matches.find({"user_ids": uid}, {"_id": 0}).to_list(10_000)
    messages = await db.messages.find(
        {"$or": [{"from_user_id": uid}, {"to_user_id": uid}]}, {"_id": 0}
    ).sort("at", 1).to_list(50_000)
    reports = await db.reports.find({"reporter_id": uid}, {"_id": 0}).to_list(1000)
    age_checks = await db.age_checks.find({"user_id": uid}, {"_id": 0}).to_list(100)

    # Sessions: hide token hashes; keep only timestamps so users can see when
    # their account was used.
    sessions = await db.user_sessions.find(
        {"user_id": uid}, {"_id": 0, "session_token": 0}
    ).to_list(100)

    return {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "exported_for_user_id": uid,
        "profile": profile,
        "sessions": sessions,
        "swipes": swipes,
        "matches": matches,
        "messages": messages,
        "reports": reports,
        "age_checks": age_checks,
        "counts": {
            "swipes": len(swipes),
            "matches": len(matches),
            "messages": len(messages),
            "reports": len(reports),
            "age_checks": len(age_checks),
            "sessions": len(sessions),
        },
    }


@router.post("/users/report")
async def report_user(req: ReportReq, user=Depends(current_user)):
    """User safety report — DSA Art. 16 compliant notice-and-action.
    Also blocks the target from appearing in the reporter's feed.
    """
    if req.target_user_id == user["id"]:
        raise HTTPException(400, "Cannot report yourself")
    valid_reasons = {"impersonation", "harassment", "inappropriate", "spam", "underage", "csam", "other"}
    reason = req.reason if req.reason in valid_reasons else "other"
    await db.reports.insert_one({
        "id": str(uuid.uuid4()),
        "reporter_id": user["id"],
        "target_user_id": req.target_user_id,
        "reason": reason,
        "details": (req.details or "")[:1000],
        "match_id": req.match_id,
        "status": "pending",
        "at": datetime.now(timezone.utc).isoformat(),
    })
    # Also record an implicit block so the reporter never sees this user again
    await db.swipes.update_one(
        {"user_id": user["id"], "target_user_id": req.target_user_id},
        {"$set": {"user_id": user["id"], "target_user_id": req.target_user_id, "action": "block", "at": datetime.now(timezone.utc).isoformat()}},
        upsert=True,
    )
    return {"ok": True}


@router.post("/users/block")
async def block_user(req: BlockReq, user=Depends(current_user)):
    if req.target_user_id == user["id"]:
        raise HTTPException(400, "Cannot block yourself")
    await db.swipes.update_one(
        {"user_id": user["id"], "target_user_id": req.target_user_id},
        {"$set": {"user_id": user["id"], "target_user_id": req.target_user_id, "action": "block", "at": datetime.now(timezone.utc).isoformat()}},
        upsert=True,
    )
    # Also unmatch — delete any existing match between the pair so the chat
    # disappears from BOTH sides. Block is the strongest action: target can
    # no longer appear in feed, send messages, or read prior conversation.
    pair = sorted([user["id"], req.target_user_id])
    deleted = await db.matches.delete_many({"user_ids": pair})
    return {"ok": True, "unmatched": deleted.deleted_count}


@router.post("/users/video/upload")
async def upload_video_file(file: UploadFile = File(...), user=Depends(current_user)):
    """Persist a user-recorded intro to Google Cloud Storage and return a stable
    public URL. Replaces the previous local-disk write — local disk in Emergent's
    container is ephemeral, so videos would disappear on redeploy. Files are now
    stored under gs://nicemeechu/user_videos/<uid>.<ext> with a per-object
    publicRead ACL (bucket itself stays unlisted). Overwrites any previous
    recording for the same user."""
    ALLOWED = {"video/webm": "webm", "video/mp4": "mp4"}
    # iOS Safari's MediaRecorder reports codec-suffixed types like
    # "video/mp4;codecs=avc1" — normalize to the base type before lookup.
    ctype = (file.content_type or "").split(";")[0].strip().lower()
    ext = ALLOWED.get(ctype)
    if not ext:
        raise HTTPException(415, f"Unsupported video type: {file.content_type}")

    # 25 MB cap. We stream-read into a SpooledTemporaryFile so we can validate
    # size before talking to GCS — and so a malicious client can't OOM us.
    MAX_BYTES = 25 * 1024 * 1024
    import os as _os
    import tempfile
    spool = tempfile.SpooledTemporaryFile(max_size=4 * 1024 * 1024, mode="w+b")
    total = 0
    upload_src = spool
    tmp_paths: list = []
    try:
        while True:
            chunk = await file.read(1 << 20)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_BYTES:
                spool.close()
                raise HTTPException(413, "Video exceeds 25 MB limit")
            spool.write(chunk)

        if total < 1024:
            raise HTTPException(400, "Empty or corrupt video file")

        spool.seek(0)
        # Every intro goes through a real-file pass: first a silence gate
        # (mic denied/muted recordings are useless — John-from-Erial uploaded
        # a 4s intro with a -91 dB flat audio track), then webm→mp4 transcode.
        from transcode import SILENCE_MAX_DB, measure_max_volume, transcode_to_mp4
        tmp_in = tempfile.NamedTemporaryFile(suffix=f".{ext}", delete=False)
        tmp_paths.append(tmp_in.name)
        shutil.copyfileobj(spool, tmp_in)
        tmp_in.close()

        try:
            max_vol = await run_in_threadpool(measure_max_volume, tmp_in.name)
        except Exception as exc:  # noqa: BLE001
            logger.warning("silence check failed for %s (%s) — allowing upload", user["id"], exc)
            max_vol = None  # fail-open: a broken checker must never block onboarding
        if max_vol is not None and max_vol < SILENCE_MAX_DB:
            raise HTTPException(
                422,
                "We couldn't hear any sound in your video. Check that your microphone "
                "is allowed for this site and record your intro again.",
            )

        if ext == "webm":
            # iOS Safari can't decode webm — re-encode to H.264 mp4 so the
            # intro plays on every device. On transcode failure keep the webm
            # (a Chrome-only video beats a blocked onboarding).
            try:
                tmp_paths.append(tmp_in.name + ".mp4")
                await run_in_threadpool(transcode_to_mp4, tmp_in.name, tmp_in.name + ".mp4")
                upload_src = open(tmp_in.name + ".mp4", "rb")  # noqa: SIM115
                ext, ctype = "mp4", "video/mp4"
            except Exception as exc:  # noqa: BLE001
                logger.warning("webm→mp4 transcode failed for %s (%s) — storing webm", user["id"], exc)
                spool.seek(0)
                upload_src = spool

        bucket = _get_gcs_bucket()
        # If the user previously recorded in a different browser (Safari mp4 ↔
        # Chrome webm), nuke the other extension so we don't serve stale.
        other = bucket.blob(f"user_videos/{user['id']}.{'mp4' if ext == 'webm' else 'webm'}")
        if other.exists():
            try:
                other.delete()
            except Exception:
                pass

        blob = bucket.blob(f"user_videos/{user['id']}.{ext}")
        blob.cache_control = "public, max-age=31536000"
        ct = ctype

        def _upload() -> None:
            blob.upload_from_file(
                upload_src,
                content_type=ct,
                rewind=True,
                predefined_acl="publicRead",
                timeout=120,
            )

        await run_in_threadpool(_upload)
    finally:
        for f in {spool, upload_src}:
            try:
                f.close()
            except Exception:
                pass
        for p in tmp_paths:
            try:
                _os.unlink(p)
            except OSError:
                pass

    # Cache-bust query so the <video> element refetches after re-record.
    video_url = f"{blob.public_url}?v={int(datetime.now(timezone.utc).timestamp())}"
    return {"video_url": video_url, "bytes": total}


@router.post("/users/video")
async def upload_video(req: VideoUploadReq, user=Depends(current_user)):
    video_url = req.video_url or ""
    # Only accept URLs our own upload pipeline produces — GCS objects or the
    # legacy local mount. Blocks crafted values (e.g. demo-video paths that
    # would trip the ghost-demo purge) from ever landing on a real account.
    if video_url and not (
        video_url.startswith("https://storage.googleapis.com/")
        or video_url.startswith("/api/user-videos/")
    ):
        raise HTTPException(400, "Invalid video URL")
    transcript = req.transcript or "Hey, nice to meet you!"
    source_lang = req.source_lang or "en"
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {"video_url": video_url, "transcript": transcript, "source_lang": source_lang}},
    )
    return {"video_url": video_url, "transcript": transcript, "source_lang": source_lang}
