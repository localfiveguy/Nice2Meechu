"""Feed, swiping/matching, popular cities."""
import asyncio
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends

from auth import current_user
from core import ALLOWED_NEARBY_RADII, NEARBY_RADIUS_KM, _rng, db, haversine_km
from demos import _is_demo_user, seed_demo_users
from models import SwipeReq
from push import notify_user

router = APIRouter()

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


@router.get("/cities/popular")
async def cities_popular(user=Depends(current_user)):
    """Returns every city that has at least one OTHER user with a recorded
    intro, merged on top of the curated cities. `people` is the number of
    users in that city EXCLUDING the requesting user themselves — so when
    you move to a new city, the count there reflects "OTHER people here",
    not "all people including me". This keeps the badge stable as the viewer
    moves around (it doesn't tick up by 1 just because they switched their
    location). Real cities not in the curated list are appended."""
    pipeline = [
        {"$match": {
            "id": {"$ne": user["id"]},
            # Count people by HOME city — where their video appears — so the
            # map dots / popular counts reflect residents, not browsers.
            "home_city": {"$nin": [None, ""]},
            "video_url": {"$ne": None, "$exists": True},
        }},
        {"$group": {
            "_id": {"$toLower": "$home_city"},
            "raw_city": {"$first": "$home_city"},
            "count": {"$sum": 1},
            # Coalesce: prefer the home coords, then the explicit city center,
            # then the user's own geolocation.
            "lat": {"$first": {"$ifNull": ["$home_lat", {"$ifNull": ["$city_lat", "$lat"]}]}},
            "lng": {"$first": {"$ifNull": ["$home_lng", {"$ifNull": ["$city_lng", "$lng"]}]}},
        }},
    ]
    rows = await db.users.aggregate(pipeline).to_list(2000)

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

    # Append every real-only city that wasn't matched to a curated entry AND
    # has any usable coordinates. We bias toward inclusion: a city missing
    # coords falls back to (0, 0) — visible in the list as a navigable entry
    # even if "Use my current location" would be more accurate.
    # User-saved `city` is typically "City, State, Country" (US) or "City,
    # Country" (international). We want the row's second line to show
    # "State, Country" (or just "Country" outside the US) so neighbors can
    # see exactly where each city is — without it, "Marlton" alone is
    # ambiguous (there's one in NJ, MD, IL, etc.).
    _COUNTRY_SHORT = {
        "united states": "USA", "united states of america": "USA",
        "united kingdom": "UK", "united arab emirates": "UAE",
    }
    for r in rows:
        key = r["_id"]
        if key in matched_keys:
            continue
        parts = [p.strip() for p in (r.get("raw_city") or "").split(",") if p.strip()]
        city = parts[0] if parts else "Unknown"
        # `country` line for display: combine middle "state" parts (if any)
        # with the trailing country. Normalize verbose country names so the
        # row reads "NJ, USA" instead of "NJ, United States".
        raw_country = parts[-1] if len(parts) > 1 else ""
        country_norm = _COUNTRY_SHORT.get(raw_country.lower(), raw_country)
        middle = parts[1:-1] if len(parts) > 2 else []
        country_line = ", ".join([*middle, country_norm]) if (middle or country_norm) else ""
        out.append({
            "city": city, "country": country_line, "country_code": "", "flag": "🌍",
            "lat": float(r["lat"]) if r.get("lat") is not None else 0.0,
            "lng": float(r["lng"]) if r.get("lng") is not None else 0.0,
            "people": int(r["count"]),
        })

    # Cities with zero OTHER people get sorted to the bottom (still listed
    # so the operator can audit, but the engaged ones surface first). Cap
    # at 200 — well above any realistic city count for the friends-and-family
    # rollout but small enough to render without virtualization.
    out.sort(key=lambda x: (-x["people"], x["city"]))
    return {"cities": out[:200]}


def _bbox_filter(base_filter: dict, lat: float, lng: float, radius_km: float) -> dict:
    """Cheap bounding-box prefilter around (lat, lng) — avoids scanning every
    user without needing a geo index at this scale."""
    from math import cos, radians
    deg = radius_km / 111.0
    lng_deg = deg / max(0.2, cos(radians(lat)))
    return {
        **base_filter,
        "home_lat": {"$gte": lat - deg, "$lte": lat + deg},
        "home_lng": {"$gte": lng - lng_deg, "$lte": lng + lng_deg},
    }


async def _prior_actions(user_id: str) -> tuple[dict, set]:
    """Map of target_id → swipe action, plus the set of blocked target ids."""
    docs = await db.swipes.find(
        {"user_id": user_id}, {"_id": 0, "target_user_id": 1, "action": 1}
    ).to_list(5000)
    prior = {s["target_user_id"]: s["action"] for s in docs}
    blocked = {tid for tid, action in prior.items() if action == "block"}
    return prior, blocked


