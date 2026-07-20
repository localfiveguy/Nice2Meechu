# Nice2Meechu — Complete Engineering Handoff
_Last updated: 2026-06 (E1 fork — SIWA + store distribution session)_
_Download anytime: `GET /api/handoff.md` (served fresh from `/app/handoff.md`)_

---

## 1. Product Snapshot

**Nice2Meechu** — a hyperlocal, video-first social app. Users connect through
7-second video introductions instead of profile photos.
Tagline: **"Meet the world. Video-first. Anonymous until the spark."**

- **Production**: https://nice2meechu.com (+ `www.nice2meechu.com`) — deployed via Emergent
- **Preview (dev)**: https://hyperlocal-video.preview.emergentagent.com
- **Stack**: React 19 (CRA + craco) · FastAPI · Motor (async MongoDB) · Google Cloud Storage
- **Status**: LIVE in friends-and-family rollout; Play Store + App Store submissions in progress

### Core product rules
1. **Anonymity until match** — users are shown by codename (e.g. "Cosmic Phoenix")
   until a mutual "nice2meechu" (like) creates a match.
2. **Strict hyperlocal feed** — your feed starts in YOUR town. Locals first,
   then real people within your nearby-radius (default 10 km, expandable to 25 km).
3. **Video-first** — one 7-second intro video is the whole profile.
4. **Honest AI** — demo profiles exist only to make the app feel alive in big
   metros; they are always badged "✨ AI DEMO" and never mixed into small towns.

### The operator (user)
- Steven (Steavin) Rice, non-technical, needs click-by-click guidance.
- Devices: **iPhone + iPad 10.2 + Windows 11 desktop. NO MAC** — all Apple
  workflows must be browser-based (App Store Connect web + Codemagic cloud builds).
- Apple Developer Team ID: `J99N4XLB3D`. Google Play developer account: in progress.

---

## 2. Environments & Deploy Workflow

| | Preview | Production |
|---|---|---|
| URL | hyperlocal-video.preview.emergentagent.com | nice2meechu.com |
| DB | local MongoDB (MONGO_URL in backend/.env) | Emergent-managed Atlas |
| Agent access | full | **NONE** — code-only fixes, user must redeploy |

- **ALWAYS ask which environment a bug is on.** Preview and production have
  completely separate databases — data-shape bugs can exist in prod only
  (see §15, demo-location corruption).
- Deploys: user clicks **Deploy** in Emergent UI. Deployment health probes hit
  `GET /health` (no `/api` prefix) on backend port 8001 — that route exists in
  `server.py` and MUST NOT be removed (its absence caused a failed prod deploy).
- Services run under supervisor: backend on `0.0.0.0:8001`, frontend on `3000`.
  Restart only after .env changes or dependency installs:
  `sudo supervisorctl restart backend frontend`.

---

## 3. Architecture

### Backend — `/app/backend` (modular FastAPI)
| File | Responsibility |
|---|---|
| `server.py` | Entrypoint. FastAPI app, `/health`, CORS (explicit allowlist from `CORS_ORIGINS`), mounts all routers under `/api`, static mounts, startup migrations |
| `core.py` | Shared: db client, env constants, `SESSION_TTL` (7 days), `generate_codename()`, logger |
| `models.py` | All Pydantic request models (length caps on text fields) |
| `auth.py` | Google GIS token verify, **Sign in with Apple** (JWKS verify), legacy Emergent session exchange, session mint/logout/me |
| `users.py` | Onboarding, location change, nearby-radius, GDPR delete + export, report/block, GCS video upload |
| `feed.py` | `/cities/popular`, `/feed` (locals + nearby), `/swipe` (like/pass/unlike + match creation), `/matches` |
| `messaging.py` | Chat messages, unread counts, `/translate` (LLM, auth-required) |
| `media.py` | Face-check (LLM), OG share cards (bounded cache), `/handoff.md` download |
| `demos.py` | 78 AI demo personas: seeding, alignment + **location healing**, `/demos/sample` |
| `admin.py` | Funnel stats + inactive cleanup (gated by `ADMIN_EMAILS`) |
| `push.py` | VAPID web push: subscribe/unsubscribe/status/public-key |

