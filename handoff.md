# Nice2Meechu — Complete Engineering Handoff
_Last updated: 2026-06 (post Tokyo-saga resolution, build v1.6.4-coord-repair)_
_Download anytime: `GET /api/handoff.md` (served fresh from `/app/handoff.md`)_

---

## 1. Product Snapshot

**Nice2Meechu** — a hyperlocal, video-first social app. Users connect through
7-second video introductions instead of profile photos.
Tagline: **"Meet the world. Video-first. Anonymous until the spark."**

- **Production**: https://nice2meechu.com (+ `www`) — deployed via Emergent, currently `v1.6.4-coord-repair`
- **Preview (dev)**: https://hyperlocal-video.preview.emergentagent.com
- **Stack**: React 19 (CRA + craco) · FastAPI · Motor (async MongoDB) · Google Cloud Storage
- **Status**: LIVE; Play Store + App Store submissions in progress; the long-running
  "Tokyo users in Marlton" bug is **RESOLVED and user-confirmed in production**

### Core product rules
1. **Anonymity until match** — users are shown by codename (e.g. "Cosmic Phoenix")
   until a mutual "nice2meechu" (like) creates a match.
2. **Strict hyperlocal feed** — your feed starts in YOUR town: locals first, then
   real people within your nearby-radius (default 10 km, expandable to 25/50 km).
3. **Video-first** — one 7-second intro video is the whole profile.
4. **Honest AI** — demo profiles exist only in 12 big metros to make the app feel
   alive; always badged "✨ AI DEMO", never mixed into small towns, never matchable.

### The operator (user)
- Steven (Steavin) Rice, non-technical — needs click-by-click guidance for
  everything (store consoles, DNS, certificates).
- Devices: **iPhone + iPad 10.2 + Pixel 9 + Windows 11 desktop. NO MAC** — all
  Apple workflows must be browser-based (App Store Connect web + Codemagic cloud).
- Apple Developer Team ID: `J99N4XLB3D`.
- Admin emails (env `ADMIN_EMAILS`): localfiveguy@gmail.com, steavinrice@gmail.com,
  qa-tester@nice2meechu.local.

---

## 2. Environments & Deploy Workflow

| | Preview | Production |
|---|---|---|
| URL | hyperlocal-video.preview.emergentagent.com | nice2meechu.com |
| DB | local MongoDB (MONGO_URL in backend/.env) | Emergent-managed Atlas |
| Agent access | full | **NONE** — code-only fixes, user must redeploy |

- **ALWAYS ask which environment a bug is on.** Preview and production databases
  diverge — four of the five Tokyo-bug layers were production-data-only.
- **Build stamp**: `GET /api/` returns `{"build": "v1.6.4-coord-repair", ...}`.
  Bump it on every meaningful change — it definitively answers "did my deploy
  include the fix?" (this ended days of confusion; keep the habit).
- Deploys: user clicks **Deploy** in the Emergent UI (agent cannot).
- k8s health probes hit root-level `GET /health` on backend port 8001 — the route
  in `server.py` MUST NOT be removed (its absence once failed a prod deploy).
- Supervisor: backend `0.0.0.0:8001`, frontend `3000`. Restart only for .env or
  dependency changes: `sudo supervisorctl restart backend frontend`.

---

## 3. Architecture

### Backend — `/app/backend` (modular FastAPI, all routes under `/api`)
| File | Responsibility |
|---|---|
| `server.py` | Entrypoint: `/health`, CORS (explicit allowlist), router mounting, static mounts, **startup migrations**: unique user indexes, geocode-cache flush (every boot), one-shot coord repair (`repair_user_coords_v1` marker in `db.migrations`), legacy demo retirement |
| `core.py` | db client, env constants, `SESSION_TTL` (7 d), `generate_codename()`, `haversine_km()`, `_geocode_city(label, use_cache=True)` (Photon + `db.city_geo` cache; **pass use_cache=False for anything persisted to user records**), logger |
| `models.py` | Pydantic request models (text fields length-capped at 2000) |
| `auth.py` | Google GIS verify, **Sign in with Apple** (JWKS), legacy Emergent exchange, sessions, `_insert_user_or_get_existing` race guard, build stamp |
| `users.py` | Onboarding, location change (geocoder-validated), nearby-radius, GDPR delete/export, report/block, GCS video upload, `/users/video` URL-prefix validation |
| `feed.py` | `/cities/popular`, `/feed` (locals + nearby + browse-center healing), `/swipe` (like/pass/unlike, match creation), `/matches` |
| `messaging.py` | Messages, unread counts, `/translate` (LLM, auth required) |
| `media.py` | Face-check (LLM), OG share cards (bounded cache 500), `/handoff.md` |
| `demos.py` | 78 demo personas: seeding + alignment + **location healing** + **ghost purge** (runs on every feed request, idempotent) |
| `admin.py` | `/admin/funnel`, `/admin/inactive-cleanup`, **`/admin/diagnose-feed`** (prod visibility: viewer location state, geocache entry, browse center, raw local/nearby candidates) |
| `push.py` | VAPID web push subscribe/unsubscribe/status/public-key |

