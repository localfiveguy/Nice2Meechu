"""Nice2Meechu backend - Google OAuth (Emergent), anonymous video feed, AI translation."""
import logging
import os
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional

import httpx
from dotenv import load_dotenv
from emergentintegrations.llm.chat import ImageContent, LlmChat, UserMessage
from fastapi import APIRouter, Cookie, Depends, FastAPI, File, Header, HTTPException, Response, UploadFile
from fastapi.staticfiles import StaticFiles
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token
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
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
ADMIN_EMAILS = {e.strip().lower() for e in os.environ.get("ADMIN_EMAILS", "").split(",") if e.strip()}
SESSION_TTL = timedelta(days=7)

app = FastAPI()
api = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("nice2meechu")


# ---------------------------------------------------------------------------
# Seed data
# ---------------------------------------------------------------------------
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


class GoogleIdTokenReq(BaseModel):
    """Direct Google OAuth (GIS) — frontend posts the credential JWT here."""
    credential: str  # Google-issued ID token (JWT)
    ref: Optional[str] = None


class OnboardingReq(BaseModel):
    # New simplified profile: first name + city + age. Vibes/language stay optional.
    first_name: str
    city: str
    age: int
    # Optional city coordinates (from Photon autocomplete) so we can power
    # hyperlocal distance immediately, without waiting for browser geolocation.
    city_lat: Optional[float] = None
    city_lng: Optional[float] = None
    vibes: List[str] = []
    language: str = "en"
    avatar_emoji: Optional[str] = "🌙"


class RulesAcceptReq(BaseModel):
    accepted_items: List[str]
    signature_data_url: str  # base64-encoded PNG of the drawn signature


class VideoUploadReq(BaseModel):
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


class FaceCheckReq(BaseModel):
    image_base64: str  # raw base64 (no data: prefix) of a single frame from the video


class MessageReq(BaseModel):
    match_id: str
    text: str


class LocationUpdate(BaseModel):
    lat: float
    lng: float
    city: Optional[str] = None


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
    return {"app": "Nice2Meechu", "auth": "google-direct" if GOOGLE_CLIENT_ID else "google-emergent"}


