"""Pydantic request models for all API routes."""
from typing import List, Optional

from pydantic import BaseModel, Field


class SessionExchangeReq(BaseModel):
    session_id: str
    ref: Optional[str] = None  # referrer's handle, if user landed via /?ref=<handle>


class GoogleIdTokenReq(BaseModel):
    """Direct Google OAuth (GIS) — frontend posts the credential JWT here."""
    credential: str  # Google-issued ID token (JWT)
    ref: Optional[str] = None


class AppleIdTokenReq(BaseModel):
    """Sign in with Apple (web JS popup) — frontend posts the identity token here."""
    id_token: str  # Apple-issued identity token (JWT)
    name: Optional[str] = None  # only provided by Apple on first-ever sign-in
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
    transcript: Optional[str] = Field(None, max_length=2000)
    source_lang: str = "en"


class SwipeReq(BaseModel):
    target_user_id: str
    action: str  # "like", "pass", "block" or "unlike" (undo a prior like)


class NearbyRadiusReq(BaseModel):
    radius_km: int


class LinkGoogleReq(BaseModel):
    credential: str


class TranslateReq(BaseModel):
    text: str = Field(..., max_length=2000)
    target_lang: str
    source_lang: Optional[str] = None


class FaceCheckReq(BaseModel):
    image_base64: str  # raw base64 (no data: prefix) of a single frame from the video


class MessageReq(BaseModel):
    match_id: str
    text: str = Field(..., max_length=2000)


class LocationUpdate(BaseModel):
    lat: float
    lng: float
    city: Optional[str] = None
    # When true, also update the user's HOME city — where their video appears
    # to others. Otherwise only the browsing city changes (what they watch).
    set_home: bool = False


class CityPositionReq(BaseModel):
    city: str  # lowercase short city name, e.g. "tokyo"
    index: int  # 0-based position into the feed


class ReportReq(BaseModel):
    target_user_id: str
    reason: str
    details: Optional[str] = None
    match_id: Optional[str] = None


class BlockReq(BaseModel):
    target_user_id: str