async def _local_candidates(base_filter: dict, viewer_city: str) -> list:
    """Everyone whose HOME city matches the browsing city — chronological
    (oldest-first) so every viewer sees the same 'first video made here'."""
    city_filter = {
        **base_filter,
        "home_city": {"$regex": f"^{re.escape(viewer_city)}", "$options": "i"},
    }
    return [
        u async for u in
        db.users.find(city_filter, {"_id": 0, "email": 0}).sort("created_at", 1).limit(60)
    ]


async def _nearby_candidates(base_filter: dict, lat: float, lng: float, radius_km: float, seen_ids: set) -> list:
    """People whose HOME is within radius_km of the browsing city's center
    (e.g. Erial ↔ Marlton, ~15 km). Sorted by distance; `_near_km` annotated."""
    nearby = []
    async for u in db.users.find(
        _bbox_filter(base_filter, lat, lng, radius_km), {"_id": 0, "email": 0}
    ).limit(120):
        if u["id"] in seen_ids:
            continue
        d = haversine_km(lat, lng, u.get("home_lat"), u.get("home_lng"))
        if d > radius_km:
            continue
        u["_near_km"] = d
        nearby.append(u)
    nearby.sort(key=lambda x: (x["_near_km"], x.get("created_at") or ""))
    return nearby


async def _radius_suggestion(base_filter: dict, lat: float, lng: float, radius_km: float, exclude_ids: set) -> Optional[dict]:
    """How many MORE people the next radius tier (10→25→50) would surface —
    powers the one-tap 'widen to N km?' retention prompt. None when maxed out
    or when widening adds nobody."""
    next_km = next((r for r in sorted(ALLOWED_NEARBY_RADII) if r > radius_km), None)
    if not next_km:
        return None
    extra = 0
    async for u in db.users.find(
        _bbox_filter(base_filter, lat, lng, next_km),
        {"_id": 0, "id": 1, "home_lat": 1, "home_lng": 1},
    ).limit(300):
        if u["id"] in exclude_ids:
            continue
        d = haversine_km(lat, lng, u.get("home_lat"), u.get("home_lng"))
        if radius_km < d <= next_km:
            extra += 1
    if not extra:
        return None
    return {"current_km": radius_km, "next_km": next_km, "extra_people": extra}


async def _liked_me_ids(user_id: str, candidate_ids: list) -> set:
    """Candidates who already liked the viewer, minus already-matched pairs
    (the 'like back to match' hint would be misleading there)."""
    likers = await db.swipes.find(
        {"target_user_id": user_id, "action": "like", "user_id": {"$in": candidate_ids}},
        {"_id": 0, "user_id": 1},
    ).to_list(200)
    liked = {s["user_id"] for s in likers}
    match_docs = await db.matches.find(
        {"user_ids": user_id}, {"_id": 0, "user_ids": 1}
    ).to_list(500)
    matched = {uid for m in match_docs for uid in m["user_ids"] if uid != user_id}
    return liked - matched


def _feed_item(c: dict, user: dict, liked_me_ids: set, prior_action_by_id: dict) -> dict:
    return {
        "id": c["id"],
        "codename": c.get("codename", "Anon"),
        "avatar_emoji": c.get("avatar_emoji", "🌙"),
        "vibes": c.get("vibes", []),
        "language": c.get("language", "en"),
        "video_url": c["video_url"],
        "transcript": c.get("transcript", ""),
        "source_lang": c.get("source_lang", "en"),
        "distance_km": haversine_km(user.get("lat"), user.get("lng"), c.get("lat"), c.get("lng")),
        "is_demo": bool(c.get("is_demo")),
        # Short home-town label — the card shows "from <Town>" when the
        # person's home differs from the city being browsed (nearby).
        "home_city": (c.get("home_city") or "").split(",")[0].strip(),
        "near_km": c.get("_near_km"),
        # True when this person already liked the viewer — liking back matches instantly.
        "likes_you": c["id"] in liked_me_ids,
        # null until the viewer swipes; else "like"/"pass". Lets the client skip
        # previously-seen videos while still allowing Back/Restart navigation.
        "prior_action": prior_action_by_id.get(c["id"]),
    }


