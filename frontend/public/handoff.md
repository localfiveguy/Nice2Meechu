# Nice2Meechu — Handoff (with embedded code)

> Single-file reference for the next agent / future-you. All code below is the **actual current source** as of 2026-05-30. The Profile-edit P0 bug is **fixed** and live in preview.

---

## 1. Live URLs
- **Production:** https://nice2meechu.com (Emergent deploy; Network Solutions DNS → A `@` 162.159.142.117 + 172.66.2.113, CNAME `www` → nice2meechu.com)
- **Preview/dev:** https://hyperlocal-video.preview.emergentagent.com
- **This handoff:** https://hyperlocal-video.preview.emergentagent.com/handoff.md (right-click → Save As)

## 2. Stack
- FastAPI + React (CRA via craco) + MongoDB. All backend routes prefixed `/api`.
- Backend: `/app/backend/server.py` (~900 lines, single-file) · env: `/app/backend/.env`
- Frontend: `/app/frontend/src/App.js` (~1640 lines, single-file), `index.css`, `analytics.js` · env: `/app/frontend/.env`
- Sample videos: `/app/frontend/public/videos/v{1..6}.{mp4,webm}` → served at `/videos/...`.
- Supervisor: `sudo supervisorctl restart {backend|frontend}` after `.env`/deps; hot-reload otherwise. Use **yarn**, never npm.

### .env templates
`/app/backend/.env`
```
MONGO_URL=mongodb://localhost:27017
DB_NAME=nice2meechu
CORS_ORIGINS=*
EMERGENT_LLM_KEY=sk-emergent-...
```
`/app/frontend/.env`
```
REACT_APP_BACKEND_URL=https://hyperlocal-video.preview.emergentagent.com
REACT_APP_GA4_MEASUREMENT_ID=G-VLT66KELPL
```

---

## 3. Auth — Emergent-managed Google OAuth

Flow: frontend redirects to `https://auth.emergentagent.com/?redirect=<origin>`. On return, frontend posts the `session_id` from the URL fragment to `POST /api/auth/session`. Backend exchanges it at `https://demobackend.emergentagent.com/auth/v1/env/oauth/session-data`, upserts the user, stores a 7-day row in `user_sessions`, and sets an httpOnly cookie `session_token`. `current_user` reads the cookie first, then `Authorization: Bearer` (used by automated tests).

### Backend — `/app/backend/server.py` (auth helpers + exchange)

```python
# ----- helpers (~L128) -----
def _extract_token(authorization, session_token_cookie):
    if session_token_cookie:
        return session_token_cookie
    if authorization and authorization.startswith("Bearer "):
        return authorization.split(" ", 1)[1].strip()
    return None

async def _resolve_user_from_token(token):
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

# ----- /api/auth/session (~L171) -----
@api.post("/auth/session")
async def auth_session_exchange(req: SessionExchangeReq, response: Response):
    async with httpx.AsyncClient(timeout=15) as http:
        r = await http.get(EMERGENT_AUTH_SESSION_URL,
                           headers={"X-Session-ID": req.session_id})
    if r.status_code != 200:
        raise HTTPException(401, "Invalid session_id")
    data = r.json()
    email, name, picture = data.get("email"), data.get("name"), data.get("picture")
    session_token = data.get("session_token")
    if not (email and session_token):
        raise HTTPException(500, "Malformed auth response")

    existing = await db.users.find_one({"email": email}, {"_id": 0})
    if existing:
        await db.users.update_one({"id": existing["id"]},
            {"$set": {"name": name, "picture": picture}})
        user = await db.users.find_one({"id": existing["id"]}, {"_id": 0})
    else:
        # Optional referral attribution (?ref=<handle>)
        ref_user_id = None
        ref_handle = (req.ref or "").strip().lower()
        if ref_handle:
            ref_user = await db.users.find_one({"handle": ref_handle}, {"_id": 0, "id": 1})
            if ref_user:
                ref_user_id = ref_user["id"]
        new_user = {
            "id": str(uuid.uuid4()),
            "email": email, "name": name, "picture": picture,
            "codename": generate_codename(),
            "handle": None,
            "first_name": (name or "").strip().split(" ")[0] if name else None,
            "vibes": [], "language": "en", "avatar_emoji": "🌙",
            "lat": None, "lng": None,
            "video_url": None, "transcript": None, "source_lang": None,
            "referrer_handle": ref_handle or None,
            "referrer_id": ref_user_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        await db.users.insert_one(new_user.copy())
        user = await db.users.find_one({"id": new_user["id"]}, {"_id": 0})
        if ref_user_id:
            await db.users.update_one({"id": ref_user_id}, {"$inc": {"referral_count": 1}})

    expires_at = datetime.now(timezone.utc) + SESSION_TTL
    await db.user_sessions.update_one(
        {"session_token": session_token},
        {"$set": {"user_id": user["id"], "session_token": session_token,
                  "expires_at": expires_at, "created_at": datetime.now(timezone.utc)}},
        upsert=True,
    )
    response.set_cookie("session_token", session_token,
        max_age=int(SESSION_TTL.total_seconds()), path="/",
        httponly=True, secure=True, samesite="none")
    return {"token": session_token, "user": user, "onboarded": bool(user.get("handle"))}
```