# REMINDER: DO NOT HARDCODE THE URL, OR ADD ANY FALLBACKS OR REDIRECT URLS, THIS BREAKS THE AUTH
async def _finalize_google_signin(
    response: Response,
    *,
    google_sub: Optional[str],
    email: str,
    name: Optional[str],
    picture: Optional[str],
    ref: Optional[str],
    session_token: Optional[str] = None,
) -> dict:
    """Create-or-update the user from Google profile info, mint a session_token,
    set the httpOnly cookie, and return the standard auth response payload.
    Used by both the new direct-GIS endpoint and the legacy Emergent exchange."""
    # Upsert user by email
    existing = await db.users.find_one({"email": email}, {"_id": 0})
    if existing:
        update_fields = {"name": name, "picture": picture}
        if google_sub and not existing.get("google_sub"):
            update_fields["google_sub"] = google_sub
        await db.users.update_one({"id": existing["id"]}, {"$set": update_fields})
        user = await db.users.find_one({"id": existing["id"]}, {"_id": 0})
    else:
        # Resolve optional referrer (by handle). Self-referrals are dropped.
        ref_user_id = None
        ref_handle = (ref or "").strip().lower()
        if ref_handle:
            ref_user = await db.users.find_one({"handle": ref_handle}, {"_id": 0, "id": 1})
            if ref_user:
                ref_user_id = ref_user["id"]

        new_user = {
            "id": str(uuid.uuid4()),
            "email": email,
            "name": name,
            "picture": picture,
            "google_sub": google_sub,
            "codename": generate_codename(),
            "handle": None,
            "first_name": (name or "").strip().split(" ")[0] if name else None,
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

        if ref_user_id:
            await db.users.update_one(
                {"id": ref_user_id},
                {"$inc": {"referral_count": 1}},
            )

    # Mint our own session_token (don't trust Google's lifetime)
    token = session_token or secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + SESSION_TTL
    await db.user_sessions.update_one(
        {"session_token": token},
        {"$set": {
            "user_id": user["id"],
            "session_token": token,
            "expires_at": expires_at,
            "created_at": datetime.now(timezone.utc),
        }},
        upsert=True,
    )

    response.set_cookie(
        key="session_token",
        value=token,
        max_age=int(SESSION_TTL.total_seconds()),
        path="/",
        httponly=True,
        secure=True,
        samesite="none",
    )

    return {"token": token, "user": user, "onboarded": bool(user.get("handle"))}


# REMINDER: DO NOT HARDCODE THE URL, OR ADD ANY FALLBACKS OR REDIRECT URLS, THIS BREAKS THE AUTH
@api.post("/auth/google")
async def auth_google_id_token(req: GoogleIdTokenReq, response: Response):
    """Direct Google OAuth — verify Google-issued ID token (JWT) and sign user in.
    Frontend uses Google Identity Services (GIS) which returns a `credential` JWT
    in the popup callback; that JWT is forwarded here for cryptographic verification."""
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(500, "GOOGLE_CLIENT_ID not configured")

    try:
        # Verifies signature, expiry, audience (aud == our client_id) and issuer.
        idinfo = google_id_token.verify_oauth2_token(
            req.credential, google_requests.Request(), GOOGLE_CLIENT_ID, clock_skew_in_seconds=10
        )
    except ValueError as exc:
        logger.warning("Google ID token verification failed: %s", exc)
        raise HTTPException(401, "Invalid Google credential")

    email = idinfo.get("email")
    if not email or not idinfo.get("email_verified", False):
        raise HTTPException(401, "Google account email not verified")

    return await _finalize_google_signin(
        response,
        google_sub=idinfo.get("sub"),
        email=email,
        name=idinfo.get("name"),
        picture=idinfo.get("picture"),
        ref=req.ref,
    )


@api.post("/auth/session")
async def auth_session_exchange(req: SessionExchangeReq, response: Response):
    """Legacy: Exchange a one-time Emergent session_id for a persistent session_token.
    Kept temporarily for backwards compat — new sign-ins use POST /api/auth/google."""
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
    session_token = data.get("session_token")
    if not (email and session_token):
        raise HTTPException(500, "Malformed auth response")

    return await _finalize_google_signin(
        response,
        google_sub=None,
        email=email,
        name=data.get("name"),
        picture=data.get("picture"),
        ref=req.ref,
        session_token=session_token,
    )


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
    # If city coordinates were supplied (Photon pick) AND we don't already have
    # device-geolocation lat/lng, seed lat/lng from the city for distance calcs.
    if req.city_lat is not None and req.city_lng is not None:
        if not user.get("lat") or not user.get("lng"):
            update["lat"] = req.city_lat
            update["lng"] = req.city_lng
        # Always keep the city's canonical coordinates separately
        update["city_lat"] = req.city_lat
        update["city_lng"] = req.city_lng
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
    update = {"lat": req.lat, "lng": req.lng}
    if req.city and req.city.strip():
        update["city"] = req.city.strip()[:120]
        update["city_lat"] = req.lat
        update["city_lng"] = req.lng
    await db.users.update_one({"id": user["id"]}, {"$set": update})
    return {"ok": True}


# ---------------------------------------------------------------------------
# Popular cities (curated baseline merged with live signup counts)
# ---------------------------------------------------------------------------
CURATED_CITIES = [
    {"city": "New York",  "country": "USA",       "country_code": "us", "flag": "🇺🇸", "lat": 40.7128,  "lng": -74.0060},
    {"city": "Los Angeles","country": "USA",       "country_code": "us", "flag": "🇺🇸", "lat": 34.0522,  "lng": -118.2437},
    {"city": "London",    "country": "UK",        "country_code": "gb", "flag": "🇬🇧", "lat": 51.5074,  "lng": -0.1278},
    {"city": "Tokyo",     "country": "Japan",     "country_code": "jp", "flag": "🇯🇵", "lat": 35.6762,  "lng": 139.6503},
    {"city": "Paris",     "country": "France",    "country_code": "fr", "flag": "🇫🇷", "lat": 48.8566,  "lng": 2.3522},
    {"city": "Berlin",    "country": "Germany",   "country_code": "de", "flag": "🇩🇪", "lat": 52.5200,  "lng": 13.4050},
    {"city": "Madrid",    "country": "Spain",     "country_code": "es", "flag": "🇪🇸", "lat": 40.4168,  "lng": -3.7038},
    {"city": "Sydney",    "country": "Australia", "country_code": "au", "flag": "🇦🇺", "lat": -33.8688, "lng": 151.2093},
    {"city": "Mumbai",    "country": "India",     "country_code": "in", "flag": "🇮🇳", "lat": 19.0760,  "lng": 72.8777},
    {"city": "Lagos",     "country": "Nigeria",   "country_code": "ng", "flag": "🇳🇬", "lat": 6.5244,   "lng": 3.3792},
    {"city": "São Paulo", "country": "Brazil",    "country_code": "br", "flag": "🇧🇷", "lat": -23.5505, "lng": -46.6333},
    {"city": "Toronto",   "country": "Canada",    "country_code": "ca", "flag": "🇨🇦", "lat": 43.6532,  "lng": -79.3832},
]


@api.get("/cities/popular")
async def cities_popular(user=Depends(current_user)):
    """Returns curated top-12 cities merged with real signup counts.
    `people` is the number of users in that city the CURRENT viewer hasn't
    yet swiped on (so it decreases as they watch). Real cities not in the
    curated list are appended (require city_lat/city_lng)."""
    # Exclude users the viewer has already swiped on so the count is "remaining".
    swiped = await db.swipes.find({"user_id": user["id"]}, {"_id": 0, "target_user_id": 1}).to_list(5000)
    swiped_ids = [s["target_user_id"] for s in swiped]
    pipeline = [
        {"$match": {
            "city": {"$nin": [None, ""]},
            "video_url": {"$ne": None, "$exists": True},
            "id": {"$ne": user["id"], "$nin": swiped_ids},
        }},
        {"$group": {
            "_id": {"$toLower": "$city"},
            "raw_city": {"$first": "$city"},
            "count": {"$sum": 1},
            "lat": {"$first": "$city_lat"},
            "lng": {"$first": "$city_lng"},
        }},
    ]
    rows = await db.users.aggregate(pipeline).to_list(500)

    out = []
    matched_keys = set()
    for c in CURATED_CITIES:
        needle = c["city"].lower()
        people = 0
        for r in rows:
            key = r["_id"]
            if needle in key:
                people += int(r["count"])
                matched_keys.add(key)
        out.append({**c, "people": people})

    # Append real-only cities that weren't matched to a curated entry AND have coords.
    for r in rows:
        key = r["_id"]
        if key in matched_keys:
            continue
        if r.get("lat") is None or r.get("lng") is None:
            continue
        parts = [p.strip() for p in (r.get("raw_city") or "").split(",")]
        city = parts[0] or "Unknown"
        country = parts[-1] if len(parts) > 1 else ""
        out.append({
            "city": city, "country": country, "country_code": "", "flag": "🌍",
            "lat": float(r["lat"]), "lng": float(r["lng"]), "people": int(r["count"]),
        })

    out.sort(key=lambda x: (-x["people"], x["city"]))
    return {"cities": out[:20]}


@api.get("/users/me")
async def me(user=Depends(current_user)):
    return {"user": user}


@api.delete("/users/me")
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


@api.get("/users/me/export")
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


class ReportReq(BaseModel):
    target_user_id: str
    reason: str
    details: Optional[str] = None
    match_id: Optional[str] = None


def _require_admin(user):
    """Reject the request unless the caller's email is in ADMIN_EMAILS env."""
    if not ADMIN_EMAILS:
        raise HTTPException(403, "Admin not configured")
    if (user.get("email") or "").lower() not in ADMIN_EMAILS:
        raise HTTPException(403, "Forbidden")


@api.get("/admin/funnel")
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
        "video_url": {"$regex": r"^/api/user-videos/"},  # only real recordings, not demo URLs
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


@api.post("/users/report")
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


class BlockReq(BaseModel):
    target_user_id: str


@api.post("/users/block")
async def block_user(req: BlockReq, user=Depends(current_user)):
    if req.target_user_id == user["id"]:
        raise HTTPException(400, "Cannot block yourself")
    await db.swipes.update_one(
        {"user_id": user["id"], "target_user_id": req.target_user_id},
        {"$set": {"user_id": user["id"], "target_user_id": req.target_user_id, "action": "block", "at": datetime.now(timezone.utc).isoformat()}},
        upsert=True,
    )
    return {"ok": True}

@api.post("/users/video/upload")
async def upload_video_file(file: UploadFile = File(...), user=Depends(current_user)):
    """Persist a user-recorded intro to disk and return a stable public URL.
    Replaces the previous flow which stored `URL.createObjectURL(blob)` —
    those blob URLs dropped the moment the tab closed, so returning users
    effectively had no profile video. Now the file is written under
    /app/backend/user_videos/<uid>.<ext> and served via /api/user-videos/<uid>.<ext>.
    Overwrites any previous recording for the same user."""
    # Accept WebM (MediaRecorder default on Chromium) and MP4 (Safari).
    ALLOWED = {"video/webm": "webm", "video/mp4": "mp4"}
    ext = ALLOWED.get((file.content_type or "").lower())
    if not ext:
        raise HTTPException(415, f"Unsupported video type: {file.content_type}")

    # 25 MB cap — well above what 15s of 720p VP9/H264 should produce, but
    # protects the disk from runaway uploads. We stream-read in chunks so a
    # malicious client can't OOM us before we trip the limit.
    MAX_BYTES = 25 * 1024 * 1024
    target = _USER_VIDEOS_DIR / f"{user['id']}.{ext}"

    # Clean up the other-extension file if the user previously recorded in a
    # different browser (e.g. Safari MP4 then Chrome WebM) so we don't serve stale.
    other_ext = "mp4" if ext == "webm" else "webm"
    other = _USER_VIDEOS_DIR / f"{user['id']}.{other_ext}"
    if other.exists():
        try:
            other.unlink()
        except OSError:
            pass

    total = 0
    with target.open("wb") as out:
        while True:
            chunk = await file.read(1 << 20)  # 1 MB
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_BYTES:
                out.close()
                try:
                    target.unlink()
                except OSError:
                    pass
                raise HTTPException(413, "Video exceeds 25 MB limit")
            out.write(chunk)

    if total < 1024:  # < 1 KB → empty/corrupt
        try:
            target.unlink()
        except OSError:
            pass
        raise HTTPException(400, "Empty or corrupt video file")

    # Cache-bust the URL so the <video> element refetches after re-recording.
    video_url = f"/api/user-videos/{user['id']}.{ext}?v={int(datetime.now(timezone.utc).timestamp())}"
    return {"video_url": video_url, "bytes": total}




@api.post("/users/video")
async def upload_video(req: VideoUploadReq, user=Depends(current_user)):
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


# ---------------------------------------------------------------------------
# AI-generated demo users (Sora 2 talking-head videos) — seeded from
# /app/backend/videos/demo_meta.json which the generator script produces.
# Demos are distributed across the top-12 metro cities; count per city
# equals (13 - rank), so #1 city gets 12 demos, #12 gets 1. Total = 78.
# ---------------------------------------------------------------------------
import json as _json  # noqa: E402


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


_DEMO_HANDLE_POOL = [
    "luna","kai","rumi","sol","indie","noa","milo","saga","ezra","nova",
    "rio","jules","kira","arlo","kit","mika","theo","skye","lior","wren",
    "wynn","aki","yuna","ben","tova","emi","kell","fia","aram","oren",
    "lev","quinn","sage","yara","reese","jad","navi","tessa","caz","leda",
    "shay","aya","ozzy","poppy","faye","cyrus","mara","ren","ida","oslo",
    "esme","lia","amir","june","aksel","viv","callie","beau","tane","viola",
    "lyle","onyx","sora","azul","palmer","gigi","jovi","cici","mae","oren2",
    "blake","mae2","willa","fern","azure","klee","veda","yael",
]


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
    missing = desired_ids - existing
    if not missing:
        return
    for p in personas:
        uid = f"demo-{p['idx']:02d}"
        if uid not in missing:
            continue
        handle = _DEMO_HANDLE_POOL[p["idx"] % len(_DEMO_HANDLE_POOL)]
        first_name = p.get("name") or handle.title()
        await db.users.insert_one(
            {
                "id": uid,
                "is_demo": True,
                "email": f"{uid}@nice2meechu.local",
                "google_sub": uid,
                "name": first_name,
                "picture": None,
                "first_name": first_name,
                "handle": handle,
                "codename": generate_codename(),
                "city": p["city"],
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


@api.get("/feed")
async def feed(user=Depends(current_user)):
    await seed_demo_users()
    swiped = await db.swipes.find({"user_id": user["id"]}, {"_id": 0, "target_user_id": 1}).to_list(2000)
    swiped_ids = {s["target_user_id"] for s in swiped}
    viewer_city_full = (user.get("city") or "").strip()
    viewer_city = viewer_city_full.split(",")[0].strip().lower()

    # STRICT hyperlocal: if the viewer has set a city, ONLY surface demos in
    # that exact city. If there are none, return an empty feed and let the
    # frontend prompt the user to change location. No silent fallback — the
    # whole point of "near you" is to be honest about it.
    base_filter = {
        "id": {"$ne": user["id"], "$nin": list(swiped_ids)},
        "video_url": {"$ne": None, "$exists": True},
    }
    candidates: list = []
    if viewer_city:
        city_filter = {
            **base_filter,
            "city": {"$regex": f"^{re.escape(viewer_city)}", "$options": "i"},
        }
        async for u in db.users.find(city_filter, {"_id": 0, "email": 0}).limit(60):
            candidates.append(u)
    else:
        # No city set yet → fall back to nearest by distance so a brand-new
        # user without a city still sees content.
        async for u in db.users.find(base_filter, {"_id": 0, "email": 0}).limit(60):
            candidates.append(u)

    out = []
    for c in candidates:
        if not c.get("video_url"):
            continue
        dist = haversine_km(user.get("lat"), user.get("lng"), c.get("lat"), c.get("lng"))
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
                "distance_km": dist,
                "is_demo": bool(c.get("is_demo")),
                "_city": (c.get("city") or "").lower(),
            }
        )

    # Strict hyperlocal — only same-city demos surface; sort newest-first
    # within the city via a randomized shuffle so the feed feels fresh.
    _rng.shuffle(out)
    for o in out:
        o.pop("_city", None)

    # city_stats lets the frontend distinguish "genuinely empty" from
    # "exhausted" so the empty-state copy can be honest about which it is.
    city_stats = None
    if viewer_city:
        city_total = await db.users.count_documents({
            "id": {"$ne": user["id"]},
            "city": {"$regex": f"^{re.escape(viewer_city)}", "$options": "i"},
            "video_url": {"$ne": None, "$exists": True},
        })
        city_stats = {"total": city_total, "remaining": len(out)}

    return {"feed": out[:20], "city_stats": city_stats}


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


@api.get("/matches/unread")
async def matches_unread(user=Depends(current_user)):
    """Count matches created after the user last visited the Matches screen.
    Used by the BottomNav to render a green dot on the You-tab avatar."""
    last_viewed = user.get("last_matches_viewed_at")
    query = {"user_ids": user["id"]}
    if last_viewed:
        query["at"] = {"$gt": last_viewed}
    count = await db.matches.count_documents(query)
    return {"count": count}


@api.get("/matches")
async def matches(user=Depends(current_user)):
    cursor = db.matches.find({"user_ids": user["id"]}, {"_id": 0}).sort("at", -1)
    rows = await cursor.to_list(100)
    # Mark all current matches as "viewed" — drives the unread-dot reset.
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {"last_matches_viewed_at": datetime.now(timezone.utc).isoformat()}},
    )
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

    # Quick demo auto-reply so the chat doesn't feel empty in a demo match.
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
                "source_lang": "en",
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


