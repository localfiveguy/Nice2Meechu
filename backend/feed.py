"""Feed, swiping/matching, popular cities."""
import re
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends

from auth import current_user
from core import ALLOWED_NEARBY_RADII, NEARBY_RADIUS_KM, _rng, db, haversine_km
from demos import _is_demo_user, seed_demo_users
from models import SwipeReq

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


@router.get("/feed")
async def feed(user=Depends(current_user)):
    await seed_demo_users()
    # Build a quick map of prior swipe actions so we can mark each feed item
    # with its `prior_action` (None | "like" | "pass" | "block"). The client
    # uses this to skip past already-seen videos on initial render — but the
    # full list is returned so Back / Restart can still navigate to them.
    swipe_docs = await db.swipes.find(
        {"user_id": user["id"]}, {"_id": 0, "target_user_id": 1, "action": 1}
    ).to_list(5000)
    prior_action_by_id = {s["target_user_id"]: s["action"] for s in swipe_docs}
    blocked_ids = {tid for tid, action in prior_action_by_id.items() if action == "block"}
    viewer_city_full = (user.get("city") or "").strip()
    viewer_city = viewer_city_full.split(",")[0].strip().lower()

    # STRICT hyperlocal: if the viewer has set a city, ONLY surface demos in
    # that exact city. If there are none, return an empty feed and let the
    # frontend prompt the user to change location. No silent fallback — the
    # whole point of "near you" is to be honest about it.
    # Blocked users stay excluded (unlike pass/like which we just mark).
    base_filter = {
        "id": {"$ne": user["id"], "$nin": list(blocked_ids)},
        "video_url": {"$ne": None, "$exists": True},
    }
    candidates: list = []
    nearby: list = []
    radius_suggestion = None
    if viewer_city:
        city_filter = {
            **base_filter,
            # Match on the TARGET's HOME city — where they live — not their
            # browsing city. Exploring another city never relocates your video.
            "home_city": {"$regex": f"^{re.escape(viewer_city)}", "$options": "i"},
        }
        # Chronological (oldest-first) within the chosen city, so every viewer
        # sees the same "first video made here" regardless of when they joined.
        # No shuffle — the order is intentional.
        async for u in db.users.find(city_filter, {"_id": 0, "email": 0}).sort("created_at", 1).limit(60):
            candidates.append(u)

        # NEARBY TOWNS: also surface people whose HOME is within the viewer's
        # radius of the browsing city's center (e.g. Erial ↔ Marlton, ~15 km
        # apart). Locals stay first (chronological); nearby folks are appended
        # sorted by distance. Bounding-box prefilter keeps the scan cheap
        # without a geo index at this scale.
        from math import cos, radians as _radians
        center_lat = user.get("city_lat") if user.get("city_lat") is not None else user.get("lat")
        center_lng = user.get("city_lng") if user.get("city_lng") is not None else user.get("lng")
        if center_lat is not None and center_lng is not None:
            seen_ids = {c["id"] for c in candidates}
            radius_km = user.get("nearby_radius_km") or NEARBY_RADIUS_KM
            deg = radius_km / 111.0
            lng_deg = deg / max(0.2, cos(_radians(center_lat)))
            near_filter = {
                **base_filter,
                "home_lat": {"$gte": center_lat - deg, "$lte": center_lat + deg},
                "home_lng": {"$gte": center_lng - lng_deg, "$lte": center_lng + lng_deg},
            }
            async for u in db.users.find(near_filter, {"_id": 0, "email": 0}).limit(120):
                if u["id"] in seen_ids:
                    continue
                d = haversine_km(center_lat, center_lng, u.get("home_lat"), u.get("home_lng"))
                if d > radius_km:
                    continue
                u["_near_km"] = d
                nearby.append(u)
            nearby.sort(key=lambda x: (x["_near_km"], x.get("created_at") or ""))
            candidates.extend(nearby)

            # Radius-widen suggestion: count how many MORE people the next
            # radius tier (10→25→50) would surface, so the client can offer a
            # one-tap "widen to N km?" prompt when the local feed runs thin.
            next_km = next((r for r in sorted(ALLOWED_NEARBY_RADII) if r > radius_km), None)
            if next_km:
                all_ids = {c["id"] for c in candidates}
                deg_w = next_km / 111.0
                lng_deg_w = deg_w / max(0.2, cos(_radians(center_lat)))
                wide_filter = {
                    **base_filter,
                    "home_lat": {"$gte": center_lat - deg_w, "$lte": center_lat + deg_w},
                    "home_lng": {"$gte": center_lng - lng_deg_w, "$lte": center_lng + lng_deg_w},
                }
                extra = 0
                async for u in db.users.find(
                    wide_filter, {"_id": 0, "id": 1, "home_lat": 1, "home_lng": 1}
                ).limit(300):
                    if u["id"] in all_ids:
                        continue
                    d = haversine_km(center_lat, center_lng, u.get("home_lat"), u.get("home_lng"))
                    if radius_km < d <= next_km:
                        extra += 1
                if extra:
                    radius_suggestion = {
                        "current_km": radius_km,
                        "next_km": next_km,
                        "extra_people": extra,
                    }
    else:
        # No city set yet → fall back to nearest by distance so a brand-new
        # user without a city still sees content.
        async for u in db.users.find(base_filter, {"_id": 0, "email": 0}).limit(60):
            candidates.append(u)

    # Who among the candidates has already liked the viewer — powers the
    # "Likes you" hint (anonymity holds: the feed only shows codenames).
    likers = await db.swipes.find(
        {
            "target_user_id": user["id"],
            "action": "like",
            "user_id": {"$in": [c["id"] for c in candidates]},
        },
        {"_id": 0, "user_id": 1},
    ).to_list(200)
    liked_me_ids = {s["user_id"] for s in likers}
    # Already-matched pairs don't need the hint — "like back to match" would
    # be misleading when the match already exists.
    match_docs = await db.matches.find(
        {"user_ids": user["id"]}, {"_id": 0, "user_ids": 1}
    ).to_list(500)
    matched_ids = {uid for m in match_docs for uid in m["user_ids"] if uid != user["id"]}
    liked_me_ids -= matched_ids

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
                # Short home-town label — the card shows "from <Town>" when the
                # person's home differs from the city being browsed (nearby).
                "home_city": (c.get("home_city") or "").split(",")[0].strip(),
                "near_km": c.get("_near_km"),
                # True when this person already liked the viewer — liking back
                # matches instantly.
                "likes_you": c["id"] in liked_me_ids,
                # null when the viewer hasn't swiped on this user yet; otherwise
                # "like" or "pass". Lets the client skip past previously-seen
                # videos by default while still allowing Back/Restart navigation.
                "prior_action": prior_action_by_id.get(c["id"]),
            }
        )

    # Saved per-city scroll position so the user resumes where they left off
    # when they switch away from this city and come back. Defaults to None.
    saved_position = (user.get("city_positions") or {}).get(viewer_city) if viewer_city else None

    # Chronological order preserved (oldest first per the user's request) —
    # NO shuffle. The "first in city" video should be the same for every
    # viewer until that user is swiped away.

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
        # Present when widening the nearby radius would add ≥1 more person —
        # powers the one-tap "widen to N km?" retention prompt.
        "radius_suggestion": radius_suggestion,
        # How many sign-ups were attributed to this viewer's ?ref=<handle>
        # link — surfaced as the "X joined" chip next to the share pill.
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
