"""Nice2Meechu backend - Google OAuth (Emergent), anonymous video feed, AI translation."""
import logging
import os
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional

import httpx
from dotenv import load_dotenv
from emergentintegrations.llm.chat import LlmChat, UserMessage
from fastapi import APIRouter, Cookie, Depends, FastAPI, Header, HTTPException, Response
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel
from starlette.middleware.cors import CORSMiddleware

# Cryptographically-secure RNG used for ALL random choices in the app.
# `random` (Mersenne Twister) is predictable and unsuitable even for demo data
# we don't want guessable. `secrets.SystemRandom` is a drop-in with the same
# .sample / .shuffle / .choice / .random API.
_rng = secrets.SystemRandom()

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]

EMERGENT_LLM_KEY = os.environ.get("EMERGENT_LLM_KEY", "")
EMERGENT_AUTH_SESSION_URL = "https://demobackend.emergentagent.com/auth/v1/env/oauth/session-data"
SESSION_TTL = timedelta(days=7)

app = FastAPI()
api = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("nice2meechu")


# ---------------------------------------------------------------------------
# Sample seed data
# ---------------------------------------------------------------------------
SAMPLE_VIDEOS = [
    {"url": "/videos/v1.mp4", "transcript": "Hey there! I love grabbing oat lattes at the corner cafe. Anyone up for a coffee crawl?", "lang": "en"},
    {"url": "/videos/v2.mp4", "transcript": "Just wrapped a long studio session. Looking for someone to grab late-night ramen with.", "lang": "en"},
    {"url": "/videos/v3.mp4", "transcript": "I run a tiny vinyl shop down the street. If you love jazz, slide into the feed.", "lang": "en"},
    {"url": "/videos/v4.mp4", "transcript": "Hola! New in town. Show me your favourite spots and I will share mine.", "lang": "es"},
    {"url": "/videos/v5.mp4", "transcript": "I bike everywhere. Hidden parks, weird ramen joints, rooftop sunsets. Tag along?", "lang": "en"},
    {"url": "/videos/v6.mp4", "transcript": "Bonjour! Just moved here for art school. Looking for gallery buddies and study cafes.", "lang": "fr"},
]

VIBES_POOL = ["Coffee", "Vinyl", "Skater", "Foodie", "Bookworm", "Gamer", "Hiker", "Artist", "Runner", "Night Owl"]
CODENAME_ADJ = ["Velvet", "Neon", "Midnight", "Ember", "Cosmic", "Aurora", "Silken", "Vivid", "Hazel", "Indigo"]
CODENAME_NOUN = ["Fox", "Comet", "Drift", "Echo", "Lynx", "Mirage", "Orbit", "Phoenix", "Raven", "Tide"]


def generate_codename() -> str:
    return f"{_rng.choice(CODENAME_ADJ)} {_rng.choice(CODENAME_NOUN)}"


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class SessionExchangeReq(BaseModel):
    session_id: str
    ref: Optional[str] = None  # referrer's handle, if user landed via /?ref=<handle>


class OnboardingReq(BaseModel):
    # New simplified profile: first name + city + age. Vibes/language stay optional.
    first_name: str
    city: str
    age: int
    vibes: List[str] = []
    language: str = "en"
    avatar_emoji: Optional[str] = "🌙"


class RulesAcceptReq(BaseModel):
    accepted_items: List[str]
    signature_data_url: str  # base64-encoded PNG of the drawn signature


class VideoUploadReq(BaseModel):
    sample_index: Optional[int] = None
    video_url: Optional[str] = None
    transcript: Optional[str] = None
    source_lang: str = "en"


class SwipeReq(BaseModel):
    target_user_id: str
    action: str  # "like" or "pass"


class TranslateReq(BaseModel):
    text: str
    target_lang: str
    source_lang: Optional[str] = None


class MessageReq(BaseModel):
    match_id: str
    text: str


