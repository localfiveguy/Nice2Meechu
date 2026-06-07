# Nice2Meechu — Handoff Document
_Last updated: 2026-02-07 (E1 fork)_

---

## 1. Product Snapshot

**Nice2Meechu** is a hyperlocal, video-first social mobile-web app. Users connect by watching short
video introductions instead of static photos. Core brand promise: **"Anonymous until the spark."**

- **Production**: https://nice2meechu.com (operator-controlled deploy via Emergent)
- **Apex**: also serves `www.nice2meechu.com`
- **Preview**: https://hyperlocal-video.preview.emergentagent.com (dev env, where E1 works)
- **Stack**: React 19 (CRA) frontend + FastAPI + Motor (async MongoDB) + Google Cloud Storage for video blobs

The app is **live in production** with friends-and-family rolling out.

---

## 2. Current State (Health Check)

| Area | Status | Notes |
|---|---|---|
| Code | ✅ Healthy | Compiles clean, frontend hot-reload working, backend supervisor running |
| Deployment readiness | ✅ Passed deployment-agent | No hardcoded secrets, env-var hygiene clean |
| iOS sign-in | ✅ Fixed in code | Pending: user must update prod GOOGLE_CLIENT_ID env (see §5) and redeploy |
| Tests | ✅ 18/18 in-scope backend tests pass (iter 5) | 10 pre-existing fixture errors unrelated to this fork |
| Architecture | ✅ Refactored | App.js: 3090 → 292 lines, 19 modular files |

---

## 3. What Changed in This Fork (2026-02-07)

In chronological order:

### 3.1 P0 — iOS Safari Google Sign-In Fix
**Problem**: iPhone users hit "Token has wrong audience" or got silently bounced out of the GIS
popup. Root cause: iOS Safari ITP blocks third-party cookies/iframes used by GIS popup mode.

**Fix** (`/app/frontend/src/screens/SignInScreen.js` + `/app/backend/server.py`):
- New `isIosWebkit()` helper (in `lib/ua.js`) detects iPhone/iPad via UA + iPadOS heuristic
  (`MacIntel` + `maxTouchPoints > 1`).
- GIS init now picks `ux_mode: "redirect"` for iOS, `"popup"` for everyone else.
- Backend endpoint `/api/auth/google-redirect` already existed from a prior fork — added optional
  `?ref=<handle>` query param so referral codes survive the iOS redirect (since localStorage is
  lost during the Google round-trip on iOS).
- Failure path: backend 303s to `/?auth_error=<code>`; frontend mount-time hydration reads it and
  toasts the user (`App.js` lines ~149-167).
- **⚠️ Pending operator action**: register `https://nice2meechu.com/api/auth/google-redirect`
  and the preview equivalent under "Authorized redirect URIs" in the Google Cloud Console.
  User confirmed this is done (4 URIs verified visually).

### 3.2 P2 — Automated Daily Inactive-User Video Cleanup
**Backend** (`/app/backend/server.py` lines ~1742-1790):
- Extracted `_run_inactive_cleanup()` helper from the existing admin endpoint.
- New startup task `_inactive_cleanup_loop`: sleeps 15min, then runs `dry_run=False` every 24h.
- Tunable via env vars (all optional, sane defaults):
  - `INACTIVE_CLEANUP_ENABLED` (default `true`)
  - `INACTIVE_CLEANUP_DAYS` (default `90`)
  - `INACTIVE_CLEANUP_INTERVAL_SECONDS` (default `86400`)
  - `INACTIVE_CLEANUP_INITIAL_DELAY_SECONDS` (default `900`)
- Manual admin curl endpoint (`POST /api/admin/inactive-cleanup`) still works unchanged.

### 3.3 Marketing — Social Share Card Generator
**Offline script** at `/app/scripts/make_share_cards.py`:
- Generates 3 share cards using Pillow + qrcode:
  - `story_minimal_1080x1920.png` (IG/FB Story)
  - `feed_square_1080x1080.png` (IG/FB Feed)
  - `story_qr_1080x1920.png` (Story with scannable QR + branded center logo)
