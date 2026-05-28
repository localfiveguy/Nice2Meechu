"""Nice2Meechu backend - phone OTP auth, anonymous video feed, AI translation."""
import logging
import os
import random
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from dotenv import load_dotenv
from emergentintegrations.llm.chat import LlmChat, UserMessage
from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field
from starlette.middleware.cors import CORSMiddleware

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]

EMERGENT_LLM_KEY = os.environ.get("EMERGENT_LLM_KEY", "")
TWILIO_ACCOUNT_SID = os.environ.get("TWILIO_ACCOUNT_SID", "")
TWILIO_AUTH_TOKEN = os.environ.get("TWILIO_AUTH_TOKEN", "")
TWILIO_VERIFY_SERVICE_SID = os.environ.get("TWILIO_VERIFY_SERVICE_SID", "")
TWILIO_ENABLED = bool(TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN and TWILIO_VERIFY_SERVICE_SID)

twilio_client = None
if TWILIO_ENABLED:
    try:
        from twilio.rest import Client as TwilioClient

        twilio_client = TwilioClient(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    except Exception:  # noqa: BLE001
        twilio_client = None
        TWILIO_ENABLED = False

# In-memory store for dev OTP codes (only used when Twilio not configured)
DEV_OTP_STORE: dict[str, str] = {}

app = FastAPI()
api = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("nice2meechu")


# ---------------------------------------------------------------------------
# Sample seed data (curated portrait videos + transcripts)
# ---------------------------------------------------------------------------
SAMPLE_VIDEOS = [
    {
        "url": "https://assets.mixkit.co/videos/4787/4787-720.mp4",
        "transcript": "Hey there! I love grabbing oat lattes at the corner cafe. Anyone up for a coffee crawl?",
        "lang": "en",
    },
    {
        "url": "https://assets.mixkit.co/videos/39765/39765-720.mp4",
        "transcript": "Just wrapped a long studio session. Looking for someone to grab late-night ramen with.",
        "lang": "en",
    },
    {
        "url": "https://assets.mixkit.co/videos/51564/51564-720.mp4",
        "transcript": "I run a tiny vinyl shop down the street. If you love jazz, slide into the feed.",
        "lang": "en",
    },
    {
        "url": "https://assets.mixkit.co/videos/4790/4790-720.mp4",
        "transcript": "Hola! New in town. Show me your favourite spots and I will share mine.",
        "lang": "es",
    },
    {
        "url": "https://assets.mixkit.co/videos/52302/52302-720.mp4",
        "transcript": "I bike everywhere. Hidden parks, weird ramen joints, rooftop sunsets. Tag along?",
        "lang": "en",
    },
    {
        "url": "https://assets.mixkit.co/videos/39767/39767-720.mp4",
        "transcript": "Bonjour! Just moved here for art school. Looking for gallery buddies and study cafes.",
        "lang": "fr",
    },
]

VIBES_POOL = ["Coffee", "Vinyl", "Skater", "Foodie", "Bookworm", "Gamer", "Hiker", "Artist", "Runner", "Night Owl"]
CODENAME_ADJ = ["Velvet", "Neon", "Midnight", "Ember", "Cosmic", "Aurora", "Silken", "Vivid", "Hazel", "Indigo"]
CODENAME_NOUN = ["Fox", "Comet", "Drift", "Echo", "Lynx", "Mirage", "Orbit", "Phoenix", "Raven", "Tide"]


def generate_codename() -> str:
    return f"{random.choice(CODENAME_ADJ)} {random.choice(CODENAME_NOUN)}"


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class SendOtpReq(BaseModel):
    phone: str


class VerifyOtpReq(BaseModel):
    phone: str
    code: str


class OnboardingReq(BaseModel):
    handle: str
    vibes: List[str]
    language: str  # e.g. "en", "es"
    avatar_emoji: Optional[str] = "🌙"


class VideoUploadReq(BaseModel):
    sample_index: Optional[int] = None  # if user picks a sample
    video_url: Optional[str] = None  # if recorded/external
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
# Auth helper
# ---------------------------------------------------------------------------
async def current_user(authorization: Optional[str] = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing token")
    token = authorization.split(" ", 1)[1].strip()
    user = await db.users.find_one({"token": token}, {"_id": 0})
    if not user:
        raise HTTPException(401, "Invalid token")
    return user


# ---------------------------------------------------------------------------
# Routes - auth
# ---------------------------------------------------------------------------
@api.get("/")
async def root():
    return {"app": "Nice2Meechu", "twilio_enabled": TWILIO_ENABLED}


@api.post("/auth/send-otp")
async def send_otp(req: SendOtpReq):
    phone = req.phone.strip()
    if not phone.startswith("+") or len(phone) < 8:
        raise HTTPException(400, "Phone must be in E.164 format (e.g. +14155551234)")

    if TWILIO_ENABLED and twilio_client is not None:
        try:
            twilio_client.verify.v2.services(TWILIO_VERIFY_SERVICE_SID).verifications.create(
                to=phone, channel="sms"
            )
            return {"status": "sent", "dev_mode": False}
        except Exception as exc:  # noqa: BLE001
            logger.warning("Twilio send failed: %s -- falling back to DEV mode", exc)

    code = f"{random.randint(0, 999999):06d}"
    DEV_OTP_STORE[phone] = code
    logger.info("DEV OTP for %s -> %s", phone, code)
    return {"status": "sent", "dev_mode": True, "dev_code": code}


@api.post("/auth/verify-otp")
async def verify_otp(req: VerifyOtpReq):
    phone = req.phone.strip()
    code = req.code.strip()

    approved = False
    if TWILIO_ENABLED and twilio_client is not None and phone not in DEV_OTP_STORE:
        try:
            check = twilio_client.verify.v2.services(TWILIO_VERIFY_SERVICE_SID).verification_checks.create(
                to=phone, code=code
            )
            approved = check.status == "approved"
        except Exception as exc:  # noqa: BLE001
            logger.warning("Twilio verify error: %s", exc)
            approved = False
    else:
        approved = DEV_OTP_STORE.get(phone) == code
        if approved:
            DEV_OTP_STORE.pop(phone, None)

    if not approved:
        raise HTTPException(400, "Invalid code")

    user = await db.users.find_one({"phone": phone}, {"_id": 0})
    token = str(uuid.uuid4())
    if user:
        await db.users.update_one({"phone": phone}, {"$set": {"token": token}})
        user["token"] = token
        return {"token": token, "user": user, "onboarded": bool(user.get("handle"))}

    new_user = {
        "id": str(uuid.uuid4()),
        "phone": phone,
        "token": token,
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
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.users.insert_one(new_user.copy())
    new_user.pop("_id", None)
    return {"token": token, "user": new_user, "onboarded": False}


# ---------------------------------------------------------------------------
# Routes - profile / onboarding
# ---------------------------------------------------------------------------
@api.post("/users/onboarding")
async def onboarding(req: OnboardingReq, user=Depends(current_user)):
    update = {
        "handle": req.handle.strip(),
        "vibes": req.vibes[:5],
        "language": req.language,
        "avatar_emoji": req.avatar_emoji or "🌙",
    }
    await db.users.update_one({"id": user["id"]}, {"$set": update})
    user.update(update)
    return {"user": user}


@api.post("/users/location")
async def update_location(req: LocationUpdate, user=Depends(current_user)):
    await db.users.update_one(
        {"id": user["id"]}, {"$set": {"lat": req.lat, "lng": req.lng}}
    )
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
    """Ensure ~6 demo users exist so the feed is never empty."""
    count = await db.users.count_documents({"is_demo": True})
    if count >= len(SAMPLE_VIDEOS):
        return
    await db.users.delete_many({"is_demo": True})
    demo_handles = ["luna", "kai", "rumi", "sol", "indie", "noa"]
    base_lat, base_lng = 40.7128, -74.0060  # NYC default
    for i, sample in enumerate(SAMPLE_VIDEOS):
        await db.users.insert_one(
            {
                "id": f"demo-{i}",
                "is_demo": True,
                "phone": f"+10000000{i:03d}",
                "token": None,
                "handle": demo_handles[i % len(demo_handles)],
                "codename": generate_codename(),
                "vibes": random.sample(VIBES_POOL, 3),
                "language": sample["lang"],
                "avatar_emoji": random.choice(["🌙", "✨", "🔥", "🌊", "🌸", "🪐"]),
                "lat": base_lat + (random.random() - 0.5) * 0.06,
                "lng": base_lng + (random.random() - 0.5) * 0.06,
                "video_url": sample["url"],
                "transcript": sample["transcript"],
                "source_lang": sample["lang"],
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
        )


@api.get("/feed")
async def feed(user=Depends(current_user)):
    await seed_demo_users()
    # exclude self + already-swiped
    swiped = await db.swipes.find({"user_id": user["id"]}, {"_id": 0, "target_user_id": 1}).to_list(2000)
    swiped_ids = {s["target_user_id"] for s in swiped}
    cursor = db.users.find(
        {
            "id": {"$ne": user["id"], "$nin": list(swiped_ids)},
            "video_url": {"$ne": None, "$exists": True},
        },
        {"_id": 0, "phone": 0, "token": 0},
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
    random.shuffle(out)
    return {"feed": out[:20]}


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

    # For demo users, auto-match on like with 70% chance to make app feel alive
    target = await db.users.find_one({"id": req.target_user_id}, {"_id": 0})
    if not target:
        return {"match": False}

    is_demo = target.get("is_demo", False)
    mutual = False
    if is_demo:
        mutual = random.random() < 0.7
    else:
        rev = await db.swipes.find_one(
            {"user_id": req.target_user_id, "target_user_id": user["id"], "action": "like"}
        )
        mutual = bool(rev)

    if not mutual:
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
    out = []
    for row in rows:
        other = [uid for uid in row["user_ids"] if uid != user["id"]][0]
        u = await db.users.find_one({"id": other}, {"_id": 0, "phone": 0, "token": 0})
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
    match = await db.matches.find_one({"id": match_id, "user_ids": user["id"]}, {"_id": 0})
    if not match:
        raise HTTPException(404, "Match not found")
    msgs = await db.messages.find({"match_id": match_id}, {"_id": 0}).sort("at", 1).to_list(500)
    return {"messages": msgs}


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
        "at": datetime.now(timezone.utc).isoformat(),
    }
    await db.messages.insert_one(msg.copy())
    msg.pop("_id", None)

    # Simulate a demo reply
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
                "text": random.choice(replies),
                "at": datetime.now(timezone.utc).isoformat(),
            }
        )
    return {"ok": True}


# ---------------------------------------------------------------------------
# Translation (OpenAI via emergentintegrations)
# ---------------------------------------------------------------------------
LANG_NAMES = {
    "en": "English",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "pt": "Portuguese",
    "it": "Italian",
    "ja": "Japanese",
    "ko": "Korean",
    "zh": "Chinese",
    "hi": "Hindi",
    "ar": "Arabic",
    "ru": "Russian",
}


@api.post("/translate")
async def translate(req: TranslateReq):
    target = LANG_NAMES.get(req.target_lang, req.target_lang)
    src = LANG_NAMES.get(req.source_lang or "", "the source language")
    if not EMERGENT_LLM_KEY:
        raise HTTPException(500, "EMERGENT_LLM_KEY not configured")

    if (req.source_lang or "") == req.target_lang:
        return {"translation": req.text, "target_lang": req.target_lang}

    try:
        chat = LlmChat(
            api_key=EMERGENT_LLM_KEY,
            session_id=f"translate-{uuid.uuid4()}",
            system_message=(
                f"You are a real-time translator. Translate the user's text from {src} to {target}. "
                "Return ONLY the translated text, no quotes, no preface, no explanation."
            ),
        ).with_model("openai", "gpt-4o-mini")
        msg = UserMessage(text=req.text)
        out = await chat.send_message(msg)
        return {"translation": (out or "").strip(), "target_lang": req.target_lang}
    except Exception as exc:  # noqa: BLE001
        logger.exception("translate failed: %s", exc)
        raise HTTPException(500, f"Translation failed: {exc}")


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