### Frontend — `/app/frontend/src`
- `App.js` — orchestrator: routing, session bootstrap, push deep links (`?chat=<match_id>`)
- `lib/` — `api.js` (axios + Bearer/localStorage token), `push.js`, `constants.js`,
  `cityFormat.js`, `ua.js` (iOS detection), dropdown-placement hooks
- `screens/` — Splash, SignInScreen, AuthCallback, Onboarding, CommunityRulesScreen,
  VideoPick, FeedScreen, ChangeLocationScreen (Leaflet map), MatchesScreen,
  ChatScreen, ProfileScreen
- `components/` — FeedCard, AppleSignInButton, CityAutocomplete, DemoPeekWidget,
  BottomNav, MatchCelebration, ShareCard, AvatarThumb, VideoEl, EmptyFeedState,
  NotifyMeButton, IOSInstallSheet, SignaturePad, plus `ui/` (shadcn)
- `public/sw.js` — service worker: push display + notification click deep-linking
- `legal/LegalPages.jsx` — privacy (`/privacy`), terms, community rules

### Key dependencies
- Backend: fastapi, motor, pywebpush/py-vapid, PyJWT (Apple), google-auth (Google),
  httpx (geocoder), google-cloud-storage, emergentintegrations (LLM), Pillow (share cards)
- Frontend: react-router-dom, framer-motion, leaflet, axios, sonner, lucide-react, shadcn/radix

---

## 4. Authentication (three ways in, one session system)

1. **Google (primary)** — Google Identity Services.
   - Desktop/Android: popup → `POST /api/auth/google` `{credential}`
   - iOS Safari: redirect mode → `POST /api/auth/google-redirect` (form) →
     `GET /auth-callback#token=...` (URL fragment; ITP drops cookies)
   - Verified server-side via `google.oauth2.id_token` against `GOOGLE_CLIENT_ID`.
2. **Apple (required by App Store)** — `AppleSignInButton.js` lazily loads Apple JS
   SDK, popup mode, `redirectURI = window.location.origin + "/"`.
   → `POST /api/auth/apple` `{id_token, name?, ref?}` — PyJWT `PyJWKClient` verifies
   RS256 signature against `https://appleid.apple.com/auth/keys`, audience =
   `APPLE_SERVICE_ID` (currently `nice2meechu.app.web`), issuer = appleid.apple.com.
   - Account link order: `apple_sub` → email match (links Apple to existing Google
     account) → create new.
   - **"Hide My Email" trap**: private-relay emails create duplicate accounts if the
     user previously joined via Google. UI hint under the button warns about this.
     No server-side merge flow exists yet (manual DB fix was done once for Steven).
   - Button renders ONLY when `REACT_APP_APPLE_SERVICE_ID` is set.
3. **Legacy** — `POST /api/auth/session` (Emergent-managed session exchange). Kept
   for old sessions; new sign-ins don't use it.

**Sessions**: `secrets.token_urlsafe` token in `user_sessions` collection, TTL 7 days.
Sent as httpOnly cookie (`session_token`, SameSite=None, Secure) AND returned in the
JSON body; frontend stores in `localStorage("n2m_token")` and sends
`Authorization: Bearer` — this dual path is a **deliberate iOS Safari workaround**
(do NOT "fix" localStorage away; iPhone login breaks without it).