---

## 4. Key API endpoints (cheat-sheet)
| Method | Path | Notes |
| ---- | ---- | ---- |
| POST | `/api/auth/session` | body `{session_id, ref?}` |
| GET  | `/api/auth/me` |  |
| POST | `/api/auth/logout` |  |
| POST | `/api/users/onboarding` | `first_name, city, age, city_lat?, city_lng?, vibes?, language?, avatar_emoji?` |
| POST | `/api/users/community-rules` | 7 items + signature data-URL |
| POST | `/api/users/location` | `{lat, lng}` |
| POST | `/api/users/video` | sample_index OR video_url, transcript, source_lang |
| GET  | `/api/feed` | geo-sorted, seeds demo users on first call |
| POST | `/api/swipe` | `{target_user_id, action}` |
| GET  | `/api/matches` |  |
| GET/POST | `/api/messages` | translation cached in `messages.translated_text` |
| POST | `/api/translate` | `{text, target_lang, source_lang?}` |
| POST | `/api/video/face-check` | base64 frame → GPT-4o-mini vision, fail-open |
| GET  | `/api/og/<handle>` | 1200×630 PNG share card (Pillow + pilmoji, in-process cache) |

### Pydantic models (`/app/backend/server.py` ~L69)
```python
class SessionExchangeReq(BaseModel):
    session_id: str
    ref: Optional[str] = None

class OnboardingReq(BaseModel):
    first_name: str
    city: str
    age: int
    city_lat: Optional[float] = None
    city_lng: Optional[float] = None
    vibes: List[str] = []
    language: str = "en"
    avatar_emoji: Optional[str] = "🌙"

class RulesAcceptReq(BaseModel):
    accepted_items: List[str]
    signature_data_url: str

class VideoUploadReq(BaseModel):
    sample_index: Optional[int] = None
    video_url: Optional[str] = None
    transcript: Optional[str] = None
    source_lang: str = "en"

class SwipeReq(BaseModel):
    target_user_id: str
    action: str  # "like" | "pass"

class TranslateReq(BaseModel):
    text: str
    target_lang: str
    source_lang: Optional[str] = None

class FaceCheckReq(BaseModel):
    image_base64: str

class MessageReq(BaseModel):
    match_id: str
    text: str

class LocationUpdate(BaseModel):
    lat: float
    lng: float
```

### Onboarding endpoint (source of truth for ProfileScreen)
```python
@api.post("/users/onboarding")
async def onboarding(req: OnboardingReq, user=Depends(current_user)):
    first_name = req.first_name.strip()[:40]
    if not first_name:
        raise HTTPException(400, "First name is required")
    if not 13 <= req.age <= 120:
        raise HTTPException(400, "Age must be between 13 and 120")

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
    if req.city_lat is not None and req.city_lng is not None:
        if not user.get("lat") or not user.get("lng"):
            update["lat"] = req.city_lat
            update["lng"] = req.city_lng
        update["city_lat"] = req.city_lat
        update["city_lng"] = req.city_lng
    await db.users.update_one({"id": user["id"]}, {"$set": update})
    user.update(update)
    for h in {user.get("handle"), update["handle"]}:
        if h:
            _OG_CACHE.pop(h.lower(), None)
    return {"user": user}
```

