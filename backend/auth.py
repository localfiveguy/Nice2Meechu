"""Auth: session-token resolution, Google sign-in (popup + redirect), logout."""
import asyncio
import secrets
import uuid
from datetime import datetime, timezone
from typing import Optional

import httpx
import jwt as pyjwt
from fastapi import APIRouter, Cookie, Depends, Form, Header, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token

from core import (
    APPLE_SERVICE_ID,
    EMERGENT_AUTH_SESSION_URL,
    GOOGLE_CLIENT_ID,
    SESSION_TTL,
    db,
    generate_codename,
    logger,
)
from models import AppleIdTokenReq, GoogleIdTokenReq, SessionExchangeReq

router = APIRouter()


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

    # Track activity for the 90-day inactivity sweep. Fire-and-forget so it
    # doesn't slow the hot path. Motor's update_one IS a coroutine, but to
    # wrap it correctly with create_task we use ensure_future via a helper.
    async def _touch_seen() -> None:
        try:
            await db.users.update_one(
                {"id": user["id"]},
                {"$set": {"last_seen_at": datetime.now(timezone.utc).isoformat()}},
            )
        except Exception:  # noqa: BLE001
            pass

    asyncio.create_task(_touch_seen())
    return user


# ---------------------------------------------------------------------------
# Routes - meta + Google Auth (Emergent)
# ---------------------------------------------------------------------------
@router.get("/")
async def root():
    return {
        "app": "Nice2Meechu",
        "build": "v1.6-demo-location-healing",
        "auth": "google-direct" if GOOGLE_CLIENT_ID else "google-emergent",
    }


# REMINDER: DO NOT HARDCODE THE URL, OR ADD ANY FALLBACKS OR REDIRECT URLS, THIS BREAKS THE AUTH
async def _upsert_google_user(
    *, google_sub: Optional[str], email: str, name: Optional[str],
    picture: Optional[str], ref: Optional[str],
) -> dict:
    """Create-or-update the user record from Google profile info. New users
    get a codename + optional referral attribution (self-referrals dropped)."""
    existing = await db.users.find_one({"email": email}, {"_id": 0})
    if existing:
        update_fields = {"name": name, "picture": picture}
        if google_sub and not existing.get("google_sub"):
            update_fields["google_sub"] = google_sub
        await db.users.update_one({"id": existing["id"]}, {"$set": update_fields})
        return await db.users.find_one({"id": existing["id"]}, {"_id": 0})

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
    if ref_user_id:
        await db.users.update_one({"id": ref_user_id}, {"$inc": {"referral_count": 1}})
    return await db.users.find_one({"id": new_user["id"]}, {"_id": 0})


async def _mint_session(user_id: str, session_token: Optional[str] = None) -> str:
    """Mint (or refresh) our own session_token — we don't trust Google's lifetime."""
    token = session_token or secrets.token_urlsafe(32)
    await db.user_sessions.update_one(
        {"session_token": token},
        {"$set": {
            "user_id": user_id,
            "session_token": token,
            "expires_at": datetime.now(timezone.utc) + SESSION_TTL,
            "created_at": datetime.now(timezone.utc),
        }},
        upsert=True,
    )
    return token


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
    """Upsert the user, mint a session_token, set the httpOnly cookie, and
    return the standard auth payload. Shared by the direct-GIS endpoint,
    the redirect-mode endpoint, and the legacy Emergent exchange."""
    user = await _upsert_google_user(
        google_sub=google_sub, email=email, name=name, picture=picture, ref=ref
    )
    token = await _mint_session(user["id"], session_token)

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
@router.post("/auth/google-redirect")
async def auth_google_redirect(
    request: Request,
    credential: str = Form(...),
    g_csrf_token: Optional[str] = Form(None),
    ref: Optional[str] = None,
):
    """Redirect-mode counterpart of /auth/google. Used as `login_uri` for GIS
    when `ux_mode: "redirect"` — Google posts the JWT credential here via
    standard form-encoded POST, we verify, mint a session, set the cookie,
    and 303-redirect the user back to the app root. Required for iOS Safari
    where popup-mode OAuth is blocked outright by ITP. The g_csrf_token form
    field is GIS's own double-submit cookie check — we accept it transparently.

    `ref` is passed as a query-string param from the frontend's `login_uri`
    (because Google's redirect flow strips localStorage). It's a referral
    handle if the user landed via someone's invite link."""
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(500, "GOOGLE_CLIENT_ID not configured")
    try:
        idinfo = google_id_token.verify_oauth2_token(
            credential, google_requests.Request(), GOOGLE_CLIENT_ID, clock_skew_in_seconds=60
        )
    except ValueError as exc:
        logger.warning("Google redirect-mode token verification failed: %s", exc)
        # Send the user back to the splash so they can retry — embed reason
        # in the URL so the frontend can show a toast.
        return RedirectResponse(url="/?auth_error=invalid_credential", status_code=303)

    email = idinfo.get("email")
    if not email or not idinfo.get("email_verified", False):
        return RedirectResponse(url="/?auth_error=email_unverified", status_code=303)

    # Re-use the shared sign-in finalizer so the redirect path goes through
    # the same upsert + session-mint code as the popup path.
    resp = RedirectResponse(url="/", status_code=303)
    result = await _finalize_google_signin(
        resp,
        google_sub=idinfo.get("sub"),
        email=email,
        name=idinfo.get("name"),
        picture=idinfo.get("picture"),
        ref=ref,
    )
    # Some iOS Safari installs silently drop the session cookie set during a
    # cross-site redirect (ITP bounce-tracking mitigation), leaving the user
    # bounced back to the sign-in screen with no error. Hand the token back in
    # the URL fragment as well — fragments never leave the browser (not sent to
    # any server, not logged); the app stores it in localStorage and strips it
    # from the address bar immediately on load.
    resp.headers["location"] = f"/#st={result['token']}"
    return resp


