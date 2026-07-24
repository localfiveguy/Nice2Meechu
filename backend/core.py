"""Shared config, database handle, and cross-cutting helpers.

Every router module imports from here; this module imports nothing from the
rest of the app, so there are no circular-import hazards.
"""
import logging
import os
import re
import secrets
from datetime import timedelta
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import HTTPException
from google.cloud import storage as gcs_storage
from motor.motor_asyncio import AsyncIOMotorClient

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
APPLE_SERVICE_ID = os.environ.get("APPLE_SERVICE_ID", "")
ADMIN_EMAILS = {e.strip().lower() for e in os.environ.get("ADMIN_EMAILS", "").split(",") if e.strip()}
GCP_PROJECT_ID = os.environ.get("GCP_PROJECT_ID", "")
GCS_BUCKET = os.environ.get("GCS_BUCKET", "")
SESSION_TTL = timedelta(days=7)

# Same-town coordinate tolerance: a person "belongs" to a browsed city when
# their HOME coords are within this distance of the city's center. Absorbs
# naming variants of the SAME town (Marlton ↔ Evesham centers are 6.5 km
# apart) without reaching neighboring towns (Medford/Cherry Hill are 9.4+ km).
SAME_TOWN_KM = 8

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("nice2meechu")

# Lazily-initialized GCS client — None until first use. Avoids crashing on
# startup if credentials are missing in development; raises clearly at upload time.
_gcs_client: Optional[gcs_storage.Client] = None
_gcs_bucket: Optional[gcs_storage.Bucket] = None


def _get_gcs_bucket() -> gcs_storage.Bucket:
    """Return the configured GCS bucket, initializing the client on first call."""
    global _gcs_client, _gcs_bucket
    if _gcs_bucket is not None:
        return _gcs_bucket
    if not (GCP_PROJECT_ID and GCS_BUCKET):
        raise HTTPException(500, "GCS_BUCKET / GCP_PROJECT_ID not configured")
    _gcs_client = gcs_storage.Client(project=GCP_PROJECT_ID)
    _gcs_bucket = _gcs_client.bucket(GCS_BUCKET)
    return _gcs_bucket


# ---------------------------------------------------------------------------
# Seed data / naming
# ---------------------------------------------------------------------------
VIBES_POOL = ["Coffee", "Vinyl", "Skater", "Foodie", "Bookworm", "Gamer", "Hiker", "Artist", "Runner", "Night Owl"]
CODENAME_ADJ = ["Velvet", "Neon", "Midnight", "Ember", "Cosmic", "Aurora", "Silken", "Vivid", "Hazel", "Indigo"]
CODENAME_NOUN = ["Fox", "Comet", "Drift", "Echo", "Lynx", "Mirage", "Orbit", "Phoenix", "Raven", "Tide"]

LANG_NAMES = {
    "en": "English", "es": "Spanish", "fr": "French", "de": "German", "pt": "Portuguese",
    "it": "Italian", "ja": "Japanese", "ko": "Korean", "zh": "Chinese", "hi": "Hindi",
    "ar": "Arabic", "ru": "Russian",
}

# Rendered OG share cards, keyed by lowercase handle. Onboarding pops entries
# when a handle changes; /api/og/{handle} fills them.
_OG_CACHE: dict[str, bytes] = {}


def generate_codename() -> str:
    return f"{_rng.choice(CODENAME_ADJ)} {_rng.choice(CODENAME_NOUN)}"


async def _geocode_city(city_full: str, use_cache: bool = True) -> tuple:
    """Resolve a city label ("Marlton, New Jersey, United States") to coords
    via Photon, cached forever in db.city_geo. Returns (lat, lng) or (None,
    None) on failure — failures are NOT cached so transient outages retry.
    Pass use_cache=False when the result will be persisted onto a user record:
    cached entries must never flow back into user docs (poisoning vector)."""
    key = (city_full or "").strip().lower()
    if not key:
        return None, None
    if use_cache:
        cached = await db.city_geo.find_one({"key": key}, {"_id": 0})
        if cached:
            return cached.get("lat"), cached.get("lng")
    try:
        import httpx
        async with httpx.AsyncClient(timeout=5) as http:
            r = await http.get(
                "https://photon.komoot.io/api",
                params={"q": city_full, "limit": 1},
                headers={"User-Agent": "nice2meechu/1.0"},
            )
            feats = (r.json() or {}).get("features") or []
            if feats:
                lng, lat = feats[0]["geometry"]["coordinates"]
                await db.city_geo.update_one(
                    {"key": key},
                    {"$set": {"key": key, "lat": lat, "lng": lng}},
                    upsert=True,
                )
                return lat, lng
    except Exception:  # noqa: BLE001
        logger.warning("geocode failed for %r (non-fatal)", city_full)
    return None, None


def haversine_km(lat1, lng1, lat2, lng2) -> float:
    from math import asin, cos, radians, sin, sqrt

    if None in (lat1, lng1, lat2, lng2):
        return 999.0
    r = 6371
    dlat = radians(lat2 - lat1)
    dlng = radians(lng2 - lng1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlng / 2) ** 2
    return round(2 * r * asin(sqrt(a)), 1)


# Mirror of the frontend `stripCityNoise()` (lib/cityFormat.js) — keeps the
# rules identical so saved city strings match what the autocomplete returns
# for new users. Strips municipal-classification suffixes/prefixes that locals
# don't say out loud ("Voorhees Township" → "Voorhees").
_CITY_NOISE_SUFFIX_RE = re.compile(
    r"\s+(?:Township|Twp\.?|Borough)\s*$",
    re.IGNORECASE,
)
_CITY_NOISE_PREFIX_RE = re.compile(
    r"^(?:City of|Town of|Borough of|Township of)\s+",
    re.IGNORECASE,
)


def _strip_city_noise(name: Optional[str]) -> Optional[str]:
    if not name or not isinstance(name, str):
        return name
    out = name.strip()
    out = _CITY_NOISE_PREFIX_RE.sub("", out)
    out = _CITY_NOISE_SUFFIX_RE.sub("", out)
    return out.strip()