### Face-check endpoint (GPT-4o-mini Vision, fail-open)
```python
@api.post("/video/face-check")
async def face_check(req: FaceCheckReq, user=Depends(current_user)):
    img = (req.image_base64 or "").strip()
    if img.startswith("data:"):
        img = img.split(",", 1)[-1]
    if not img or len(img) < 200:
        raise HTTPException(400, "Image is required")
    if not EMERGENT_LLM_KEY:
        return {"ok": True, "reason": "skipped (no key)"}
    try:
        chat = LlmChat(
            api_key=EMERGENT_LLM_KEY,
            session_id=f"facecheck-{uuid.uuid4()}",
            system_message=(
                "You are a strict content-safety reviewer for an intro-video social app. "
                "Acceptable = exactly ONE clearly visible human face, fully clothed, "
                "no other people, no nudity / hate / weapons / minors / blank screen. "
                'Reply ONLY with strict JSON {"ok": true|false, "reason": "<sentence>"}.'
            ),
        ).with_model("openai", "gpt-4o-mini")
        msg = UserMessage(
            text="Is this intro-video frame acceptable per the rules?",
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
        return {"ok": bool(parsed.get("ok")), "reason": str(parsed.get("reason") or "")[:300]}
    except Exception as exc:
        logger.exception("face-check failed: %s", exc)
        return {"ok": True, "reason": f"check unavailable ({exc.__class__.__name__})"}
```

---

## 5. Screen flow (`/app/frontend/src/App.js`)
Splash → SignIn / AuthCallback → **Onboarding** (name → city w/ Photon autocomplete → age) → **Community Rules** (7 checkboxes + signature canvas) → **Video Pick** (dynamic script with `{first_name}`+`{city}`, ⚠️ warning, AI face-check w/ "✨ Verifying your video…" badge) → Feed / Matches / Chat (live translation, EN→ES badge) / **Profile** (Share card → `/api/og/<handle>`).

### Onboarding component (working reference)
```jsx
function Onboarding({ user, onDone }) {
  const [step, setStep] = useState(0);
  const [firstName, setFirstName] = useState(user.first_name || "");
  const [city, setCity] = useState(user.city || "");
  const [cityCoords, setCityCoords] = useState(null);
  const [age, setAge] = useState(user.age ? String(user.age) : "");
  const [loading, setLoading] = useState(false);
  const total = 3;
  const ageNum = parseInt(age, 10);
  const browserLang = (typeof navigator !== "undefined" && navigator.language?.slice(0, 2)) || "en";

  const submit = async () => {
    setLoading(true);
    try {
      const { data } = await api.post("/users/onboarding", {
        first_name: firstName.trim(),
        city: city.trim(),
        age: ageNum,
        language: browserLang,
        city_lat: cityCoords?.lat ?? null,
        city_lng: cityCoords?.lng ?? null,
      });
      track("onboarding_completed", { age: ageNum, language: browserLang, has_city_coords: !!cityCoords });
      toast.success(`Hey ${data.user.first_name} ✨`);
      onDone(data.user);
    } catch (e) {
      track("onboarding_failed");
      toast.error(e?.response?.data?.detail || "Couldn't save profile");
    } finally { setLoading(false); }
  };
  /* ...3-step UI: name → CityAutocomplete → age... */
}
```