### Frontend — `/app/frontend/src`
- `App.js` — routing, session bootstrap, push deep links (`?chat=<match_id>`)
- `lib/` — `api.js` (axios + Bearer from localStorage), `push.js`, `constants.js`,
  `cityFormat.js`, `ua.js`
- `screens/` — Splash, SignInScreen, AuthCallback, Onboarding, CommunityRulesScreen,
  VideoPick, FeedScreen, ChangeLocationScreen (Leaflet), MatchesScreen, ChatScreen,
  ProfileScreen
- `components/` — FeedCard, AppleSignInButton, CityAutocomplete, DemoPeekWidget,
  BottomNav, MatchCelebration, ShareCard, AvatarThumb, VideoEl, EmptyFeedState,
  NotifyMeButton, IOSInstallSheet, SignaturePad, `ui/` (shadcn)
- `public/sw.js` — push-only service worker (NO fetch/caching — deliberate)
- `legal/LegalPages.jsx` — `/privacy`, terms, community rules

### Key dependencies
Backend: fastapi, motor, pywebpush/py-vapid, PyJWT (Apple), google-auth (Google),
httpx (Photon geocoder), google-cloud-storage, emergentintegrations (LLM), Pillow.
Frontend: react-router-dom, framer-motion, leaflet, axios, sonner, lucide-react, radix/shadcn.

---

## 4. Authentication (three ways in, one session system)

1. **Google (primary)** — Google Identity Services.
   - Desktop/Android: popup → `POST /api/auth/google` `{credential}`
   - iOS Safari: redirect → `POST /api/auth/google-redirect` (form) →
     `GET /auth-callback#token=...` (fragment; ITP drops cookies)
2. **Apple (App Store requirement)** — `AppleSignInButton.js`: lazy-loads Apple JS
   SDK, popup mode, `redirectURI = origin + "/"` → `POST /api/auth/apple`
   `{id_token, name?, ref?}` — PyJWT `PyJWKClient` against
   `https://appleid.apple.com/auth/keys`, aud = `APPLE_SERVICE_ID`
   (`nice2meechu.app.web`), iss = appleid.apple.com.
   - Link order: `apple_sub` → verified email match → create new.
   - **Email linking requires the `email_verified` claim** (bool or "true").
   - **"Hide My Email" trap**: relay emails create duplicates if the user joined
     via Google before. UI hint under the button warns. No automated merge flow
     yet (one manual DB merge was done for the operator).
   - Button renders only when `REACT_APP_APPLE_SERVICE_ID` is set.
3. **Legacy** — `POST /api/auth/session` (Emergent exchange), kept for old sessions.

**Sessions**: `secrets.token_urlsafe` in `user_sessions`, TTL 7 days. Sent as
httpOnly cookie (SameSite=None, Secure) AND in the JSON body; frontend stores
`n2m_token` in localStorage and sends `Authorization: Bearer`. **The localStorage
fallback is a deliberate iOS Safari workaround — do NOT remove it** (iPhone login
breaks without it; security review accepted the risk).

**Duplicate-account protection**: unique partial indexes on `email`, `google_sub`,
`apple_sub` (`{$type:"string"}` filters) + `_insert_user_or_get_existing` catches
`DuplicateKeyError` from concurrent sign-ins (race-tested).

