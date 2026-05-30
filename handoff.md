# Nice2Meechu — Handoff (with code)

## 1. Live URLs
- **Production:** https://nice2meechu.com (Emergent deploy; Network Solutions DNS → A `@` 162.159.142.117 + 172.66.2.113, CNAME `www` → nice2meechu.com)
- **Preview/dev:** https://hyperlocal-video.preview.emergentagent.com

## 2. Stack
- FastAPI + React (CRA via craco) + MongoDB. All backend routes prefixed `/api`.
- Backend: `/app/backend/server.py` (~900 lines, single-file) · env: `/app/backend/.env` (`MONGO_URL`, `DB_NAME`, `CORS_ORIGINS`, `EMERGENT_LLM_KEY`)
- Frontend: `/app/frontend/src/App.js` (~1640 lines, single-file), `index.css`, `analytics.js` · env: `/app/frontend/.env` (`REACT_APP_BACKEND_URL`, `REACT_APP_GA4_MEASUREMENT_ID=G-VLT66KELPL`)
- Sample videos: `/app/frontend/public/videos/v{1..6}.{mp4,webm}` → served at `/videos/...`.
- Supervisor: `sudo supervisorctl restart {backend|frontend}` after `.env`/deps; hot-reload otherwise. Use **yarn**, never npm.

## 3. Auth — Emergent-managed Google OAuth
Frontend redirects to `https://auth.emergentagent.com/?redirect=<origin>`; on return, backend exchanges `session_id` at `https://demobackend.emergentagent.com/auth/v1/env/oauth/session-data`. Sessions stored in `user_sessions` (7-day TTL). `current_user` reads httpOnly cookie `session_token` first, then `Authorization: Bearer` (test harness). First name auto-prefilled from Google `name`.

## 4. Key API endpoints
- `POST /api/auth/session` (body `{session_id, ref?}` — ref attributes referral)
- `GET  /api/auth/me`  ·  `POST /api/auth/logout`
- `POST /api/users/onboarding` (first_name, city, age, city_lat?, city_lng?, vibes?, language?, avatar_emoji?)
- `POST /api/users/community-rules` (7 items + signature data-URL)
- `POST /api/users/location` (lat, lng)  ·  `POST /api/users/video`
- `GET  /api/feed`  ·  `POST /api/swipe`  ·  `GET /api/matches`  ·  `GET/POST /api/messages` (parallel translate via `asyncio.gather` + `bulk_write` cache)
- `POST /api/translate`  ·  `POST /api/video/face-check` (GPT-4o-mini Vision, fail-open)
- `GET  /api/og/<handle>` (Pillow + pilmoji 1200×630, in-process cache)

## 5. Screen flow (single-file App.js)
Splash → SignIn / AuthCallback → **Onboarding** (name → city w/ Photon autocomplete → age) → **Community Rules** (7 checkboxes + signature canvas) → **Video Pick** (dynamic script with `{first_name}` + `{city}`, ⚠️ warning, AI face-check w/ "✨ Verifying your video…" badge) → Feed / Matches / Chat (live translation, EN→ES badge) / **Profile** (Share card → `/api/og/<handle>`).

## 6. GA4 events (already firing)
`sign_in_started/completed/failed`, `referral_landed`, `onboarding_completed/failed`, `community_rules_accepted/failed`, `video_intro_set`, `face_check_done`, `swipe_like/pass`, `match_made`, `chat_message_sent`, `share_started`, `referral_link_copied`. Mark the bolded ones as **Key Events** in GA4 Admin → Events.

## 7. Mongo collections
- `users`: `{id, email, google_sub, first_name, handle, codename, city, city_lat, city_lng, age, lat, lng, vibes[], language, avatar_emoji, video_url, source_lang, agreed_to_rules_at, signature_data_url, referrer_handle, onboarding_phase}`
- `user_sessions`: `{user_id, session_token, expires_at}` (TTL index on `expires_at`)
- `swipes`: `{actor_id, target_id, action}`  ·  `matches`: `{user1_id, user2_id, created_at}`
- `messages`: `{id, match_id, sender_id, text, source_lang, translated_text, created_at}`

---

## 8. 🔴 P0 OPEN BUG — Profile edit "Couldn't save"
The `ProfileScreen` edit form still posts the **old** payload (`handle`, `vibes`, `language`, `avatar_emoji`), but `/api/users/onboarding` now **requires** `first_name`, `city`, `age` (validation: 13 ≤ age ≤ 120, non-empty first_name). Backend correctly 400s → toast `"Couldn't save"`.