@router.get("/feed")
async def feed(user=Depends(current_user)):
    """STRICT hyperlocal feed: locals (chronological) + nearby towns (by
    distance) within the viewer's radius. No silent fallback to other cities —
    'near you' stays honest. Blocked users excluded entirely; liked/passed
    users included but marked via prior_action."""
    await seed_demo_users()
    prior_action_by_id, blocked_ids = await _prior_actions(user["id"])
    viewer_city = (user.get("city") or "").strip().split(",")[0].strip().lower()

    base_filter = {
        "id": {"$ne": user["id"], "$nin": list(blocked_ids)},
        "video_url": {"$ne": None, "$exists": True},
    }

    nearby: list = []
    radius_suggestion = None
    if viewer_city:
        candidates = await _local_candidates(base_filter, viewer_city)
        center_lat = user.get("city_lat") if user.get("city_lat") is not None else user.get("lat")
        center_lng = user.get("city_lng") if user.get("city_lng") is not None else user.get("lng")
        if center_lat is not None and center_lng is not None:
            radius_km = user.get("nearby_radius_km") or NEARBY_RADIUS_KM
            nearby = await _nearby_candidates(
                base_filter, center_lat, center_lng, radius_km, {c["id"] for c in candidates}
            )
            candidates.extend(nearby)
            radius_suggestion = await _radius_suggestion(
                base_filter, center_lat, center_lng, radius_km, {c["id"] for c in candidates}
            )
    else:
        # No city set yet → nearest-by-distance fallback so a brand-new user
        # without a city still sees content.
        candidates = [u async for u in db.users.find(base_filter, {"_id": 0, "email": 0}).limit(60)]

    liked_me_ids = await _liked_me_ids(user["id"], [c["id"] for c in candidates])
    out = [
        _feed_item(c, user, liked_me_ids, prior_action_by_id)
        for c in candidates if c.get("video_url")
    ]

    # Saved per-city scroll position so the user resumes where they left off.
    saved_position = (user.get("city_positions") or {}).get(viewer_city) if viewer_city else None

    # city_stats lets the frontend distinguish "genuinely empty" from
    # "exhausted" so the empty-state copy can be honest about which it is.
    city_stats = None
    if viewer_city:
        city_total = await db.users.count_documents({
            "id": {"$ne": user["id"]},
            "home_city": {"$regex": f"^{re.escape(viewer_city)}", "$options": "i"},
            "video_url": {"$ne": None, "$exists": True},
        })
        city_stats = {"total": city_total + len(nearby), "remaining": len(out)}

    return {
        "feed": out[:60],
        "city_stats": city_stats,
        "saved_position": saved_position,
        # Present when widening the nearby radius would add ≥1 more person.
        "radius_suggestion": radius_suggestion,
        # Sign-ups attributed to this viewer's ?ref=<handle> link.
        "referral_count": user.get("referral_count", 0),
    }


async def _check_mutual_match(target: dict, viewer_id: str) -> bool:
    # A real reverse-like always wins — this keeps the "Likes you → like back
    # to match instantly" contract honest, including for seeded demo swipes.
    rev = await db.swipes.find_one(
        {"user_id": target["id"], "target_user_id": viewer_id, "action": "like"}
    )
    if rev:
        return True
    if _is_demo_user(target):
        return _rng.random() < 0.7
    return False


@router.post("/swipe")
async def swipe(req: SwipeReq, user=Depends(current_user)):
    # "unlike" = the viewer changed their mind: delete the swipe row entirely
    # so the video returns to the unswiped state. Consistent with the policy
    # below, an already-created match is NOT retroactively destroyed.
    if req.action == "unlike":
        await db.swipes.delete_one({"user_id": user["id"], "target_user_id": req.target_user_id})
        return {"match": False}
    # Upsert so users can re-watch a video (via Back / Restart) and change
    # their mind without duplicate-swipe rows piling up. If they previously
    # liked and now pass, the new action wins for any FUTURE feed/match
    # computations — but we DO NOT retroactively undo an already-created
    # match (that would yank a chat from the other party with no warning).
    await db.swipes.update_one(
        {"user_id": user["id"], "target_user_id": req.target_user_id},
        {"$set": {
            "id": str(uuid.uuid4()),
            "user_id": user["id"],
            "target_user_id": req.target_user_id,
            "action": req.action,
            "at": datetime.now(timezone.utc).isoformat(),
        }},
        upsert=True,
    )
    if req.action != "like":
        return {"match": False}

    target = await db.users.find_one({"id": req.target_user_id}, {"_id": 0})
    if not target:
        return {"match": False}

    # If the pair is already matched (e.g., a Back-then-like re-watch), don't
    # spawn a duplicate match.
    existing = await db.matches.find_one(
        {"user_ids": sorted([user["id"], req.target_user_id])}, {"_id": 0, "id": 1}
    )
    if existing:
        return {"match": True, "match_id": existing["id"], "already_matched": True}

    if not await _check_mutual_match(target, user["id"]):
        return {"match": False}

    match_id = str(uuid.uuid4())
    await db.matches.insert_one(
        {
            "id": match_id,
            "user_ids": sorted([user["id"], req.target_user_id]),
            "at": datetime.now(timezone.utc).isoformat(),
        }
    )
    # Tell the other side they just got a match (opt-in push; no-op for demos).
    asyncio.create_task(notify_user(
        req.target_user_id,
        f"💌 It's a match with {user.get('codename') or 'someone'}! Say hi!",
        tag=f"match-{match_id}",
    ))
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


@router.get("/matches/unread")
async def matches_unread(user=Depends(current_user)):
    """Count matches created after the user last visited the Matches screen.
    Used by the BottomNav to render a green dot on the You-tab avatar."""
    last_viewed = user.get("last_matches_viewed_at")
    query = {"user_ids": user["id"]}
    if last_viewed:
        query["at"] = {"$gt": last_viewed}
    count = await db.matches.count_documents(query)
    return {"count": count}


@router.get("/matches")
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