class LocationUpdate(BaseModel):
    lat: float
    lng: float


# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------
def _extract_token(authorization: Optional[str], session_token_cookie: Optional[str]) -> Optional[str]:
    if session_token_cookie:
        return session_token_cookie
    if authorization and authorization.startswith("Bearer "):
        return authorization.split(" ", 1)[1].strip()
    return None


async def _resolve_user_from_token(token: str) -> Optional[dict]:
    sess = await db.user_sessions.find_one({"session_token": token}, {"_id": 0})
    if not sess:
        return None
    expires_at = sess.get("expires_at")
    if isinstance(expires_at, str):
        expires_at = datetime.fromisoformat(expires_at)
    if expires_at and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at and expires_at < datetime.now(timezone.utc):
        return None
    return await db.users.find_one({"id": sess["user_id"]}, {"_id": 0})


async def current_user(
    authorization: Optional[str] = Header(None),
    session_token: Optional[str] = Cookie(None),
):
    token = _extract_token(authorization, session_token)
    if not token:
        raise HTTPException(401, "Not authenticated")
    user = await _resolve_user_from_token(token)
    if not user:
        raise HTTPException(401, "Invalid or expired session")
    return user


# ---------------------------------------------------------------------------
# Routes - meta + Google Auth (Emergent)
# ---------------------------------------------------------------------------
@api.get("/")
async def root():
    return {"app": "Nice2Meechu", "auth": "google-emergent"}


@api.post("/auth/session")
async def auth_session_exchange(req: SessionExchangeReq, response: Response):
    """Exchange a one-time session_id (from URL fragment) for a persistent session_token."""
    async with httpx.AsyncClient(timeout=15) as http:
        try:
            r = await http.get(EMERGENT_AUTH_SESSION_URL, headers={"X-Session-ID": req.session_id})
        except Exception as exc:  # noqa: BLE001
            logger.exception("Emergent auth call failed")
            raise HTTPException(502, f"Auth provider unreachable: {exc}")

    if r.status_code != 200:
        logger.warning("Emergent auth returned %s: %s", r.status_code, r.text)
        raise HTTPException(401, "Invalid session_id")

    data = r.json()
    email = data.get("email")
    name = data.get("name")
    picture = data.get("picture")
    session_token = data.get("session_token")
    if not (email and session_token):
        raise HTTPException(500, "Malformed auth response")

    # Upsert user by email
    existing = await db.users.find_one({"email": email}, {"_id": 0})
    if existing:
        await db.users.update_one(
            {"id": existing["id"]},
            {"$set": {"name": name, "picture": picture}},
        )
        user = await db.users.find_one({"id": existing["id"]}, {"_id": 0})
    else:
        # Resolve optional referrer (by handle). Self-referrals are dropped.
        ref_user_id = None
        ref_handle = (req.ref or "").strip().lower()
        if ref_handle:
            ref_user = await db.users.find_one({"handle": ref_handle}, {"_id": 0, "id": 1})
            if ref_user:
                ref_user_id = ref_user["id"]

        new_user = {
            "id": str(uuid.uuid4()),
            "email": email,
            "name": name,
            "picture": picture,
            "codename": generate_codename(),
            "handle": None,
            "vibes": [],
            "language": "en",
            "avatar_emoji": "🌙",
            "lat": None,
            "lng": None,
            "video_url": None,
            "transcript": None,
            "source_lang": None,
            "referrer_handle": ref_handle or None,
            "referrer_id": ref_user_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        await db.users.insert_one(new_user.copy())
        user = await db.users.find_one({"id": new_user["id"]}, {"_id": 0})

        # Increment a small public stat on the referrer (best-effort)
        if ref_user_id:
            await db.users.update_one(
                {"id": ref_user_id},
                {"$inc": {"referral_count": 1}},
            )

    expires_at = datetime.now(timezone.utc) + SESSION_TTL
    await db.user_sessions.update_one(
        {"session_token": session_token},
        {"$set": {
            "user_id": user["id"],
            "session_token": session_token,
            "expires_at": expires_at,
            "created_at": datetime.now(timezone.utc),
        }},
        upsert=True,
    )

    # Set httpOnly cookie
    response.set_cookie(
        key="session_token",
        value=session_token,
        max_age=int(SESSION_TTL.total_seconds()),
        path="/",
        httponly=True,
        secure=True,
        samesite="none",
    )

    return {"token": session_token, "user": user, "onboarded": bool(user.get("handle"))}


@api.get("/auth/me")
async def auth_me(user=Depends(current_user)):
    return {"user": user, "onboarded": bool(user.get("handle"))}


@api.post("/auth/logout")
async def auth_logout(
    response: Response,
    authorization: Optional[str] = Header(None),
    session_token: Optional[str] = Cookie(None),
):
    token = _extract_token(authorization, session_token)
    if token:
        await db.user_sessions.delete_one({"session_token": token})
    response.delete_cookie("session_token", path="/", samesite="none", secure=True)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Routes - profile / onboarding
# ---------------------------------------------------------------------------
@api.post("/users/onboarding")
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
        "age": req.age,
        "vibes": (req.vibes or [])[:5],
        "language": req.language or "en",
        "avatar_emoji": req.avatar_emoji or "🌙",
    }
    await db.users.update_one({"id": user["id"]}, {"$set": update})
    user.update(update)
    for h in {user.get("handle"), update["handle"]}:
        if h:
            _OG_CACHE.pop(h.lower(), None)
    return {"user": user}


