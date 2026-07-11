"""AI-generated demo users (Sora 2 talking-head videos) — seeded from
/app/backend/videos/demo_meta.json which the generator script produces.
Demos are distributed across the top-12 metro cities; count per city
equals (13 - rank), so #1 city gets 12 demos, #12 gets 1. Total = 78."""
import json as _json
from datetime import datetime, timezone

from fastapi import APIRouter

from core import LANG_NAMES, ROOT_DIR, VIBES_POOL, _rng, db

router = APIRouter()


def _load_demo_personas():
    meta = ROOT_DIR / "videos" / "demo_meta.json"
    if not meta.exists():
        return []
    try:
        personas = _json.loads(meta.read_text())
    except Exception:
        return []
    out = []
    for p in personas:
        vf = ROOT_DIR / "videos" / p.get("file", "")
        # Only seed personas whose video has finished rendering on disk.
        if vf.exists() and vf.stat().st_size > 50_000:
            out.append(p)
    return out


def _demo_handle_for(p: dict) -> str:
    """Generate a stable, human-readable handle for a demo persona that matches
    what their Sora 2 audio actually says. We pair the spoken first name with
    a short city slug for uniqueness across the catalogue, e.g.
    `sarah.newyork`, `yui.tokyo`, `lucas.saopaulo`. Falls back to the persona
    idx if a name is missing.
    """
    name = (p.get("name") or "").strip().lower()
    city = (p.get("city") or "").strip().lower()
    # City slug: collapse to alphanumerics so "São Paulo" → "saopaulo",
    # "New York" → "newyork", non-ASCII letters get stripped (Photon labels
    # are city-name only at this point so this is safe).
    city_slug = "".join(c for c in city if c.isalnum())
    if not name:
        return f"demo{p.get('idx', 0):02d}"
    return f"{name}.{city_slug}" if city_slug else name


def _demo_codename_for(p: dict) -> str:
    """Public-facing codename for a demo user. Uses the spoken first name so
    the badge on the feed card matches what viewers actually hear in the
    AI-generated audio (e.g. "Sarah" — same name the video says). For real
    users we still generate the anonymous Adj+Noun codename via
    `generate_codename()`; demos are explicitly labelled "✨ AI demo" in the
    UI so showing the name doesn't violate the anonymity promise.
    """
    name = (p.get("name") or "").strip()
    return name or f"Demo {p.get('idx', 0):02d}"


async def seed_demo_users():
    personas = _load_demo_personas()
    if not personas:
        return
    desired_ids = {f"demo-{p['idx']:02d}" for p in personas}
    existing = {
        u["id"]
        async for u in db.users.find({"is_demo": True}, {"_id": 0, "id": 1})
    }
    # Remove demos that no longer have a corresponding video on disk
    stale = existing - desired_ids
    if stale:
        await db.users.delete_many({"id": {"$in": list(stale)}})

    # Align ALL existing demos' codename + handle to the name-from-audio
    # scheme — older seeds used random "Velvet Fox"-style codenames and a
    # random handle pool which created the audio-vs-badge mismatch
    # ("Hi! My name is Sarah!" + codename "Neon Comet"). One $set per persona
    # is cheap (max 78 rows) and idempotent so re-runs are no-ops.
    for p in personas:
        uid = f"demo-{p['idx']:02d}"
        if uid not in existing:
            continue
        await db.users.update_one(
            {"id": uid},
            {"$set": {
                "codename": _demo_codename_for(p),
                "handle": _demo_handle_for(p),
                "first_name": p.get("name") or None,
                "transcript": p.get("transcript", ""),
            }},
        )

    missing = desired_ids - existing
    if not missing:
        return
    for p in personas:
        uid = f"demo-{p['idx']:02d}"
        if uid not in missing:
            continue
        first_name = p.get("name") or f"Demo {p['idx']:02d}"
        await db.users.insert_one(
            {
                "id": uid,
                "is_demo": True,
                "email": f"{uid}@nice2meechu.local",
                "google_sub": uid,
                "name": first_name,
                "picture": None,
                "first_name": first_name,
                "handle": _demo_handle_for(p),
                "codename": _demo_codename_for(p),
                "city": p["city"],
                "home_city": p["city"],
                "home_lat": p["lat"],
                "home_lng": p["lng"],
                "city_lat": p["lat"],
                "city_lng": p["lng"],
                "age": p.get("age", 26),
                "vibes": _rng.sample(VIBES_POOL, 3),
                "language": p.get("lang", "en"),
                "avatar_emoji": p.get("avatar_emoji", "🌙"),
                "lat": p["lat"] + (_rng.random() - 0.5) * 0.05,
                "lng": p["lng"] + (_rng.random() - 0.5) * 0.05,
                "video_url": f"/api/videos/{p['file']}",
                "transcript": p.get("transcript", ""),
                "source_lang": p.get("lang", "en"),
                "onboarding_phase": "done",
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
        )


def _is_demo_user(target: dict) -> bool:
    return bool(target.get("is_demo"))


@router.get("/demos/sample")
async def demos_sample(limit: int = 12):
    """PUBLIC endpoint (no auth) that returns a randomized subset of AI demo
    users so the sign-in landing page can show example intro videos to
    pre-signup visitors — they can watch what a "good" intro looks like
    before committing to recording their own. Caller passes `limit` (default
    12, capped at 30 to keep payload small). Only safe, public-facing fields
    are returned: id, codename, city, video_url, source_lang, language. We
    deliberately do NOT include emails, geolocation precision, or anything
    PII-adjacent."""
    limit = max(1, min(limit, 30))
    # Pull a small random sample. Mongo's $sample is single-pass and won't
    # scan the whole collection, but to keep it deterministic-ish for the
    # short widget cycle we shuffle the result client-side too.
    pipeline = [
        {"$match": {"is_demo": True, "video_url": {"$exists": True, "$ne": None}}},
        {"$sample": {"size": limit}},
        {"$project": {
            "_id": 0,
            "id": 1,
            "codename": 1,
            "city": 1,
            "video_url": 1,
            "source_lang": 1,
            "language": 1,
        }},
    ]
    demos = await db.users.aggregate(pipeline).to_list(limit)
    return {"demos": demos}


@router.get("/samples")
async def list_samples():
    return {
        "vibes": VIBES_POOL,
        "languages": [{"code": k, "name": v} for k, v in LANG_NAMES.items()],
    }