@router.post("/auth/google")
async def auth_google_id_token(req: GoogleIdTokenReq, response: Response):
    """Direct Google OAuth — verify Google-issued ID token (JWT) and sign user in.
    Frontend uses Google Identity Services (GIS) which returns a `credential` JWT
    in the popup callback; that JWT is forwarded here for cryptographic verification."""
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(500, "GOOGLE_CLIENT_ID not configured")

    try:
        idinfo = google_id_token.verify_oauth2_token(
            req.credential, google_requests.Request(), GOOGLE_CLIENT_ID, clock_skew_in_seconds=60
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


@router.post("/auth/session")
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


# ---------------------------------------------------------------------------
# Sign in with Apple (web JS popup flow)
# ---------------------------------------------------------------------------
APPLE_ISSUER = "https://appleid.apple.com"
_apple_jwk_client = pyjwt.PyJWKClient(
    "https://appleid.apple.com/auth/keys", cache_keys=True, lifespan=86400
)


async def _upsert_apple_user(
    *, apple_sub: str, email: Optional[str], name: Optional[str], ref: Optional[str]
) -> dict:
    """Find-or-create the user from an Apple identity token. Lookup order:
    apple_sub (stable Apple identifier) → email (links Apple to an existing
    Google account) → create new. Apple only sends the name on the very first
    authorization, so it's only trusted at account-creation time."""
    existing = await db.users.find_one({"apple_sub": apple_sub}, {"_id": 0})
    if existing:
        return existing

    if email:
        by_email = await db.users.find_one({"email": email}, {"_id": 0})
        if by_email:
            await db.users.update_one({"id": by_email["id"]}, {"$set": {"apple_sub": apple_sub}})
            return await db.users.find_one({"id": by_email["id"]}, {"_id": 0})

    if not email:
        raise HTTPException(401, "Apple did not share an email for this account")

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
        "picture": None,
        "apple_sub": apple_sub,
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
    if ref_user_id:
        await db.users.update_one({"id": ref_user_id}, {"$inc": {"referral_count": 1}})
    return await db.users.find_one({"id": new_user["id"]}, {"_id": 0})


@router.post("/auth/apple")
async def auth_apple_id_token(req: AppleIdTokenReq, response: Response):
    """Sign in with Apple — verify the Apple-issued identity token (JWT) against
    Apple's JWKS public keys, then sign the user in. Frontend uses Apple's JS
    SDK in popup mode which returns `authorization.id_token`; that JWT is
    forwarded here for cryptographic verification (signature, audience=our
    Services ID, issuer=appleid.apple.com, expiry)."""
    if not APPLE_SERVICE_ID:
        raise HTTPException(500, "APPLE_SERVICE_ID not configured")

    try:
        signing_key = await asyncio.to_thread(
            _apple_jwk_client.get_signing_key_from_jwt, req.id_token
        )
        claims = pyjwt.decode(
            req.id_token,
            signing_key.key,
            algorithms=["RS256"],
            audience=APPLE_SERVICE_ID,
            issuer=APPLE_ISSUER,
        )
    except pyjwt.PyJWTError as exc:
        logger.warning("Apple identity token verification failed: %s", exc)
        raise HTTPException(401, "Invalid Apple credential")

    apple_sub = claims.get("sub")
    if not apple_sub:
        raise HTTPException(401, "Apple token missing subject")

    user = await _upsert_apple_user(
        apple_sub=apple_sub,
        email=claims.get("email"),
        name=(req.name or "").strip() or None,
        ref=req.ref,
    )
    token = await _mint_session(user["id"])
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


@router.get("/auth/me")
async def auth_me(user=Depends(current_user)):
    return {"user": user, "onboarded": bool(user.get("handle"))}


@router.post("/auth/logout")
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