**Apple Developer config (user's account)**
- App ID `com.nice2meechu.app` (explicit, SIWA capability ✔)
- Services ID `nice2meechu.app.web` — domains: nice2meechu.com + preview domain;
  Return URLs: both origins + `/`. No .p8 needed for the web popup flow.

---

## 5. Data Model (MongoDB)

- `users` — `{id (uuid), email, name, first_name, picture, google_sub?, apple_sub?,
  codename, handle, avatar_emoji, vibes[], language, home_city, home_lat, home_lng,
  city, city_lat, city_lng, lat, lng, nearby_radius_km (10), video_url, transcript,
  source_lang, is_demo?, demo_age?, referrer_handle, referrer_id, referral_count,
  push_subs[], rules_accepted_at, created_at, last_active_at}`
  - `home_*` = residence; `city*` = current browsing location.
- `user_sessions` — `{user_id, session_token, expires_at}`
- `swipes` — `{user_id, target_user_id, action: like|pass, created_at}` (unlike = delete)
- `matches` — `{id, user_ids: [a, b], created_at}`
- `messages` — `{id, match_id, from_user_id, to_user_id, text, created_at, read_at?}`
- `reports` / `blocks` — moderation
- `city_geo` — geocode cache `{key, lat, lng}` — **flushed on every startup** (see §15)
- `migrations` — one-shot migration markers (e.g. `repair_user_coords_v1`)
- ObjectId never leaves the API: `{"_id": 0}` projections + uuid `id`s everywhere.

---

## 6. API Reference (all `/api` except `/health`)

**Meta**: `GET /` (app + **build stamp** + auth mode) · `GET /health` (k8s probe, root level)

**Auth**: `POST /auth/google` · `POST /auth/google-redirect` · `POST /auth/apple` ·
`POST /auth/session` · `GET /auth/me` · `POST /auth/logout`

**Users**: `POST /users/onboarding` (first_name, city, age, vibes, language,
avatar_emoji) · `POST /users/community-rules` · `POST /users/location`
(geocoder-validated; `set_home` flag) · `POST /users/nearby-radius` (10/25/50) ·
`GET /users/me` (returns `{"user": ...}`) · `POST /users/me/city-position` ·
`DELETE /users/me` (GDPR) · `GET /users/me/export` · `POST /users/report` ·
`POST /users/block` · `POST /users/video/upload` (multipart → GCS) ·
`POST /users/video` (metadata; URL must start `https://storage.googleapis.com/`
or `/api/user-videos/`)

**Feed/Match**: `GET /cities/popular` · `GET /feed` · `POST /swipe`
(like|pass|unlike; mutual like → match + push) · `GET /matches` · `GET /matches/unread`

**Messaging**: `GET /messages/{match_id}` · `POST /messages` (push to recipient) ·
`POST /translate` (auth, ≤2000 chars, Emergent LLM)

**Media**: `POST /video/face-check` · `GET /og/{handle}` (share-card PNG) ·
`GET /handoff.md`

**Demos**: `GET /demos/sample` · `GET /samples` (vibes + languages)

**Admin** (email ∈ ADMIN_EMAILS): `GET /admin/funnel` · `POST /admin/inactive-cleanup` ·
`GET /admin/diagnose-feed` ← open signed-in in a browser to dump feed internals

**Push**: `GET /push/public-key` · `GET /push/status` · `POST /push/subscribe` ·
`POST /push/unsubscribe`

**Static**: `/api/videos` (79 demo mp4s) · `/api/user-videos` (legacy) ·
`/api/share-cards`. (Browsers probe `.webm` fallbacks → harmless 404s in logs.)

---

## 7. Feed & Location System (hardest-won logic — read §15 first)

1. Feed = **locals** (`home_city` prefix-matches browsing city) + **nearby reals**
   (haversine within `nearby_radius_km` of the browse center; cards show
   "FROM <TOWN> · N KM").
2. **Browse center** (`_browse_center`): anchor = median of locals' home coords,
   else geocode of the browsing-city label; stored `city_lat/lng` used only if
   within 100 km of the anchor, otherwise **healed**.
3. **Heal writes are cache-free**: healed `city_lat/lng` (and `home_lat/lng` when
   the user browses their own home city) are persisted ONLY from a fresh Photon
   geocode (`use_cache=False`) — never from `db.city_geo`. This rule exists
   because cached poison once re-infected user records (§15 R5).
4. **Geocoder guardrail**: `POST /users/location` validates every city change via
   Photon (`photon.komoot.io`, httpx) and uses the geocoder's coords.
5. **Empty-feed retention**: sparse towns offer "widen to 25 km" + "Notify me"
   (push when someone joins nearby).
6. Self-exclusion: you never see your own card. "I see my own video" = the person
   is signed into a different/duplicate account (check `apple_sub`/emails).

---

## 8. Demo Persona System

- 78 personas in `/app/backend/videos/demo_meta.json` — fixed `name, city, lat,
  lng, transcript, avatar_emoji, file` (mp4s in `/app/backend/videos`).
- Metro-only distribution: Tokyo 12, São Paulo 11, Mumbai 10, NY 9, Lagos 8, LA 7,
  Paris 6, London 5, Toronto 4, Madrid 3, Sydney 2, Berlin 1. Small towns get ZERO.
- `seed_demo_users()` on **every feed request** (cheap, idempotent):
  1. **Ghost purge**: delete any user whose `video_url` matches
     `/videos/demo_\d+\.(mp4|webm)(\?|$)` with a non-`demo-NN` id (real uploads
     live in GCS, so this fingerprint is safe).
  2. Stale cleanup: `is_demo:True` with unknown id → delete.
  3. Alignment **by id** (not flag): codename/handle/name/transcript + re-set
     `is_demo:True` + **heal location** when `home_city` ≠ canonical metro.
- Demo cards: "✨ AI DEMO" badge + "HEAR ME SAY MY NAME" chip; never matchable.
- **Tests must never use demo-NN users as mutable subjects** — healing resets them
  mid-test (see §14).

---

## 9. Media / Video Pipeline

- Recording: `VideoPick.js` — MediaRecorder, 7 s countdown. The camera box has
  `shrink-0` + `minHeight: 360` — **load-bearing**: flex-column pages crush
  aspect-ratio boxes to zero on small iPhones (record button vanished for the
  operator's iPhone). Continue button toasts "Record your intro first" when empty.
- Upload: `POST /users/video/upload` multipart → GCS (`GCS_BUCKET`, key file at
  `GOOGLE_APPLICATION_CREDENTIALS`, git-ignored). Public URL stored on user.
- Face check: LLM vision confirms a real face (anti-spam).
- Share cards: `GET /og/{handle}` renders branded PNGs with PIL (LiberationSans).

---

## 10. Push Notifications (VAPID Web Push)

- Keys in backend/.env; `push.py` via pywebpush; subs on `users.push_subs`.
- Events: someone-joined-nearby, new match, new message.
- `sw.js` deep-links clicks (`/?chat=<match_id>`); App.js parses on boot.
- iOS web push only for Home-Screen PWAs (16.4+). The iOS native wrapper has push
  **stubbed** (placeholder Firebase plist; drop in a real one later for FCM).

---

## 11. Store Distribution

### Android — Google Play (artifacts READY; user upload in progress)
- TWA via Bubblewrap: `/app/android-build/twa-project`. Package
  `com.nice2meechu.app`, versionName 1.0.1, versionCode 2.
- **Signing keystore: `/app/android-build/twa-project/android.keystore` (alias
  `android`) — BACK IT UP.**
- Downloads at `/store-assets/` (frontend/public): `nice2meechu-play.aab`,
  `play-icon-512.png`, `feature-graphic-1024x500.png`, `play-listing.md`
  (copy-paste listing text + content-rating + data-safety cheat sheets).
- `/.well-known/assetlinks.json` holds the LOCAL keystore SHA-256. **PENDING:**
  after Play upload, Google re-signs → user must paste the *App signing key
  certificate* SHA-256 from Play Console → append to assetlinks.json → redeploy,
  or the installed app shows a browser URL bar.

### iOS — App Store (project READY; first cloud build pending)
- Wrapper at `/app/ios-build/ios-app/` (khmyznikov/ios-pwa-wrap template):
  bundle `com.nice2meechu.app`, Team `J99N4XLB3D`, v1.0.0, loads nice2meechu.com,
  auth popups allowed (appleid.apple.com, accounts.google.com), WKAppBoundDomains
  set, icons generated (alpha-flattened), descriptive camera/mic/location strings,
  ATS ArbitraryLoads=false, arm64 capability, no remote-notification bg mode.
- **HealthKit fully removed** (rejection risk). Placeholder
  `GoogleService-Info.plist` present AND trackable (template .gitignore that hid
  it was removed — it broke clean-checkout builds).
- **NOT COMPILE-TESTED** (no Xcode on Linux) — babysit the first Codemagic build.
- Pipeline: `/app/codemagic.yaml` — workflow `ios-appstore`: pod install → auto
  signing via ASC API key integration named **exactly `nice2meechu-asc`** →
  build-ipa → auto-publish to TestFlight.
- User's remaining steps (`/app/ios-build/README.md`):
  1. "Save to GitHub" (chat input GitHub icon; connect account via Profile first)
  2. ASC: New App (`com.nice2meechu.app`)
  3. ASC → Users and Access → Integrations → API key (App Manager), download .p8
     once, note Issuer ID + Key ID
  4. codemagic.io (GitHub login) → add repo → Developer Portal integration
     `nice2meechu-asc` → Start build → TestFlight
- Review posture: SIWA ✔, in-app account deletion ✔, UGC report/block ✔,
  permission strings ✔.

---

## 12. Credentials & Env Inventory

**backend/.env** (never git-tracked): `MONGO_URL`, `DB_NAME`, `CORS_ORIGINS`
(explicit allowlist — NEVER `*`), `EMERGENT_LLM_KEY`, `GOOGLE_CLIENT_ID`,
`ADMIN_EMAILS`, `GCP_PROJECT_ID`, `GCS_BUCKET`, `GOOGLE_APPLICATION_CREDENTIALS`,
`VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`, `APPLE_SERVICE_ID`.

**frontend/.env**: `REACT_APP_BACKEND_URL`, `REACT_APP_GOOGLE_CLIENT_ID`,
`REACT_APP_APPLE_SERVICE_ID`.

**User-held, not in repo**: Apple Developer account, ASC API .p8, Google Play
account, Android keystore passwords, GCS JSON key (file git-ignored).

**Test credentials**: `/app/memory/test_credentials.md` (git-ignored) — includes
`TEST_SESSION_TOKEN` (365-day QA session).

---

## 13. Security Posture (audited + code-reviewed 2026-06, fixes verified)

- CORS: explicit allowlist, credentials on. (Preview ingress injects `ACAO:*`,
  harmless — browsers reject wildcard+credentials.)
- `/translate` auth-required + 2000-char cap; message/transcript caps.
- OG cache bounded (500, FIFO); bogus handles uncached.
- Auth errors generic to clients; details in server logs only.
- `/users/video` URL-prefix validation (GCS / user-videos only).
- Apple email linking requires `email_verified`.
- Unique user indexes + insert race guard.
- **Accepted risks** (deliberate — do not "fix"):
  localStorage token fallback (iOS Safari), no per-user rate limiting yet (P3).
- `.env`, `gcs-credentials.json`, `memory/test_credentials.md` are NOT git-tracked
  → safe for the GitHub push Codemagic needs.

---

## 14. Testing

- Backend: `/app/backend/tests/` — 8 files, **102 tests, all passing** (verified
  twice consecutively; order-independent). Run:
  `export TEST_SESSION_TOKEN=<from memory/test_credentials.md> && python3 -m pytest tests/ -q`
- QA account: `qa-tester@nice2meechu.local` (homed Marlton NJ, 365-day session).
- Persistent fixtures: `test-john-erial` (~15 km), `test-kathy-cherryhill`
  (~10 km) — **GCS-style video URLs** so the ghost purge ignores them. If a
  fixture vanishes, the purge ate it: re-seed with a GCS-style URL.
- Rules learned the hard way: never use demo-NN users as mutable test subjects
  (healing resets them mid-test); tests needing Tokyo residents must set the
  browse location themselves (don't rely on file ordering).
- Testing-agent artifacts: `/app/test_reports/iteration_1..20.json`, `/app/test_result.md`.
- iOS Swift has no CI until Codemagic is connected.

---

## 15. Incident History & Hard-Won Lessons

1. **"Tokyo users in Marlton" — 5 layers, RESOLVED (user-confirmed on v1.6.4)**
   - R1 code: feed coordinate mixing → haversine guardrails.
   - R2 input: poisoned popular-cities coords → Photon validation on writes.
   - R3 data (prod): demos seeded into viewers' cities by an old build →
     per-request location healing.
   - R4 data (prod): **ghost demos** without `is_demo` flags → purge by
     video-URL fingerprint; align/heal by id, not flag.
   - R5 data (prod, the persistence engine): **poisoned geocode cache**
     (`city_geo`: "marlton→Tokyo", cached forever). `_browse_center` trusted it
     AND wrote it back onto user docs. Fix: flush cache every startup + one-shot
     user-coord repair migration + cache-free heal writes.
   - Lessons: (a) "cached forever" + "trust the cache" = poison-persistence
     machine; (b) preview/prod DBs diverge — reproduce with prod-shaped data
     before declaring victory; (c) self-healing code can propagate disease —
     validate the source; (d) build stamps end deploy ambiguity; (e) when models
     run out, ship a diagnostic endpoint and get direct evidence.
2. Failed prod deploy: k8s probes need root `GET /health` — never remove.
3. Apple Hide-My-Email duplicate: relay email ≠ Gmail → duplicate account.
   Manual merge done for the operator; automated linking is backlog.
4. iOS camera box crush: flex columns squeeze aspect-ratio boxes to 0 — the
   `shrink-0`/minHeight on VideoPick is load-bearing.
5. iOS Safari cookie drops: the Bearer/localStorage fallback exists because ITP
   eats SameSite=None cookies during OAuth redirects.
6. iOS template landmine: the wrapper's `.gitignore` hid `GoogleService-Info.plist`
   → clean-checkout builds fail. Removed; watch for it if re-generating.

---

## 16. Runbooks

- Restart: `sudo supervisorctl restart backend frontend`
- Logs: `tail -n 100 /var/log/supervisor/backend.*.log`
- Smoke: `curl $API/api/` (check `build`), `curl localhost:8001/health`
- Prod feed forensics: sign in as an admin on nice2meechu.com, then open
  `https://nice2meechu.com/api/admin/diagnose-feed` in the same browser.
- Force demo re-seed/heal/purge: any authenticated `GET /api/feed`.
- Re-run the coord-repair migration: delete the `repair_user_coords_v1` doc from
  `db.migrations`, restart backend.
- Mint a test session: insert into `user_sessions`, or copy `n2m_token` from
  localStorage after a UI sign-in.
- Full user wipe: users + user_sessions + swipes (both sides) + matches
  (user_ids) + messages (from/to). `DELETE /api/users/me` does it for self.

---

## 17. Current Status & Next Steps

**In flight**
1. **Play Console**: user uploads `nice2meechu-play.aab` → MUST paste back the
   Play App Signing SHA-256 so assetlinks.json can be updated + redeployed.
2. **App Store**: Save-to-GitHub → ASC app record + API key → Codemagic
   integration `nice2meechu-asc` → babysit the first build.

**Backlog (P2/P3)**
- Per-user rate limiting (swipes, messages, reports)
- Apple↔Google account-linking flow (Hide-My-Email dedupe)
- Native FCM push in the iOS wrapper
- Referral/invite share flow (referral fields already in the data model) — good
  launch lever for seeding small towns with real users
- Component refactors: ChangeLocationScreen (557 lines), VideoPick, FeedScreen, App.js
- CI: wire the 102-test suite into GitHub Actions once the repo is on GitHub
- Store listing screenshot polish; localized listings


---

## 18. 2026-06 (later): iPhone black-video fix — webm→mp4 transcode (v1.6.5)

**Bug (production)**: real-user cards appeared in Marlton/Egg Harbor but videos were black on iPhone. Demos (mp4) played fine.
**Root cause**: 16/20 real intros in GCS bucket `nicemeechu` were `.webm` (Chrome/Android MediaRecorder); iOS Safari cannot decode webm.
**Fix (build v1.6.5-webm-transcode)**:
- `/app/backend/transcode.py` — H.264/AAC mp4 encode via pip `imageio-ffmpeg` static binary (in requirements.txt → present in prod image).
- `POST /api/users/video/upload` transcodes webm uploads to mp4 (fallback: store webm if encode fails); deletes `.webm` sibling.
- One-shot background startup migration `transcode_webm_videos_v1` (server.py) repoints non-demo `.webm` video_urls to mp4 siblings, transcoding when the sibling is missing. Webm originals kept (other env's URLs must not 404). Marker is per-environment DB → production repoints its own URLs on first deploy; all 15 playable prod webm blobs are ALREADY pre-rendered to mp4 in the shared bucket, so prod's pass is instant.
- `FeedCard.js` — single `<source>`, query-string-safe extension check (removed the .webm probe source that also broke `type=` on `?v=` URLs).
**Verification**: testing agent iteration_22 caught a critical (upload closure still sent the webm spool — fixed), iteration_23 backend 100%: served bytes `ftyp isom`, ffprobe h264+aac. Suite 118/118 incl. new `/app/backend/tests/test_webm_transcode.py`. Frontend DOM verified (feed, mp4 source, no MediaError, controls).
**Gotchas for future agents**:
- Headless Chromium has NO h264 codec — all mp4 (demos included) show MediaError 4 / readyState 0 in Playwright. Never diagnose that as an app bug.
- QA fixture user 2b0f5a67 must keep home_city "Tokyo, Japan" (test_home_city.py) but now has age/rules/video so cookie login lands on the feed.
- GCS bucket is SHARED with production — never delete non-test objects from preview.
**Status**: ✅ verified in preview; ⚠️ REQUIRES REDEPLOY to nice2meechu.com.