@api.post("/users/community-rules")
async def accept_rules(req: RulesAcceptReq, user=Depends(current_user)):
    # Require at least 7 items checked (matches the 7 community-rule lines)
    if len(req.accepted_items) < 7:
        raise HTTPException(400, "All community rules must be accepted")
    if not req.signature_data_url or not req.signature_data_url.startswith("data:image/"):
        raise HTTPException(400, "Signature is required")
    update = {
        "agreed_to_rules_at": datetime.now(timezone.utc).isoformat(),
        "agreed_rules_items": req.accepted_items,
        "signature_data_url": req.signature_data_url[:200_000],  # safety cap
    }
    await db.users.update_one({"id": user["id"]}, {"$set": update})
    user.update(update)
    return {"user": user}


@api.post("/users/location")
async def update_location(req: LocationUpdate, user=Depends(current_user)):
    await db.users.update_one({"id": user["id"]}, {"$set": {"lat": req.lat, "lng": req.lng}})
    return {"ok": True}


@api.get("/users/me")
async def me(user=Depends(current_user)):
    return {"user": user}


@api.post("/users/video")
async def upload_video(req: VideoUploadReq, user=Depends(current_user)):
    if req.sample_index is not None and 0 <= req.sample_index < len(SAMPLE_VIDEOS):
        sample = SAMPLE_VIDEOS[req.sample_index]
        video_url = sample["url"]
        transcript = sample["transcript"]
        source_lang = sample["lang"]
    else:
        video_url = req.video_url or ""
        transcript = req.transcript or "Hey, nice to meet you!"
        source_lang = req.source_lang or "en"

    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {"video_url": video_url, "transcript": transcript, "source_lang": source_lang}},
    )
    return {"video_url": video_url, "transcript": transcript, "source_lang": source_lang}


# ---------------------------------------------------------------------------
# Routes - feed / matching
# ---------------------------------------------------------------------------
def haversine_km(lat1, lng1, lat2, lng2) -> float:
    from math import asin, cos, radians, sin, sqrt

    if None in (lat1, lng1, lat2, lng2):
        return 999.0
    r = 6371
    dlat = radians(lat2 - lat1)
    dlng = radians(lng2 - lng1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlng / 2) ** 2
    return round(2 * r * asin(sqrt(a)), 1)