### CityAutocomplete (Photon / OpenStreetMap)
```jsx
function CityAutocomplete({ value, onChange, onPick }) {
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef(null);

  const onInput = (e) => {
    const v = e.target.value;
    onChange(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (v.trim().length < 2) { setSuggestions([]); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(v)}&limit=6&osm_tag=place:city`);
        const j = await r.json();
        const items = (j.features || []).map((f) => ({
          value: `${f.properties.name}${f.properties.country ? ", " + f.properties.country : ""}`,
          lat: f.geometry.coordinates[1],
          lng: f.geometry.coordinates[0],
        }));
        setSuggestions(items); setOpen(items.length > 0);
      } catch { /* network blip — ignore */ }
    }, 220);
  };
  /* ...dropdown UI calls onPick({value, lat, lng})... */
}
```

---

## 6. ✅ P0 Bug Fix — Profile edit "Couldn't save" (FIXED + VERIFIED)
The old `ProfileScreen` posted `{handle, vibes, language, avatar_emoji}` → backend returned 400 because the new `OnboardingReq` requires `first_name`, `city`, `age`. **Fixed by rewriting the edit form** to mirror `Onboarding`. View-mode now displays name · age · city · native language. Verified via curl (200/400/400) and Playwright (Edit → change → Save → green "Saved" toast → updated view-mode).

### Final ProfileScreen (`/app/frontend/src/App.js` ~L1500) — currently live
```jsx
function ProfileScreen({ user, setUser, onTab, onLogout, onChangeVideo }) {
  const [editing, setEditing] = useState(false);
  const [firstName, setFirstName] = useState(user.first_name || "");
  const [city, setCity] = useState(user.city || "");
  const [cityCoords, setCityCoords] = useState(null);
  const [age, setAge] = useState(user.age ? String(user.age) : "");
  const [language, setLanguage] = useState(user.language || "en");
  const [emoji, setEmoji] = useState(user.avatar_emoji || "🌙");
  const [saving, setSaving] = useState(false);

  const ageNum = parseInt(age, 10);
  const canSave =
    firstName.trim().length >= 1 &&
    city.trim().length >= 2 &&
    !isNaN(ageNum) && ageNum >= 13 && ageNum <= 120;

  const save = async () => {
    if (!canSave) { toast.error("Check name, city, and age (13+)"); return; }
    setSaving(true);
    try {
      const { data } = await api.post("/users/onboarding", {
        first_name: firstName.trim(),
        city: city.trim(),
        age: ageNum,
        language,
        avatar_emoji: emoji,
        city_lat: cityCoords?.lat ?? null,
        city_lng: cityCoords?.lng ?? null,
      });
      setUser(data.user);
      setEditing(false);
      toast.success("Saved");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't save");
    } finally { setSaving(false); }
  };

  return (
    <motion.div
      className="absolute inset-0 flex flex-col bg-black overflow-hidden"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      data-testid="profile-screen"
    >
      {user.video_url ? (
        <VideoEl src={user.video_url} autoPlay loop muted playsInline
          className="absolute inset-0 w-full h-full object-cover" />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-[#1a0a0a] to-[#0a0a1a]" />
      )}
      <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/20 to-black/90 pointer-events-none" />

      <div className="relative z-10 flex-1 flex flex-col px-6 pt-12 pb-36 overflow-y-auto no-scrollbar">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-3xl font-black">You.</h2>
          <button
            className="text-white/60 text-sm font-bold uppercase tracking-widest"
            onClick={() => setEditing((v) => !v)}
            data-testid="profile-edit-toggle"
          >
            {editing ? "Cancel" : "Edit"}
          </button>
        </div>

        <div className="mt-auto glass-dark rounded-3xl p-5 mt-8">
          <div className="flex items-center gap-3">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center bg-white/8 text-2xl">
              {user.avatar_emoji}
            </div>
            <div>
              <div className="text-xs uppercase tracking-widest font-bold text-white/50">
                codename · {user.codename}
              </div>
              <div className="font-display text-xl font-black">@{user.handle}</div>
            </div>
          </div>

          {!editing ? (
            <>
              <div className="mt-4 text-sm text-white/80">
                <span className="font-bold text-white">{user.first_name}</span>
                {user.age ? <span className="text-white/60"> · {user.age}</span> : null}
              </div>
              <div className="mt-1 text-xs text-white/60 flex items-center gap-1.5">
                <MapPin size={12} /> {user.city || "Somewhere on Earth"}
              </div>
              <div className="mt-1 text-xs text-white/60 flex items-center gap-1.5">
                <Globe size={12} /> Native:{" "}
                {LANG_OPTIONS.find((l) => l.code === user.language)?.name || user.language}
              </div>

              <ShareCard user={user} />

              <div className="mt-3 grid grid-cols-2 gap-2">
                <button className="btn-ghost text-sm" onClick={onChangeVideo} data-testid="profile-change-video">
                  <VideoIcon size={14} className="inline mr-1" /> Change intro
                </button>
                <button className="btn-ghost text-sm" onClick={onLogout} data-testid="profile-logout">
                  <LogOut size={14} className="inline mr-1" /> Log out
                </button>
              </div>
            </>
          ) : (
            <div className="mt-4 flex flex-col gap-3">
              <div>
                <p className="text-[10px] uppercase tracking-widest font-bold text-white/55 mb-1">First name</p>
                <input
                  className="n2m-input"
                  value={firstName}
                  maxLength={40}
                  onChange={(e) => setFirstName(e.target.value)}
                  data-testid="profile-firstname-input"
                />
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-widest font-bold text-white/55 mb-1">City</p>
                <CityAutocomplete
                  value={city}
                  onChange={(v) => { setCity(v); setCityCoords(null); }}
                  onPick={(item) => { setCity(item.value || ""); setCityCoords({ lat: item.lat, lng: item.lng }); }}
                />
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-widest font-bold text-white/55 mb-1">Age</p>
                <input
                  className="n2m-input"
                  inputMode="numeric"
                  value={age}
                  maxLength={3}
                  onChange={(e) => setAge(e.target.value.replace(/\D/g, ""))}
                  data-testid="profile-age-input"
                />
              </div>
              <select
                className="n2m-input"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                data-testid="profile-lang-select"
              >
                {LANG_OPTIONS.map((l) => (
                  <option key={l.code} value={l.code} className="bg-black">{l.name}</option>
                ))}
              </select>
              <div className="flex flex-wrap gap-1.5">
                {EMOJIS.map((e) => (
                  <button
                    key={e}
                    onClick={() => setEmoji(e)}
                    className={`w-10 h-10 rounded-xl text-lg ${emoji === e ? "ring-2 ring-[#FF4D4D] bg-white/10" : "bg-white/5"}`}
                    data-testid={`profile-emoji-${e}`}
                  >{e}</button>
                ))}
              </div>
              <button className="btn-primary" onClick={save} disabled={saving || !canSave} data-testid="profile-save">
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          )}
        </div>
      </div>

      <BottomNav active="profile" onTab={onTab} />
    </motion.div>
  );
}
```

### Smoke test (curl)
```bash
API=$(grep REACT_APP_BACKEND_URL /app/frontend/.env | cut -d= -f2)
# valid
curl -s -X POST "$API/api/users/onboarding" \
  -H "Authorization: Bearer <session_token>" -H "Content-Type: application/json" \
  -d '{"first_name":"Steve","city":"Madrid","age":29,"language":"en","avatar_emoji":"🌙","city_lat":40.4168,"city_lng":-3.7038}'
# → 200, returns updated user

# empty first_name → 400 "First name is required"
# age=10        → 400 "Age must be between 13 and 120"
```

---

## 7. GA4 (`/app/frontend/src/analytics.js`)
Loads gtag.js lazily, disables auto page_view, exposes `track(event, params)` and `pageview(screen)`.

```javascript
const GA_ID = process.env.REACT_APP_GA4_MEASUREMENT_ID;
let _initialized = false;

export function initAnalytics() {
  if (_initialized || !GA_ID || typeof window === "undefined") return;
  _initialized = true;
  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_ID)}`;
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag("js", new Date());
  gtag("config", GA_ID, { send_page_view: false, anonymize_ip: true });
}

export function pageview(screen) {
  if (!GA_ID || typeof window === "undefined" || !window.gtag) return;
  window.gtag("event", "page_view", {
    page_title: screen,
    page_location: window.location.href,
    page_path: `/${screen}`,
  });
}

export function track(event, params = {}) {
  if (!GA_ID || typeof window === "undefined" || !window.gtag) return;
  try { window.gtag("event", event, params); }
  catch (e) { console.error("ga track failed", e); }
}
```