# ---------------------------------------------------------------------------
# Video safety check — verifies the frame shows ONE human face & is safe
# ---------------------------------------------------------------------------
@api.post("/video/face-check")
async def face_check(req: FaceCheckReq, user=Depends(current_user)):
    """Use GPT-4o vision to (1) confirm the frame is one human face and content-safe,
    AND (2) estimate the person's apparent age for age-assurance.

    Returns: {ok: bool, reason: str, estimated_age: int|None, age_ok: bool}.
    Rejects if estimated age < 18 OR if estimated age differs from the user's
    declared age by more than 8 years (catches "I'm 30" when they look 15).

    If EMERGENT_LLM_KEY isn't configured we fail-open with ok=true so onboarding
    is never blocked by a misconfigured server.
    """
    img = (req.image_base64 or "").strip()
    if img.startswith("data:"):
        img = img.split(",", 1)[-1]
    if not img or len(img) < 200:
        raise HTTPException(400, "Image is required")
    if not EMERGENT_LLM_KEY:
        return {"ok": True, "reason": "skipped (no key)", "estimated_age": None, "age_ok": True}

    declared_age = int(user.get("age") or 0)
    try:
        chat = LlmChat(
            api_key=EMERGENT_LLM_KEY,
            session_id=f"facecheck-{uuid.uuid4()}",
            system_message=(
                "You are a strict content-safety + age-assurance reviewer for an intro-video social app. "
                "Look at the supplied image (one frame from a user's intro video) and decide TWO things:\n"
                "1. Is it acceptable? Acceptable = exactly ONE clearly visible human face looking roughly "
                "at the camera, fully clothed, no other people, no nudity / sexual content / hate symbols / "
                "weapons / illegal content / blank screen.\n"
                "2. Estimate the person's apparent age in YEARS (integer). Be conservative — if they could "
                "plausibly be a minor, err on the lower side. Do NOT rely on clothing or context; judge from "
                "facial features only. Return null only if no face is visible.\n"
                'Reply ONLY with strict JSON of the form '
                '{"ok": true|false, "reason": "<one short sentence>", "estimated_age": <int or null>}. '
                "No prose outside the JSON."
            ),
        ).with_model("openai", "gpt-4o-mini")
        msg = UserMessage(
            text="Review this intro-video frame: is it acceptable, and what is the apparent age?",
            file_contents=[ImageContent(image_base64=img)],
        )
        raw = (await chat.send_message(msg)) or ""
        import json as _json
        s = raw.strip()
        if "```" in s:
            s = s.split("```", 2)[1]
            if s.lower().startswith("json"):
                s = s[4:]
            s = s.strip()
        parsed = _json.loads(s)
        ok = bool(parsed.get("ok"))
        reason = str(parsed.get("reason") or "")[:300]
        est_raw = parsed.get("estimated_age")
        estimated_age = int(est_raw) if isinstance(est_raw, (int, float)) and est_raw else None

        # Age-assurance gate — only apply when the model returned a number AND
        # the safety check itself passed (so we don't double-reject).
        age_ok = True
        if ok and estimated_age is not None:
            if estimated_age < 18:
                age_ok = False
                reason = (
                    f"You appear to be around {estimated_age}, but Nice2Meechu is 18+. "
                    "If this is wrong, please retake with better lighting or a clearer angle."
                )
                ok = False
            elif declared_age and abs(estimated_age - declared_age) > 8:
                age_ok = False
                reason = (
                    f"Your video doesn't match the age you entered ({declared_age}). "
                    "Please retake your intro, or update your profile."
                )
                ok = False

        # Record the age-check outcome for audit trail (GDPR/DSA evidence)
        try:
            await db.age_checks.insert_one({
                "id": str(uuid.uuid4()),
                "user_id": user["id"],
                "declared_age": declared_age,
                "estimated_age": estimated_age,
                "ok": ok,
                "age_ok": age_ok,
                "at": datetime.now(timezone.utc).isoformat(),
            })
        except Exception:  # noqa: BLE001
            pass

        return {"ok": ok, "reason": reason, "estimated_age": estimated_age, "age_ok": age_ok}
    except Exception as exc:  # noqa: BLE001
        logger.exception("face-check failed: %s", exc)
        # Fail-open so users aren't blocked by transient model issues
        return {"ok": True, "reason": f"check unavailable ({exc.__class__.__name__})", "estimated_age": None, "age_ok": True}


@api.get("/samples")
async def list_samples():
    return {
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

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


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


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