async def seed_demo_users():
    count = await db.users.count_documents({"is_demo": True})
    if count >= len(SAMPLE_VIDEOS):
        return
    await db.users.delete_many({"is_demo": True})
    demo_handles = ["luna", "kai", "rumi", "sol", "indie", "noa"]
    base_lat, base_lng = 40.7128, -74.0060
    for i, sample in enumerate(SAMPLE_VIDEOS):
        await db.users.insert_one(
            {
                "id": f"demo-{i}",
                "is_demo": True,
                "email": f"demo{i}@example.com",
                "name": demo_handles[i % len(demo_handles)].title(),
                "picture": None,
                "handle": demo_handles[i % len(demo_handles)],
                "codename": generate_codename(),
                "vibes": _rng.sample(VIBES_POOL, 3),
                "language": sample["lang"],
                "avatar_emoji": _rng.choice(["🌙", "✨", "🔥", "🌊", "🌸", "🪐"]),
                "lat": base_lat + (_rng.random() - 0.5) * 0.06,
                "lng": base_lng + (_rng.random() - 0.5) * 0.06,
                "video_url": sample["url"],
                "transcript": sample["transcript"],
                "source_lang": sample["lang"],
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
        )


@api.get("/feed")
async def feed(user=Depends(current_user)):
    await seed_demo_users()
    swiped = await db.swipes.find({"user_id": user["id"]}, {"_id": 0, "target_user_id": 1}).to_list(2000)
    swiped_ids = {s["target_user_id"] for s in swiped}
    cursor = db.users.find(
        {
            "id": {"$ne": user["id"], "$nin": list(swiped_ids)},
            "video_url": {"$ne": None, "$exists": True},
        },
        {"_id": 0, "email": 0},
    )
    candidates = await cursor.to_list(50)
    out = []
    for c in candidates:
        if not c.get("video_url"):
            continue
        out.append(
            {
                "id": c["id"],
                "codename": c.get("codename", "Anon"),
                "avatar_emoji": c.get("avatar_emoji", "🌙"),
                "vibes": c.get("vibes", []),
                "language": c.get("language", "en"),
                "video_url": c["video_url"],
                "transcript": c.get("transcript", ""),
                "source_lang": c.get("source_lang", "en"),
                "distance_km": haversine_km(user.get("lat"), user.get("lng"), c.get("lat"), c.get("lng")),
            }
        )
    _rng.shuffle(out)
    return {"feed": out[:20]}


def _is_demo_user(target: dict) -> bool:
    return bool(target.get("is_demo"))


async def _check_mutual_match(target: dict, viewer_id: str) -> bool:
    if _is_demo_user(target):
        return _rng.random() < 0.7
    rev = await db.swipes.find_one(
        {"user_id": target["id"], "target_user_id": viewer_id, "action": "like"}
    )
    return bool(rev)


@api.post("/swipe")
async def swipe(req: SwipeReq, user=Depends(current_user)):
    await db.swipes.insert_one(
        {
            "id": str(uuid.uuid4()),
            "user_id": user["id"],
            "target_user_id": req.target_user_id,
            "action": req.action,
            "at": datetime.now(timezone.utc).isoformat(),
        }
    )
    if req.action != "like":
        return {"match": False}

    target = await db.users.find_one({"id": req.target_user_id}, {"_id": 0})
    if not target or not await _check_mutual_match(target, user["id"]):
        return {"match": False}

    match_id = str(uuid.uuid4())
    await db.matches.insert_one(
        {
            "id": match_id,
            "user_ids": sorted([user["id"], req.target_user_id]),
            "at": datetime.now(timezone.utc).isoformat(),
        }
    )
    return {
        "match": True,
        "match_id": match_id,
        "matched_user": {
            "id": target["id"],
            "handle": target.get("handle"),
            "codename": target.get("codename"),
            "avatar_emoji": target.get("avatar_emoji"),
            "vibes": target.get("vibes"),
            "video_url": target.get("video_url"),
            "language": target.get("language"),
        },
    }


@api.get("/matches")
async def matches(user=Depends(current_user)):
    cursor = db.matches.find({"user_ids": user["id"]}, {"_id": 0}).sort("at", -1)
    rows = await cursor.to_list(100)
    if not rows:
        return {"matches": []}

    # Batch-fetch the other-user for every match in a single query (avoids N+1)
    other_ids = [
        next(uid for uid in row["user_ids"] if uid != user["id"])
        for row in rows
    ]
    users_cursor = db.users.find(
        {"id": {"$in": other_ids}}, {"_id": 0, "email": 0}
    )
    users_by_id = {u["id"]: u for u in await users_cursor.to_list(200)}

    out = []
    for row, other in zip(rows, other_ids):
        u = users_by_id.get(other)
        if not u:
            continue
        out.append(
            {
                "match_id": row["id"],
                "user": {
                    "id": u["id"],
                    "handle": u.get("handle"),
                    "codename": u.get("codename"),
                    "avatar_emoji": u.get("avatar_emoji"),
                    "video_url": u.get("video_url"),
                    "language": u.get("language"),
                },
                "at": row["at"],
            }
        )
    return {"matches": out}


# ---------------------------------------------------------------------------
# Messaging
# ---------------------------------------------------------------------------
@api.get("/messages/{match_id}")
async def get_messages(match_id: str, user=Depends(current_user)):
    import asyncio
    from pymongo import UpdateOne

    match = await db.matches.find_one({"id": match_id, "user_ids": user["id"]}, {"_id": 0})
    if not match:
        raise HTTPException(404, "Match not found")
    msgs = await db.messages.find({"match_id": match_id}, {"_id": 0}).sort("at", 1).to_list(500)

    reader_lang = (user.get("language") or "en")

    # First pass — pull cached translations and collect un-cached ones to translate
    needs_translation = []  # list of indices in msgs
    translations_out: dict[int, Optional[str]] = {}
    for i, m in enumerate(msgs):
        source_lang = m.get("source_lang") or "en"
        is_own = m.get("from_user_id") == user["id"]
        if is_own or source_lang == reader_lang:
            translations_out[i] = None
            continue
        cached = (m.get("translations") or {}).get(reader_lang)
        if cached:
            translations_out[i] = cached
        else:
            needs_translation.append(i)

    # Translate all uncached messages in parallel via asyncio.gather
    if needs_translation:
        results = await asyncio.gather(
            *[
                _translate_text(
                    msgs[i]["text"], reader_lang, msgs[i].get("source_lang") or "en"
                )
                for i in needs_translation
            ],
            return_exceptions=True,
        )
        bulk_ops = []
        for i, res in zip(needs_translation, results):
            if isinstance(res, Exception):
                translations_out[i] = None
                continue
            translations_out[i] = res
            bulk_ops.append(
                UpdateOne(
                    {"id": msgs[i]["id"]},
                    {"$set": {f"translations.{reader_lang}": res}},
                )
            )
        # Persist all new translations in one round-trip
        if bulk_ops:
            await db.messages.bulk_write(bulk_ops, ordered=False)

    out = []
    for i, m in enumerate(msgs):
        out.append(
            {
                **m,
                "translated_text": translations_out.get(i),
                "source_lang": m.get("source_lang") or "en",
            }
        )
    return {"messages": out}


@api.post("/messages")
async def send_message(req: MessageReq, user=Depends(current_user)):
    match = await db.matches.find_one({"id": req.match_id, "user_ids": user["id"]}, {"_id": 0})
    if not match:
        raise HTTPException(404, "Match not found")
    msg = {
        "id": str(uuid.uuid4()),
        "match_id": req.match_id,
        "from_user_id": user["id"],
        "text": req.text,
        "source_lang": user.get("language") or "en",
        "translations": {},
        "at": datetime.now(timezone.utc).isoformat(),
    }
    await db.messages.insert_one(msg.copy())
    msg.pop("_id", None)

    other_id = [uid for uid in match["user_ids"] if uid != user["id"]][0]
    other = await db.users.find_one({"id": other_id}, {"_id": 0})
    if other and other.get("is_demo"):
        replies = [
            "haha love that 😄",
            "okay you have great taste",
            "tomorrow then? meet at 6?",
            "tell me more about that",
            "you sound like trouble (good kind)",
        ]
        await db.messages.insert_one(
            {
                "id": str(uuid.uuid4()),
                "match_id": req.match_id,
                "from_user_id": other_id,
                "text": _rng.choice(replies),
                "source_lang": "en",  # reply strings are English regardless of demo user's profile lang
                "translations": {},
                "at": datetime.now(timezone.utc).isoformat(),
            }
        )
    return {"ok": True}


# ---------------------------------------------------------------------------
# Translation
# ---------------------------------------------------------------------------
LANG_NAMES = {
    "en": "English", "es": "Spanish", "fr": "French", "de": "German", "pt": "Portuguese",
    "it": "Italian", "ja": "Japanese", "ko": "Korean", "zh": "Chinese", "hi": "Hindi",
    "ar": "Arabic", "ru": "Russian",
}


async def _translate_text(text: str, target_lang: str, source_lang: Optional[str]) -> str:
    """Translate text via Emergent LLM. Returns original on same-language or LLM failure."""
    if not text:
        return ""
    if (source_lang or "") == target_lang:
        return text
    if not EMERGENT_LLM_KEY:
        return text
    target = LANG_NAMES.get(target_lang, target_lang)
    src = LANG_NAMES.get(source_lang or "", "the source language")
    try:
        chat = LlmChat(
            api_key=EMERGENT_LLM_KEY,
            session_id=f"translate-{uuid.uuid4()}",
            system_message=(
                f"You are a real-time translator. Translate the user's text from {src} to {target}. "
                "Return ONLY the translated text, no quotes, no preface, no explanation."
            ),
        ).with_model("openai", "gpt-4o-mini")
        out = await chat.send_message(UserMessage(text=text))
        return (out or text).strip()
    except Exception as exc:  # noqa: BLE001
        logger.exception("translate failed: %s", exc)
        return text


@api.post("/translate")
async def translate(req: TranslateReq):
    if not EMERGENT_LLM_KEY:
        raise HTTPException(500, "EMERGENT_LLM_KEY not configured")
    out = await _translate_text(req.text, req.target_lang, req.source_lang)
    return {"translation": out, "target_lang": req.target_lang}


@api.get("/samples")
async def list_samples():
    return {
        "samples": [
            {"index": i, "url": s["url"], "transcript": s["transcript"], "lang": s["lang"]}
            for i, s in enumerate(SAMPLE_VIDEOS)
        ],
        "vibes": VIBES_POOL,
        "languages": [{"code": k, "name": v} for k, v in LANG_NAMES.items()],
    }


# ---------------------------------------------------------------------------
# OG share-card image generation
# ---------------------------------------------------------------------------
from fastapi.responses import StreamingResponse  # noqa: E402
import io  # noqa: E402

_FONT_BOLD_PATH = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
_FONT_REG_PATH = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"
_OG_CACHE: dict[str, bytes] = {}


def _safe_font(path: str, size: int):
    """Return ImageFont.truetype(path, size), or PIL default if path unavailable."""
    from PIL import ImageFont
    try:
        return ImageFont.truetype(path, size)
    except (OSError, IOError):  # noqa: UP024
        return ImageFont.load_default()


def _render_share_card(codename: str, emoji: str, handle: str | None) -> bytes:
    """Render a 1200x630 share card PNG with codename + emoji + tagline."""
    from PIL import Image, ImageDraw, ImageFont  # local import keeps cold-start fast
    from pilmoji import Pilmoji

    W, H = 1200, 630
    img = Image.new("RGB", (W, H), "#050507")
    draw = ImageDraw.Draw(img)

    # Subtle accent — a red→cyan gradient strip on the right edge
    for x in range(W - 14, W):
        t = (x - (W - 14)) / 14
        r = int(255 * (1 - t) + 0 * t)
        g = int(77 * (1 - t) + 229 * t)
        b = int(77 * (1 - t) + 255 * t)
        draw.line([(x, 0), (x, H)], fill=(r, g, b))

    # Subtle radial-ish bloom (two soft circles)
    bloom = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bloom)
    bd.ellipse([-260, -260, 540, 540], fill=(255, 77, 77, 40))
    bd.ellipse([W - 540, H - 540, W + 260, H + 260], fill=(0, 229, 255, 30))
    img = Image.alpha_composite(img.convert("RGBA"), bloom).convert("RGB")
    draw = ImageDraw.Draw(img)

    # Small brand mark top-left
    brand_font = _safe_font(_FONT_BOLD_PATH, 30)
    draw.text((64, 56), "NICE2MEECHU", fill="#FFFFFF", font=brand_font)
    draw.text((64 + 290, 56), ".", fill="#FF4D4D", font=brand_font)

    # Big "joins you on" prefix
    pref_font = _safe_font(_FONT_REG_PATH, 36)
    draw.text((64, 200), "Nice2Meechu invite from", fill="#FFFFFF80", font=pref_font)

    # Codename — large bold
    name_font = _safe_font(_FONT_BOLD_PATH, 110)
    safe_name = (codename or "Anon").strip()[:24]
    draw.text((64, 256), safe_name, fill="#FFFFFF", font=name_font)

    # Emoji rendered via pilmoji (uses Twitter color emoji)
    if emoji:
        with Pilmoji(img) as p:
            emoji_font = _safe_font(_FONT_BOLD_PATH, 96)
            try:
                p.text((64, 384), emoji[:2], font=emoji_font)
            except Exception:  # noqa: BLE001
                pass
        draw = ImageDraw.Draw(img)

    # Tagline at the bottom
    tag_font = _safe_font(_FONT_REG_PATH, 32)
    tag = "video-first  ·  hyperlocal  ·  anonymous until the spark"
    draw.text((64, H - 120), tag, fill="#FFFFFFB0", font=tag_font)

    # Handle pill, bottom-right
    if handle:
        h_text = f"@{handle}"
        hf = _safe_font(_FONT_BOLD_PATH, 28)
        bbox = draw.textbbox((0, 0), h_text, font=hf)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        px, py = W - tw - 96, H - 96
        pad = 16
        draw.rounded_rectangle(
            [px - pad, py - pad, px + tw + pad, py + th + pad + 4],
            radius=24, fill="#FF4D4D",
        )
        draw.text((px, py - 4), h_text, fill="#FFFFFF", font=hf)

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


@api.get("/og/{handle}")
async def og_card(handle: str):
    """Return a 1200x630 PNG share card for the given user handle."""
    handle = handle.lower().strip()
    if handle in _OG_CACHE:
        return StreamingResponse(io.BytesIO(_OG_CACHE[handle]), media_type="image/png")

    user = await db.users.find_one({"handle": handle}, {"_id": 0})
    if not user:
        # generic card so the link still unfurls nicely
        png = _render_share_card("Nice2Meechu", "✨", None)
    else:
        png = _render_share_card(
            codename=user.get("codename") or "Anon",
            emoji=user.get("avatar_emoji") or "✨",
            handle=user.get("handle"),
        )
    _OG_CACHE[handle] = png
    return StreamingResponse(io.BytesIO(png), media_type="image/png")


# ---------------------------------------------------------------------------
# App wiring
# ---------------------------------------------------------------------------
app.include_router(api)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