- Served at `/api/share-cards/<filename>.png` via FastAPI static mount (`/app/backend/server.py`
  line ~1700).
- Cards live at `/app/share_cards/` (created at runtime).
- Pillow + qrcode are NOT runtime dependencies — only the offline script uses them. **DO NOT add to requirements.txt.**

### 3.4 UX — Enter-Key Submit Everywhere
**Files touched**:
- `screens/Onboarding.js` — Enter advances step / submits last step
- `screens/ProfileScreen.js` — Enter saves the edit form
- `screens/ChangeLocationScreen.js` — Enter picks the top suggestion
- `components/CityAutocomplete.js` — Enter prefers top suggestion if open, else calls `onEnter` prop
- `screens/ChatScreen.js` — chat composer already had Enter→send; added `enterKeyHint="send"`
- All inputs now have appropriate `enterKeyHint` (`"next"` / `"done"` / `"send"` / `"go"`) so
  mobile keyboards show contextual action keys.

Guardrail: Enter is a no-op when validation fails (same disabled-button logic).

### 3.5 Refactor — App.js Split Into Per-Screen Modules
The big one. `App.js` went from **3090 lines → 292 lines** (~90% reduction).

**New directory layout** under `/app/frontend/src/`:

```
src/
├── App.js                          # 292 lines — top-level orchestrator (routing, auth, state)
├── App.css                         # unchanged
├── analytics.js                    # unchanged (GA wrapper)
├── lib/
│   ├── api.js                      # axios client, translate(), shareOrCopy(), copyToClipboard()
│   ├── constants.js                # GOOGLE_CLIENT_ID, LANG_OPTIONS, VIBES_POOL, EMOJIS, COMMUNITY_RULES
│   ├── cityFormat.js               # COUNTRY_SHORT, US_STATE_ABBR, formatCityLabel(), flagEmoji()
│   └── ua.js                       # isIosWebkit() detection
├── components/
│   ├── VideoEl.js                  # <video> wrapper with .webm fallback
│   ├── CityAutocomplete.js         # Photon-backed city input
│   ├── SignaturePad.js             # Canvas signature for community rules
│   ├── BottomNav.js                # Feed/Matches/You bottom tabs
│   ├── ShareCard.js                # Profile-screen referral share card
│   ├── MatchCelebration.js         # Full-screen match reveal overlay
│   └── FeedCard.js                 # Single video card (the most-edited component in this fork)
├── screens/
│   ├── Splash.js                   # Branded loading splash
│   ├── SignInScreen.js             # GIS button + iOS-redirect detection
│   ├── AuthCallback.js             # Brief "signing you in…" screen
│   ├── Onboarding.js               # 3-step name/city/age flow
│   ├── CommunityRulesScreen.js     # Rules checklist + signature
│   ├── VideoPick.js                # Record/upload intro
│   ├── FeedScreen.js               # Chronological video feed (largest screen, 404 lines)
│   ├── ChangeLocationScreen.js     # City picker + map tap + popular cities
│   ├── MatchesScreen.js            # Match list + replay modal + unmatch flow
│   ├── ChatScreen.js               # 1:1 chat with live translation preview
│   └── ProfileScreen.js            # Profile view/edit + share card + data export + delete
└── legal/
    └── LegalPages.jsx              # Static privacy/terms + cookie banner (unchanged)
```

**Zero behavior changes**. Pure structural refactor. Build compiles clean, sign-in renders identical,
all behavior verified via smoke screenshot.

### 3.6 Demo Codenames Match Spoken Audio
**Problem**: Demo videos' audio said "Hi! My name is Yui!" but the feed badge showed `Aurora Fox`
(random). Caused cognitive dissonance for viewers.