### Events currently fired
`sign_in_started/completed/failed`, `referral_landed`, `onboarding_completed/failed`, `community_rules_accepted/failed`, `video_intro_set`, `face_check_done`, `swipe_like/pass`, `match_made`, `chat_message_sent`, `share_started`, `referral_link_copied`.
**TODO** — mark the bolded ones as **Key Events** in GA4 Admin → Events.

---

## 8. Mongo collections
- **`users`** — `{id, email, google_sub, first_name, handle, codename, city, city_lat, city_lng, age, lat, lng, vibes[], language, avatar_emoji, video_url, source_lang, agreed_to_rules_at, signature_data_url, referrer_handle, referrer_id, referral_count, created_at}`
- **`user_sessions`** — `{user_id, session_token, expires_at, created_at}` (TTL on `expires_at`)
- **`swipes`** — `{actor_id, target_id, action, created_at}`
- **`matches`** — `{user1_id, user2_id, created_at}`
- **`messages`** — `{id, match_id, sender_id, text, source_lang, translated_text, created_at}`

---

## 9. Open backlog
- **P1** Recorded videos use `URL.createObjectURL(blob)` — not persistent. Move to Emergent object storage; post URL to `/api/users/video`.
- **P1** Live translate-as-you-type preview in Chat before send (reuse `/api/translate`).
- **P2** Mark `onboarding_completed`, `community_rules_accepted`, `match_made`, `share_started` as Key Events in GA4.
- **P2** Push/online presence — show which matches are live now.
- **P2** Report / block user.
- **P2** Decommission old Netlify `nice2meechu` site once Emergent SSL stable for ≥7 days.
- **P3** Voice-note replies; audio translation (TTS over translated text).
- **P3** Invite-only friends-of-friends discovery.
- **P3** Split `App.js` into per-screen files once it stops being a single-file brief.