**Apple Developer config (user's account)**
- App ID: `com.nice2meechu.app` (explicit, SIWA capability ✔)
- Services ID: `nice2meechu.app.web` — domains `nice2meechu.com` +
  `hyperlocal-video.preview.emergentagent.com`; return URLs = both origins + `/`
- No .p8 SIWA key needed (popup flow verifies the identity token directly).

---

## 5. Data Model (MongoDB collections)

- `users` — `{id (uuid), email, name, first_name, picture, google_sub?, apple_sub?,
  codename, handle, avatar_emoji, vibes[], language, home_city, home_lat, home_lng,
  city, city_lat, city_lng, lat, lng, nearby_radius_km (10 default),
  video_url, transcript, source_lang, is_demo?, demo_age?,
  referrer_handle, referrer_id, referral_count, push_subs[], rules_accepted_at,
  created_at, last_active_at}`
- `user_sessions` — `{user_id, session_token, expires_at}`
- `swipes` — `{user_id, target_user_id, action: like|pass, created_at}` (unlike = delete)
- `matches` — `{id, user_ids: [a, b], created_at}`
- `messages` — `{id, match_id, from_user_id, to_user_id, text, created_at, read_at?}`
- `reports` / `blocks` — moderation records
- ObjectId is never returned raw; all reads use `{"_id": 0}` projections + uuid `id`s.

---

## 6. API Reference (all under `/api` except `/health`)

**Auth**: `GET /` (info) · `POST /auth/google` · `POST /auth/google-redirect` ·
`POST /auth/apple` · `POST /auth/session` · `GET /auth/me` · `POST /auth/logout`

**Users**: `POST /users/onboarding` · `POST /users/community-rules` ·
`POST /users/location` · `POST /users/nearby-radius` · `GET /users/me` ·
`POST /users/me/city-position` · `DELETE /users/me` (GDPR delete) ·
`GET /users/me/export` (GDPR export) · `POST /users/report` · `POST /users/block` ·
`POST /users/video/upload` (multipart → GCS) · `POST /users/video` (metadata)

**Feed/Match**: `GET /cities/popular` · `GET /feed` · `POST /swipe`
(`action: like|pass|unlike`; mutual like → match + push) · `GET /matches` ·
`GET /matches/unread`

**Messaging**: `GET /messages/{match_id}` · `POST /messages` (sends push) ·
`POST /translate` (auth required, 2000-char cap, Emergent LLM)

**Media**: `POST /video/face-check` (LLM screens intro has a real face) ·
`GET /og/{handle}` (share card PNG, cache bounded 500) · `GET /handoff.md` (this doc)

**Demos**: `GET /demos/sample` (sign-in screen peek) · `GET /samples`

**Admin** (email in `ADMIN_EMAILS`): `GET /admin/funnel` · `POST /admin/inactive-cleanup`

**Push**: `GET /push/public-key` · `GET /push/status` · `POST /push/subscribe` ·
`POST /push/unsubscribe`

**Static mounts**: `/api/videos` (demo mp4s, 79 files in `/app/backend/videos`) ·
`/api/user-videos` (legacy local uploads) · `/api/share-cards`
(Note: browsers probe `demo_XX.webm` fallbacks → harmless 404s in logs.)

---

## 7. Feed & Location System (hardest-won logic in the app)

1. **Browsing city** — every user has `city` (browsing) + `home_city` (residence).
   Feed = **locals** (home_city prefix-match on browsing city) + **nearby reals**
   (haversine within `nearby_radius_km` of browse center, labeled
   "FROM <TOWN> · N KM" on cards).
2. **Geocoder guardrail** — `POST /users/location` validates every city change
   against the **Photon geocoder** (`photon.komoot.io` via httpx). City names must
   resolve, and returned coords are used — user-supplied coords are cross-checked.
   This ended the "Tokyo users in Marlton" cache-poisoning saga (see §15).
3. **Popular cities** — `GET /cities/popular` aggregates real-user counts by
   city with demo counts shown separately; feeds the ChangeLocation screen list.
4. **Empty-feed retention** — if a town has ≤1 person, UI offers "widen to 25 km"
   (`EmptyFeedState` + `POST /users/nearby-radius`) and "Notify me" (push subscription
   for "someone joined nearby").
5. **Self-exclusion** — you never see your own card. If the operator reports
   "I see my own video", they are signed into a *different account* (check
   `apple_sub`/email duplicates — happened once with Apple Hide-My-Email).

---

## 8. Demo Persona System

- 78 personas defined in `/app/backend/videos/demo_meta.json` — each has a fixed
  `name, city, lat, lng, transcript, avatar_emoji, file` (mp4 in `/app/backend/videos`).
- Distribution is **metro-only**: Tokyo 12, São Paulo 11, Mumbai 10, New York 9,
  Lagos 8, LA 7, Paris 6, London 5, Toronto 4, Madrid 3, Sydney 2, Berlin 1.
  Small towns (Marlton, Voorhees…) get ZERO demos — real people only.
- `seed_demo_users()` runs on **every feed request** (cheap, idempotent):
  - creates missing `demo-NN` users
  - aligns codename/handle/first_name/transcript to meta
  - **heals location** whenever stored `home_city` != persona's canonical metro —
    this auto-repairs old prod data where demos were seeded into the viewer's city
- Demo cards always show the "✨ AI DEMO" badge + "HEAR ME SAY MY NAME" chip.
- Swiping demos never creates matches.

---

## 9. Media / Video Pipeline

- **Recording**: `VideoPick.js` — MediaRecorder, 7s countdown, camera preview box
  has `shrink-0 + minHeight 360` (was crushed to 0 on small iPhones — don't remove).
- **Upload**: `POST /users/video/upload` multipart → **Google Cloud Storage**
  (`GCS_BUCKET`, credentials JSON at `GOOGLE_APPLICATION_CREDENTIALS` path,
  git-ignored). Public URL stored on user. Content-type/size validated.
- **Face check**: `POST /video/face-check` uses Emergent LLM vision to confirm the
  intro contains a real face (anti-spam).
- **Share cards**: `GET /og/{handle}` renders branded PNG with PIL
  (LiberationSans fonts) for link unfurls.

---

## 10. Push Notifications (VAPID Web Push)

- Keys in backend/.env (`VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`).
- `push.py` sends via `pywebpush`; subscriptions stored on `users.push_subs`.
- Events: **someone joined nearby** (on onboarding completion of a nearby user),
  **new match**, **new message**.
- `sw.js` displays notifications and deep-links clicks (`/?chat=<match_id>` opens
  that chat; App.js parses the param on boot).
- iOS: web push works only for Home-Screen-installed PWAs (iOS 16.4+). The iOS
  **native wrapper has push stubbed off** (placeholder Firebase plist, see §11).

---

## 11. Store Distribution

### Android — Google Play (READY, upload in progress)
- **TWA** generated with Bubblewrap in `/app/android-build/twa-project`.
- Package: `com.nice2meechu.app` · versionName 1.0.1 · versionCode 2.
- **Signing keystore: `/app/android-build/twa-project/android.keystore`
  (alias `android`) — BACK THIS UP; losing it before Play App Signing enrollment
  means losing update capability.**
- Artifacts + listing assets served from `/store-assets/` (frontend/public):
  `nice2meechu-play.aab`, `play-icon-512.png`, `feature-graphic-1024x500.png`,
  `play-listing.md` (full copy-paste store listing + data-safety cheat sheet).
- `/.well-known/assetlinks.json` currently holds the LOCAL keystore SHA-256.
  **PENDING STEP**: after Play upload, Google re-signs the app → user must paste
  the *App signing key certificate* SHA-256 from Play Console → append it to
  assetlinks.json → redeploy, or the TWA shows a URL bar.

### iOS — App Store (project READY, first cloud build pending)
- Native wrapper at `/app/ios-build/ios-app/` (khmyznikov/ios-pwa-wrap template,
  same as PWABuilder). Configured: bundle `com.nice2meechu.app`, Team `J99N4XLB3D`,
  v1.0.0, loads nice2meechu.com, auth popups allowed for appleid.apple.com +
  accounts.google.com, `WKAppBoundDomains` set, all icons generated (alpha-flattened).
- **Removed HealthKit** entirely (rejection risk). **Firebase push stubbed** with a
  placeholder `GoogleService-Info.plist` — compiles fine, no push in the wrapper;
  drop in a real plist later to enable FCM.
- **NOT COMPILE-TESTED** (no Xcode on Linux) — the first Codemagic build is the
  real test; expect possible minor fixes.
- Build pipeline: `/app/codemagic.yaml` (repo root) — workflow `ios-appstore`:
  pod install → automatic signing via App Store Connect API key integration named
  **exactly `nice2meechu-asc`** → build ipa → auto-publish to TestFlight.
- User's remaining steps (documented in `/app/ios-build/README.md`):
  1. "Save to GitHub" from Emergent chat
  2. App Store Connect: create app record (`com.nice2meechu.app`)
  3. ASC → Users and Access → Integrations → create API key (App Manager),
     download .p8 once, note Issuer ID + Key ID
  4. codemagic.io (GitHub login) → add repo → add Developer Portal integration
     `nice2meechu-asc` → run build → TestFlight
- App Review notes: SIWA present ✔ · account deletion in-app ✔ · UGC report/block ✔ ·
  camera/mic usage strings in Info.plist ✔.

---

## 12. Credentials & Env Inventory

**backend/.env** (never in git): `MONGO_URL`, `DB_NAME`, `CORS_ORIGINS`
(explicit allowlist — never `*`), `EMERGENT_LLM_KEY`, `GOOGLE_CLIENT_ID`,
`ADMIN_EMAILS`, `GCP_PROJECT_ID`, `GCS_BUCKET`, `GOOGLE_APPLICATION_CREDENTIALS`
(path to git-ignored `gcs-credentials.json`), `VAPID_PRIVATE_KEY`,
`VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`, `APPLE_SERVICE_ID`.

**frontend/.env**: `REACT_APP_BACKEND_URL`, `REACT_APP_GOOGLE_CLIENT_ID`,
`REACT_APP_APPLE_SERVICE_ID`.

**Not in the repo / user-held**: Apple Developer account, ASC API .p8 key,
Google Play account, Android keystore passwords (in twa-manifest.json locally),
Google OAuth client secret (not needed — ID-token flow only).

Test credentials: `/app/memory/test_credentials.md` (git-ignored) — includes
`TEST_SESSION_TOKEN` used by `/app/backend/tests/*`.

---

## 13. Security Posture (audit 2026-06, all fixes verified)

- **CORS**: explicit allowlist (prod + www + preview), credentials on. Preview
  ingress injects `ACAO:*` but browsers reject wildcard+credentials, so harmless.
- `/translate` auth-required + 2000-char cap (was anonymous LLM burn).
- OG card cache: bogus handles not cached; bounded at 500 (FIFO).
- Message/transcript length caps (2000).
- Auth errors are generic to clients; specifics only in server logs.
- **Accepted risks** (deliberate, do not "fix" blindly):
  - localStorage token fallback (iOS Safari requirement, §4)
  - No per-user rate limiting yet on swipes/messages (P3 backlog)
- `.env` + `gcs-credentials.json` + `memory/test_credentials.md` are NOT git-tracked —
  safe for the GitHub push required by Codemagic.

---

## 14. Testing

- Backend tests: `/app/backend/tests/` (8 files, 102 tests, ALL PASSING) — hit the
  preview URL, need `export TEST_SESSION_TOKEN=...` (value in
  memory/test_credentials.md; QA user qa-tester@nice2meechu.local, 365-day session).
  Persistent fixtures: `test-john-erial`, `test-kathy-cherryhill` (GCS-style video
  URLs so the ghost-demo purge ignores them). Tests must NEVER use demo-NN users as
  mutable subjects — seeding pins demo homes on every feed call.
- Testing-agent reports: `/app/test_reports/iteration_1..20.json` + `/app/test_result.md`.
- iOS Swift code has **no CI until Codemagic is connected**.

---

## 15. Incident History & Hard-Won Lessons

1. **"Tokyo users in Marlton" (5 rounds — FINAL root cause found in R5)**:
   - R1: coordinate mixing in feed query → haversine guardrails.
   - R2: popular-cities list cache poisoning → Photon geocoder validation on all
     location writes.
   - R3 (prod-only): old prod demo docs were seeded into the viewer's browsing city
     by a pre-fix build; alignment pass now heals demo locations on every feed call.
   - R4 (prod-only): **ghost demos** — ancient records with demo videos but NO
     `is_demo` flag masqueraded as real Marlton residents. Fix: purge by video-URL
     fingerprint + heal/re-flag by id.
   - R5 (prod-only, THE actual persistent cause): **poisoned geocode cache** —
     `db.city_geo` ("cached forever") held `marlton… → Tokyo coords` from the
     pre-geocoder era. `_browse_center()` trusted the cache anchor, re-centered
     the nearby scan on Tokyo, AND wrote the poison back onto user docs.
     Reproduced exactly in preview (Tokyo demos at 0 km in Marlton), fixed by
     flushing `city_geo` on every startup (Photon re-populates lazily).
     Build stamp `v1.6.2-geocache-flush` at `GET /api/` verifies prod version.
   - Lessons: preview & prod DBs diverge; "cached forever" + trust-the-cache is a
     poison-persistence machine; always REPRODUCE with prod-shaped data before
     declaring a fix; a build stamp on `GET /api/` ends "did it deploy?" debates.
2. **Failed prod deploy**: k8s probes need root-level `GET /health` — never remove.
3. **Apple Hide-My-Email duplicate**: relay email ≠ Gmail → duplicate account.
   Manual fix applied for the operator (apple_sub moved to the Steavin account).
   A proper account-linking flow is future work.
4. **iOS camera box crush**: flex-column pages squeeze `aspect-ratio` boxes to 0 on
   small screens — the `shrink-0` + minHeight on VideoPick's camera box is load-bearing.
5. **iOS Safari cookie drops**: the whole Bearer-token/localStorage fallback exists
   because ITP eats SameSite=None cookies during OAuth redirects.

---

## 16. Runbooks

**Restart**: `sudo supervisorctl restart backend frontend`
**Backend logs**: `tail -n 100 /var/log/supervisor/backend.*.log`
**Smoke test**: `curl $API/api/` → `{"app":"Nice2Meechu",...}`; `curl localhost:8001/health`
**Force demo re-seed/heal**: any authenticated `GET /api/feed` call triggers it.
**Mint a test session**: insert into `user_sessions` for a seeded user, or sign in
via UI and copy `n2m_token` from localStorage.
**Wipe a user completely**: delete from users + user_sessions + swipes (both sides)
+ matches (user_ids) + messages (from/to). `DELETE /api/users/me` does this for self.

---

## 17. Current Status & Next Steps (as of this handoff)

**In flight**
1. Play Console: user is uploading `nice2meechu-play.aab` → then MUST paste the
   Play App Signing SHA-256 back so assetlinks.json can be updated + redeployed.
2. App Store: waiting on user to Save-to-GitHub → ASC app record + API key →
   Codemagic first build (expect to babysit the first run).
3. Production redeploy pending to ship the demo-location healing fix.

**Backlog (P2/P3)**
- Per-user rate limiting (swipes, messages, reports)
- Apple↔Google account-linking flow (Hide-My-Email dedupe)
- Native FCM push in the iOS wrapper (real Firebase plist + backend FCM sender)
- Component refactors: ChangeLocationScreen (557 lines), VideoPick, FeedScreen, App.js
- Referral/invite mechanics to seed small-town density at launch
- Store listing screenshots polish; localized listings