### 8a. Backend source of truth — `/app/backend/server.py`
```python
# ----- model (line ~74) -----
class OnboardingReq(BaseModel):
    first_name: str
    city: str
    age: int
    city_lat: Optional[float] = None
    city_lng: Optional[float] = None
    vibes: List[str] = []
    language: str = "en"
    avatar_emoji: Optional[str] = "🌙"

# ----- endpoint (line ~288) -----
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

### 8b. ❌ Current BROKEN frontend code — `/app/frontend/src/App.js` line ~1500
```jsx
function ProfileScreen({ user, setUser, onTab, onLogout, onChangeVideo }) {
  const [editing, setEditing] = useState(false);
  const [handle, setHandle] = useState(user.handle);          // ← OLD
  const [vibes, setVibes] = useState(user.vibes);             // ← OLD
  const [language, setLanguage] = useState(user.language);
  const [emoji, setEmoji] = useState(user.avatar_emoji);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const { data } = await api.post("/users/onboarding", {
        handle: handle.trim(), vibes, language, avatar_emoji: emoji,   // ← missing first_name/city/age → 400
      });
      setUser(data.user);
      setEditing(false);
      toast.success("Saved");
    } catch {
      toast.error("Couldn't save");
    } finally { setSaving(false); }
  };
  /* ...rest of JSX: edit block has handle input + VIBES_POOL pills, no city/age inputs... */
}
```

### 8c. ✅ Drop-in FIX (replace lines ~1500–1617 in `App.js`)
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
        <VideoEl src={user.video_url} autoPlay loop muted playsInline className="absolute inset-0 w-full h-full object-cover" />
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
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center bg-white/8 text-2xl">{user.avatar_emoji}</div>
            <div>
              <div className="text-xs uppercase tracking-widest font-bold text-white/50">codename · {user.codename}</div>
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
                <Globe size={12} /> Native: {LANG_OPTIONS.find((l) => l.code === user.language)?.name || user.language}
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
                {LANG_OPTIONS.map((l) => <option key={l.code} value={l.code} className="bg-black">{l.name}</option>)}
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
              <button
                className="btn-primary"
                onClick={save}
                disabled={saving || !canSave}
                data-testid="profile-save"
              >
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

### 8d. How to verify the fix
1. Restart not needed — frontend hot-reloads.
2. Curl smoke (preview env, seed a session row first):
   ```bash
   API=$(grep REACT_APP_BACKEND_URL /app/frontend/.env | cut -d= -f2)
   curl -X POST "$API/api/users/onboarding" \
     -H "Authorization: Bearer <session_token>" -H "Content-Type: application/json" \
     -d '{"first_name":"Steve","city":"Madrid","age":29,"language":"en","avatar_emoji":"🌙"}'
   # expect 200 + {"user": {...first_name:"Steve", city:"Madrid", age:29...}}
   ```
3. UI: open `/profile` → Edit → change first name/city/age → Save → toast "Saved", view mode shows new values.

---

## 9. Reference — working Onboarding pattern (uses same payload shape)
`/app/frontend/src/App.js` line ~376:
```jsx
const { data } = await api.post("/users/onboarding", {
  first_name: firstName.trim(),
  city: city.trim(),
  age: ageNum,
  language: browserLang,
  city_lat: cityCoords?.lat ?? null,
  city_lng: cityCoords?.lng ?? null,
});
```
`CityAutocomplete` at line ~494 hits `https://photon.komoot.io/api/?q=<q>&limit=6&osm_tag=place:city`; calls `onPick({ value, lat, lng })`.

---

## 10. Open backlog
- **P1** Recorded videos stored as `URL.createObjectURL(blob)` — not persistent. Move to Emergent object storage and post URL to `/api/users/video`.
- **P1** Live translate-as-you-type preview in Chat before sending (reuse `/api/translate`).
- **P2** Mark `onboarding_completed`, `community_rules_accepted`, `match_made`, `share_started` as Key Events in GA4.
- **P2** Decommission old Netlify `nice2meechu` site once Emergent SSL stable for ≥7 days.
- **P2** Optional: split `App.js` into screen files (`screens/Profile.jsx`, etc.) — currently single-file per original brief.

## 11. Testing
- Backend pytest: `cd /app/backend && pytest tests/test_n2m_backend.py -q` (passes 4 iterations).
- Frontend: `mcp_screenshot_tool` for smoke; `testing_agent_v3_fork` for multi-flow.
- Test credentials: see `/app/memory/test_credentials.md` and `/app/auth_testing.md` — seed `user_sessions` directly with `Authorization: Bearer <token>` for automation. Demo users (`luna`, `kai`, `rumi`, `sol`, `indie`, `noa`) auto-seed on first `/api/feed`; ~70% auto-match on Like for demo.

## 12. Deploy
Emergent workspace → **Deploy** button → ~10–15 min build. DNS already cut over to Emergent (162.159.142.117 / 172.66.2.113); SSL auto-provisioned by Cloudflare. Pre-flight via `deployment_agent` — last 5 runs PASS. The Profile fix above will only reach `nice2meechu.com` after you click Deploy.