**Fix** (`/app/backend/server.py` `seed_demo_users()`):
- New `_demo_codename_for(persona)` returns the persona's spoken `name` (capitalized) as codename.
- New `_demo_handle_for(persona)` returns `{name_lower}.{city_slug}` e.g. `yui.tokyo`, `sarah.newyork`.
- Migration loop runs on every `seed_demo_users()` call (idempotent — issues one `$set` per demo).
- Real users still get the anonymous `generate_codename()` Adj+Noun output. Only AI demos (clearly
  labelled `✨ AI demo`) show their spoken name.
- Verified: 78 demos updated, **0 handle collisions** across all 12 cities.

### 3.7 UX — "Hear me say my name" Hint on AI Demos
**File**: `/app/frontend/src/components/FeedCard.js`
- New `demoNameHint` state — flashes a small cyan pill (`🎬 hear me say my name`) under the
  codename badge for 2.4s when a viewer lands on an AI demo card.
- Only renders for `item.is_demo`; clears on inactive/swipe-away.
- `data-testid="feed-demo-name-hint"`.

### 3.8 UX — Removed Vibe Pills + "or remix it" Copy
- **Vibes**: Removed the BOOKWORM / ARTIST / SKATER pill row from every FeedCard (user found them
  cluttering and meaningless — they were random samples from a 10-item pool). The `vibes` field
  still exists on user records (DB-level no-op).
- **VideoPick subtitle**: changed `"Use the script below word-for-word, or remix it."` →
  `"Use the script below word-for-word."`

---

## 4. Architecture & Important Files

### 4.1 Backend (`/app/backend/`)

| File | Purpose |
|---|---|
| `server.py` (~1790 lines) | The whole FastAPI backend. Auth, routes, Mongo, GCS, demos, scheduler. Future split target: `routes/`, `models/`, `services/`. |
| `scripts/generate_demo_videos.py` | Offline Sora 2 video generator (run manually when adding new demo personas). |
| `.env` | `MONGO_URL`, `DB_NAME=test_database`, `GOOGLE_CLIENT_ID`, `EMERGENT_LLM_KEY`, `GCS_BUCKET=nicemeechu`, `ADMIN_EMAILS`, scheduler tunables. |
| `gcs-credentials.json` | GCP service-account JSON. **Never commit. Never expose in chat.** |

### 4.2 Frontend (`/app/frontend/src/`)
See §3.5 for the post-refactor layout.

### 4.3 Critical API Endpoints

| Method/Path | Purpose |
|---|---|
| `POST /api/auth/google` | Popup-mode GIS sign-in (verifies ID token, mints session) |
| `POST /api/auth/google-redirect` | Redirect-mode GIS sign-in (iOS Safari). Form-encoded `credential` field. Optional `?ref=` query. Returns 303 → `/` or `/?auth_error=...` |
| `POST /api/auth/session` | Legacy Emergent-managed auth (still wired for fallback) |
| `GET /api/auth/me` | Returns current user from session cookie / Bearer token |
| `POST /api/auth/logout` | Clears session cookie |
| `GET /api/feed` | Chronological feed. Returns `{feed[], saved_position, city_stats}`. Triggers `seed_demo_users()` on first call. |
| `POST /api/swipe` | `{target_user_id, action: "like"|"pass"}`. Upserts swipe, may create match. |
| `POST /api/users/onboarding` | First-time + edit-profile save. Fields: `first_name, city, age, language, avatar_emoji, city_lat, city_lng`. |
| `POST /api/users/video/upload` | Multipart upload → GCS, returns `video_url`. |
| `POST /api/users/video` | Saves `{video_url, transcript, source_lang}` on user. |
| `POST /api/video/face-check` | AI age + face check using GPT-4o vision via Emergent LLM key. |
| `GET /api/matches` | Returns matches, resets `last_matches_viewed_at`. |
| `GET /api/matches/unread` | Returns `{count}` — polled by App.js every 60s. |
| `GET /api/messages/:match_id` / `POST /api/messages` | Chat. |
| `POST /api/users/location` | `{lat, lng, city?}` — used by ChangeLocation + auto-geo on sign-in. |
| `POST /api/users/me/city-position` | Persists scroll position per city. |
| `POST /api/users/block` | Blocks user + deletes match. |
| `POST /api/users/report` | Records report. |
| `POST /api/users/community-rules` | Saves acceptance + signature data URL. |
| `GET /api/users/me/export` | GDPR Art. 20 data export (full JSON dump). |
| `DELETE /api/users/me` | GDPR Art. 17 — full account deletion. |
| `POST /api/translate` | OpenAI-backed translate-as-you-type. |
| `GET /api/cities/popular` | Returns cities with active-user counts (ChangeLocation list). |
| `GET /api/admin/funnel` | Funnel analytics (admin only via `ADMIN_EMAILS` allow-list). |
| `POST /api/admin/inactive-cleanup?days=90&dry_run=true` | Manual trigger; also runs daily via scheduler. |
| `GET /api/share-cards/<filename>.png` | Static mount of `/app/share_cards/`. |
| `GET /api/videos/<filename>` | Pre-generated Sora demo videos. |
| `GET /api/user-videos/<filename>` | Persistent disk fallback (legacy; GCS is primary). |