---

## 10. Testing
- Backend pytest: `cd /app/backend && pytest tests/test_n2m_backend.py -q` (4 iterations pass).
- Frontend smoke: `mcp_screenshot_tool` with cookie injection.
- Test credentials: `/app/memory/test_credentials.md` and `/app/auth_testing.md`. To bypass Google OAuth in automation, seed a `user_sessions` row directly and pass `Authorization: Bearer <session_token>`. Demo users (`luna`, `kai`, `rumi`, `sol`, `indie`, `noa`) auto-seed on first `/api/feed`; ~70% auto-match on Like for demo flow.

### Seed a fully-onboarded test user (Python)
```python
import os, uuid, asyncio
from datetime import datetime, timezone, timedelta
from motor.motor_asyncio import AsyncIOMotorClient

async def seed():
    cli = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = cli[os.environ["DB_NAME"]]
    uid, tok = "test-" + uuid.uuid4().hex[:6], "tok-" + uuid.uuid4().hex
    await db.users.insert_one({
        "id": uid, "email": f"{uid}@test.com", "google_sub": uid,
        "first_name": "Demo", "city": "Madrid", "age": 25,
        "handle": "demo.abc", "codename": "Quiet Fox",
        "language": "en", "avatar_emoji": "🌙", "vibes": [],
        "agreed_to_rules_at": datetime.now(timezone.utc).isoformat(),
        "agreed_rules_items": ["r"]*7,
        "signature_data_url": "data:image/png;base64,iVBORw0KGgo=",
        "video_url": "/videos/v1.mp4", "transcript": "hi", "source_lang": "en",
        "onboarding_phase": "done",
    })
    await db.user_sessions.insert_one({
        "user_id": uid, "session_token": tok,
        "expires_at": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),
    })
    print(tok)
asyncio.run(seed())
```

---

## 11. Deploy
Emergent workspace → **Deploy** button → ~10–15 min build. DNS already cut over (162.159.142.117 / 172.66.2.113); SSL auto-provisioned by Cloudflare. Pre-flight via `deployment_agent` — last 5 runs PASS. **The Profile fix above is in preview only — click Deploy to push it to `nice2meechu.com`.**