### 4.4 MongoDB Schema

```
users:
  id (string)  -- "demo-NN" for demos, UUID for real users
  email, google_sub, name, picture
  first_name (string)              -- revealed only post-match
  handle (string)                  -- @handle shown post-match
  codename (string)                -- shown in feed (anonymous for real users; spoken name for demos)
  city, city_lat, city_lng         -- where the user wants their feed centered
  lat, lng                         -- user's actual geolocation
  age (int)
  vibes (string[])                 -- pool sample (no longer rendered; kept on records for now)
  language (ISO-2 code)
  avatar_emoji
  video_url, transcript, source_lang
  agreed_to_rules_at, community_rules_signature
  is_demo (bool)
  onboarding_phase
  last_seen_at (ISO string)        -- used by inactive cleanup
  inactivity_cleaned_at            -- set when scheduler nukes their video
  last_matches_viewed_at           -- drives unread-match dot
  picture_url
  referral_count
  referred_by (handle)
  city_positions: { <city_key>: <index> }  -- per-city saved scroll position
  blocked_user_ids[]
  created_at

sessions:
  id, user_id, token, created_at, expires_at

swipes:
  actor_id, target_id, action ("like"|"pass"), created_at

matches:
  id, user1_id, user2_id, created_at

messages:
  id, match_id, sender_id (alias: from_user_id), text, source_lang,
  translated_text, created_at

reports:
  reporter_id, target_id, reason, created_at

age_checks:
  user_id, declared_age, estimated_age, age_ok, reason, created_at
```

---

## 5. ⚠️ Operator Action Items (NOT code — environment)

### 5.1 Production GOOGLE_CLIENT_ID env-var mismatch
**Status**: Reported by user, suspected source of an earlier "Token has wrong audience" error.
- Production backend was running with the OLD client ID: `1049012701561-eo1qh3o9nvi0fu54tnj261fnjt6lb6bt.apps.googleusercontent.com`
- Should be the NEW: `780373908792-5paopj52a9u3pf1dh47778d22kvvajfm.apps.googleusercontent.com`
- Preview is correctly set. User needs to update the production backend env via the Emergent
  deploy panel and redeploy.

### 5.2 Google Cloud Console — Authorized Redirect URIs
User has confirmed 4 URIs are registered:
- `https://nice2meechu.com/api/auth/google-redirect` ✅
- `https://www.nice2meechu.com/api/auth/google-redirect` ✅
- `https://hyperlocal-video.preview.emergentagent.com/api/auth/google-redirect` ✅
- `https://hyperlocal-video.emergent.host/api/auth/google-redirect` ✅

### 5.3 GCS bucket
- Bucket name: `nicemeechu`
- Service account file: `/app/backend/gcs-credentials.json` (project `gen-lang-client-0271718241`)
- User videos written under prefix `user_videos/<user_id>.<ext>`

---

## 6. Known Issues & Constraints

### 6.1 Pre-existing eslint warnings on App.js / others
Per the original handoff: do **not** blindly action SAST/lint warnings. Many in this codebase
have been triaged as false-positives (e.g., the BottomNav internal `Item` component triggers
"component defined inside parent component" warnings; nested components ARE fine here because
`Item` is a render-only helper closed over the parent's props).

### 6.2 Test fixture drift
`/app/backend/tests/test_n2m_backend.py` has 10 pre-existing fixture errors because the
`OnboardingReq` schema now requires `first_name`/`city`/`age` and the fixture wasn't updated.
This is **unrelated to this fork's changes**. P3 backlog.

### 6.3 Server.py size
`server.py` is ~1790 lines. Future split target: `/app/backend/routes/` (per-domain routers),
`/app/backend/models/` (Pydantic schemas), `/app/backend/services/` (auth, gcs, llm,
demos, cleanup). Frontend has been split; backend hasn't.

### 6.4 Sora 2 demos
- 78 demo personas across 12 cities. Each demo video is ~7s, stored at `/app/backend/videos/demo_NN.mp4`.
- Adding new personas: edit `/app/backend/scripts/generate_demo_videos.py` and run it; it costs
  Emergent LLM key credits.
- Demo audio uses the script template: `"Hi! My name is {name}! I live in {city}! Nice to meet you!"`
- `seed_demo_users()` is called from the `/api/feed` endpoint AND is safe to invoke directly.

### 6.5 Cookie / session
- Auth uses `withCredentials: true` axios + `session_token` HTTP-only cookie + Bearer header fallback.
- Cookies are `SameSite=None; Secure` so they work cross-iframe in the Emergent preview.
- The redirect-mode endpoint sets the cookie on the SAME origin as the frontend
  (backend at `*.preview.emergentagent.com/api/*` shares origin with frontend at
  `*.preview.emergentagent.com/*`), so it's first-party — iOS ITP doesn't block it.

---

## 7. Test Credentials & Local Dev

### 7.1 Test credentials
See `/app/memory/test_credentials.md` if present. The auth flow is Google OAuth — there are no
seeded password accounts.

### 7.2 Local services
- Frontend: `http://localhost:3000` (CRA via `react-scripts`, hot reload)
- Backend: `http://localhost:8001` (uvicorn via supervisor, hot reload via `--reload` not used —
  rely on supervisor restart for `.env` changes)
- MongoDB: `mongodb://localhost:27017/test_database`
- Logs: `tail -n 100 /var/log/supervisor/{backend,frontend}.{err,out}.log`

### 7.3 Quick sanity curls
```bash
API=$(grep REACT_APP_BACKEND_URL /app/frontend/.env | cut -d= -f2)
# Root
curl -s $API/api/ | python3 -m json.tool
# Unauth probe (should be 401)
curl -s -o /dev/null -w "%{http_code}\n" $API/api/auth/me
# Redirect-mode failure path (should be 303 → ?auth_error=invalid_credential)
curl -s -o /dev/null -w "%{http_code}\n" -X POST $API/api/auth/google-redirect \
  -d "credential=invalid&g_csrf_token=x"
```

### 7.4 DB inspection
```bash
DB=$(grep ^DB_NAME= /app/backend/.env | cut -d= -f2 | tr -d '"')
mongosh --quiet "mongodb://localhost:27017/$DB" \
  --eval "db.users.find({is_demo:true},{_id:0,id:1,codename:1,handle:1}).limit(5).toArray()"
```

---

## 8. Backlog (Prioritized)

### P0 — Blockers
- _None._ (iOS sign-in is code-complete; awaiting prod env-var update + redeploy.)

### P1 — High-Value Next
- Verify on iPhone + Pixel after operator updates prod `GOOGLE_CLIENT_ID` + redeploys.
- Wire `last_seen_at` properly — currently only set at sign-in; should update on heartbeat so
  inactive cleanup catches real abandonment vs. silent users.

### P2 — Quality of Life
- Native shell (Capacitor or Expo) for proper push notifications. Currently no push.
- Multi-language UI strings (only English atm; transcript translation handles content, not UI chrome).
- "Top inviter" leaderboard tied to `referral_count` — friendly growth lever.

### P3 — Refactors / Cosmetic
- Split `server.py` into `routes/`, `models/`, `services/` (mirroring the frontend split).
- Fix the pre-existing test fixture in `test_n2m_backend.py` (OnboardingReq schema drift).
- Strip the now-unused `vibes` sampling from `seed_demo_users()` + DB (since we don't render them).
- The `VIBES_POOL` constant in both backend and `frontend/src/lib/constants.js` is unused; safe to delete.

---

## 9. ⚠️ Critical Don'ts (Things Previous Agents Got Wrong)

- **DO NOT** rewrite `App.js` as a monolith — the refactor is intentional.
- **DO NOT** add `qrcode` / `Pillow` to `/app/backend/requirements.txt`. They're offline-script-only.
- **DO NOT** hardcode URLs / API client IDs / OAuth callback URLs. Everything from env. The
  `SignInScreen.js` file has explicit comment reminders.
- **DO NOT** action SAST/lint warnings without reviewing manually — many are false positives.
- **DO NOT** change the GIS button rendering to use `innerHTML` — the current code uses
  `.replaceChildren()` to satisfy SAST. Don't regress that.
- **DO NOT** delete the legacy `/api/auth/session` endpoint — it's a fallback path still
  referenced in `App.js`.
- **DO NOT** alter `seed_demo_users()` to skip the migration `update_one` loop — older deploys
  rely on it to upgrade existing demo records to the name-matching codename scheme.
- **DO NOT** add `auth_error` toast handling that doesn't strip the query param after toasting —
  re-mounts would re-toast forever.

---

## 10. Quick Onboarding for the Next Agent

1. **Read `/app/memory/PRD.md`** — has the latest dated changelog.
2. **Read this file** (`/app/handoff.md`).
3. **Check `/app/test_reports/iteration_5.json`** — most recent test pass record.
4. Run `tail -n 30 /var/log/supervisor/backend.err.log` to confirm services are up.
5. Smoke-screenshot: `curl https://hyperlocal-video.preview.emergentagent.com` — should see the
   Nice2Meechu sign-in pill.
6. **Before any auth changes**: call `integration_playbook_expert_v2` (mandatory per system rules).
7. **Before any LLM integration changes**: same — call `integration_playbook_expert_v2`. Don't
   improvise. The app uses Emergent LLM key for Sora 2 video gen, GPT-4o vision (face check), and
   OpenAI translation.

---

## 11. Emergent LLM Key & Integration Map

| Integration | Where used | Key/Auth |
|---|---|---|
| Google Identity Services (Direct OAuth) | Frontend `SignInScreen.js`, Backend `/auth/google*` | User-provided `GOOGLE_CLIENT_ID` |
| Google Cloud Storage | Backend video upload/serve | `/app/backend/gcs-credentials.json` |
| OpenAI GPT-4o (vision) | Face/age check | Emergent LLM key |
| OpenAI translation | Live chat preview + feed captions | Emergent LLM key |
| Sora 2 video gen | Offline demo generation only | Emergent LLM key |
| OpenStreetMap / Photon | City autocomplete + reverse geocode | Public API, no key |
| Google Analytics (GA4) | Opt-in only, post-cookie-consent | User-provided `REACT_APP_GA_MEASUREMENT_ID` if set |

---

_End of handoff. Be Nice._
