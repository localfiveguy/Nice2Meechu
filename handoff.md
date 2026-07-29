# Nice2Meechu — Complete Engineering Handoff
_Last updated: 2026-06 · production build **v1.6.6-home-town-only** (verified live via `GET https://nice2meechu.com/api/`)_
_Download the freshest copy anytime: `GET /api/handoff.md` (served from `/app/handoff.md`)_

---

## 1. Product Snapshot

**Nice2Meechu** — a hyperlocal, video-first social app. Users connect through
short video introductions instead of profile photos.
Tagline: **"Meet the world. Video-first. Anonymous until the spark."**

- **Production**: https://nice2meechu.com (+ `www`) — deployed via Emergent, **v1.6.6-home-town-only**
- **Preview (dev)**: https://hyperlocal-video.preview.emergentagent.com
- **Stack**: React 19 (CRA + craco) · FastAPI · Motor (async MongoDB) · Google Cloud Storage
- **Status**: LIVE. Both hard production bugs are resolved and deployed:
  the "Tokyo users in Marlton" location saga (v1.6.4, user-confirmed) and the
  "real videos black on iPhone" webm codec bug (v1.6.5/v1.6.6).

### Core product rules (current, post-v1.6.6)
1. **Anonymity until match** — users are shown by codename (e.g. "Cosmic Phoenix")
   until a mutual like creates a match.
2. **Home-town-only feed** — a video appears ONLY in its home town. There is NO
   nearby-radius spreading anymore (owner explicitly removed it; see §7 and §15.7).
   An 8 km same-town coordinate tolerance absorbs naming variants of the SAME town
   (Marlton ↔ Evesham Township) without leaking into neighboring towns.
3. **Video-first** — one short intro video is the whole profile. All stored intros
   are H.264/AAC mp4 (webm uploads are transcoded server-side; iOS can't play webm).
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
- **Store publishing is deliberately parked**: the owner knows how to publish the
  Play Store AAB and will do it "months from now" — he asked NOT to be reminded.
  Do not nudge about the AAB / Play Console / App Store unless he raises it.

---

## 2. Environments & Deploy Workflow

| | Preview | Production |
|---|---|---|
| URL | hyperlocal-video.preview.emergentagent.com | nice2meechu.com |
| DB | local MongoDB (MONGO_URL in backend/.env) | Emergent-managed (separate!) |
| GCS bucket | `nicemeechu` — **SHARED with production** | same bucket |
| Agent access | full | **NONE** — code-only fixes, user must redeploy |

- **ALWAYS ask which environment a bug is on.** The two databases diverge
  completely: real signups (the actual people from Erial / Egg Harbor / Marlton NJ)
  exist ONLY in production. Preview holds fixtures + the owner's own account.
  Several "bugs" have turned out to be exactly this data split.
- **The GCS video bucket is shared.** Preview code can read/repair production
  video files (this is how the webm→mp4 pre-render worked). NEVER delete
  non-test objects from preview.
- **Build stamp**: `GET /api/` returns `{"build": "v1.6.6-home-town-only", ...}`
  (defined in `auth.py`; the admin diagnose endpoint carries its own copy in
  `admin.py`). Bump BOTH on every meaningful change — it definitively answers
  "did my deploy include the fix?".
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
| `server.py` | Entrypoint: `/health`, CORS (explicit allowlist), router mounting, static mounts, **startup migrations**: unique user indexes, geocode-cache flush (every boot), one-shot coord repair (`repair_user_coords_v1`), one-shot **webm→mp4 URL repoint** (`transcode_webm_videos_v1`, runs as a background task), legacy demo retirement, inactive-cleanup scheduler |
| `core.py` | db client, env constants, `SESSION_TTL` (7 d), **`SAME_TOWN_KM = 8`**, `generate_codename()`, `haversine_km()`, `_geocode_city(label, use_cache=True)` (Photon + `db.city_geo` cache; **pass use_cache=False for anything persisted to user records**), GCS lazy init, logger |
| `models.py` | Pydantic request models (text fields length-capped at 2000). `NearbyRadiusReq` is legacy/unused (endpoint removed) |
| `auth.py` | Google GIS verify, **Sign in with Apple** (JWKS), legacy Emergent exchange, sessions, `_insert_user_or_get_existing` race guard, **build stamp** |
| `users.py` | Onboarding, location change (geocoder-validated), GDPR delete/export, report/block, **GCS video upload with webm→mp4 transcode**, `/users/video` URL-prefix validation |
| `feed.py` | `/cities/popular`, `/feed` (home-town locals + `_same_town_candidates` + browse-center healing), `/swipe` (like/pass/unlike, match creation), `/matches`, `/matches/unread` |
| `messaging.py` | Messages, `/translate` (LLM, auth required) |
| `media.py` | Face/age check (LLM vision), OG share cards (bounded cache 500), `/handoff.md` |
| `demos.py` | 78 demo personas: seeding + alignment + **location healing** + **ghost purge** (runs on every feed request, idempotent) |
| `admin.py` | `/admin/funnel`, `/admin/inactive-cleanup`, **`/admin/diagnose-feed`** (dumps viewer location state, geocache entry, browse center, raw `locals` + `same_town` candidates) |
| `push.py` | VAPID web push subscribe/unsubscribe/status/public-key + `notify_user()` for match/message pushes. The "someone new joined nearby" broadcast was REMOVED (owner request) |
| `transcode.py` | `transcode_to_mp4(src, dst)` — H.264/AAC mp4 (faststart, crf 26) via the static ffmpeg binary bundled in the pip package **imageio-ffmpeg** (in requirements.txt → present in the production image; no system ffmpeg needed) |

### Frontend — `/app/frontend/src`
- `App.js` — routing, session bootstrap, push deep links (`?chat=<match_id>`).
  Routing gate `routeToNext()`: needs `handle + first_name + city + age` →
  else Onboarding; then `agreed_to_rules_at` → else Community Rules; then
  `video_url` → else VideoPick; else Feed.
- `lib/` — `api.js` (axios + Bearer from localStorage), `push.js`, `constants.js`,
  `cityFormat.js`, `ua.js`
- `screens/` — Splash, SignInScreen (Apple-first on iOS), AuthCallback, Onboarding,
  CommunityRulesScreen, VideoPick, FeedScreen, ChangeLocationScreen (Leaflet),
  MatchesScreen, ChatScreen, ProfileScreen
- `components/` — FeedCard (single mp4 `<source>`, query-string-safe type check),
  AppleSignInButton, CityAutocomplete, BottomNav, MatchCelebration, ShareCard,
  AvatarThumb, VideoEl, EmptyFeedState, NotifyMeButton (Profile row only),
  IOSInstallSheet, SignaturePad, `ui/` (shadcn)
- `public/sw.js` — push-only service worker (NO fetch/caching — deliberate)
- `legal/LegalPages.jsx` — `/privacy`, terms, community rules

### Key dependencies
Backend: fastapi, motor, pywebpush/py-vapid, PyJWT (Apple), google-auth (Google),
httpx (Photon geocoder), google-cloud-storage, **imageio-ffmpeg** (bundled ffmpeg),
emergentintegrations (LLM), Pillow.
Frontend: react-router-dom, framer-motion, leaflet, axios, sonner, lucide-react, radix/shadcn.

---

## 4. Authentication (three ways in, one session system)

1. **Google (primary)** — Google Identity Services.
   - Desktop/Android: popup → `POST /api/auth/google` `{credential}`
   - iOS Safari: redirect → `POST /api/auth/google-redirect` (form) →
     `GET /auth-callback#token=...` (fragment; ITP drops cookies)
   - **iOS UX rule**: on iPhone/iPad the sign-in screen shows "Continue with
     Apple" FIRST with an explanatory hint; Google below with a Safari hint.
     Reason: a website can only see Google accounts with an active *Safari*
     google.com session — it can NEVER read accounts from the native
     Google/Gmail apps (iOS sandboxing). Owner verified: signing into Google on
     any Safari site first makes the Google button work.
2. **Apple (App Store requirement)** — `AppleSignInButton.js`: lazy-loads Apple JS
   SDK, popup mode, `redirectURI = origin + "/"` → `POST /api/auth/apple`
   `{id_token, name?, ref?}` — PyJWT `PyJWKClient` against
   `https://appleid.apple.com/auth/keys`, aud = `APPLE_SERVICE_ID`
   (`nice2meechu.app.web`), iss = appleid.apple.com.
   - Link order: `apple_sub` → verified email match → create new.
   - **Email linking requires the `email_verified` claim** (bool or "true").
   - **"Hide My Email" handling (v1.6.7)**: relay emails used to create silent
     duplicates. Now `/auth/apple` returns `created` + `private_relay` + a
     30-min one-time `link_token` for brand-new relay accounts; the frontend
     routes to `LinkGoogleScreen` (`/?link_google=1`) offering "link your
     existing Google account". Desktop popup → `POST /auth/link-google`
     (GIS credential verified, merge, new session). iOS redirect →
     `/api/auth/google-redirect?link=<token>` merges during the redirect.
     Merge = move `apple_sub` onto the Google account (+`apple_relay_email`),
     delete the empty relay duplicate + its sessions. SAFETY GUARD
     (`_relay_mergeable`): only accounts with apple_sub, NO google_sub, NO
     video, and a @privaterelay.appleid.com email can ever be merged — data
     loss is impossible. Skipping continues as a new user. The static UI hint
     under the Apple button still nudges "Share My Email".
   - Button renders only when `REACT_APP_APPLE_SERVICE_ID` is set.
   - Owner-confirmed working on his iPhone.
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

- `users` — `{id (uuid), email, name, first_name, age, picture, google_sub?,
  apple_sub?, codename, handle, avatar_emoji, vibes[], language,
  home_city, home_lat, home_lng, city, city_lat, city_lng, lat, lng,
  video_url, transcript, source_lang, is_demo?, demo_age?,
  referrer_handle, referrer_id, referral_count, notify_new_nearby (bool —
  legacy field name; now gates match/message pushes), nearby_radius_km
  (legacy, ignored by code), city_positions{}, agreed_to_rules_at,
  last_matches_viewed_at, created_at, last_active_at}`
  - `home_*` = residence (where the video appears); `city*` = current browsing location.
  - `video_url` is always an H.264 mp4 after v1.6.5 (GCS public URL + `?v=` cache-bust).
- `user_sessions` — `{user_id, session_token, expires_at}`
- `swipes` — `{id, user_id, target_user_id, action: like|pass|block, at}`
  (upsert per pair; "unlike" deletes the row)
- `matches` — `{id, user_ids: [sorted a,b], at}`
- `messages` — `{id, match_id, from_user_id, text, at, ...}`
- `reports` / `blocks` — moderation
- `push_subscriptions` — `{endpoint (unique), keys{p256dh,auth}, user_id}`
- `city_geo` — geocode cache `{key, lat, lng}` — **flushed on every startup** (see §15.1 R5)
- `age_checks` — GDPR/DSA audit trail of the LLM age gate
- `migrations` — one-shot markers: `repair_user_coords_v1`, `transcode_webm_videos_v1`
- ObjectId never leaves the API: `{"_id": 0}` projections + uuid `id`s everywhere.

---

## 6. API Reference (all `/api` except `/health`)

**Meta**: `GET /` (app + **build stamp** + auth mode) · `GET /health` (k8s probe, root level)

**Auth**: `POST /auth/google` · `POST /auth/google-redirect` · `POST /auth/apple` ·
`POST /auth/session` · `GET /auth/me` · `POST /auth/logout`

**Users**: `POST /users/onboarding` (first_name, city, age, vibes, language,
avatar_emoji; sets home) · `POST /users/community-rules` · `POST /users/location`
(geocoder-validated; optional `set_home` flag) · `GET /users/me` (returns
`{"user": ...}`) · `POST /users/me/city-position` · `DELETE /users/me` (GDPR) ·
`GET /users/me/export` · `POST /users/report` · `POST /users/block` ·
`POST /users/video/upload` (multipart → **webm transcoded to mp4** → GCS) ·
`POST /users/video` (metadata; URL must start `https://storage.googleapis.com/`
or `/api/user-videos/`)
- REMOVED in v1.6.6: `POST /users/nearby-radius` (404 now; regression-tested).

**Feed/Match**: `GET /cities/popular` · `GET /feed` → `{feed[], city_stats
{total, remaining}, saved_position, referral_count}` (NO `radius_suggestion`,
items have NO `near_km` — both removed) · `POST /swipe` (like|pass|unlike|block;
mutual like → match + push) · `GET /matches` · `GET /matches/unread`

**Messaging**: `GET /messages/{match_id}` · `POST /messages` (push to recipient) ·
`POST /translate` (auth, ≤2000 chars, Emergent LLM)

**Media**: `POST /video/face-check` (LLM face + age gate) · `GET /og/{handle}`
(share-card PNG) · `GET /handoff.md`

**Demos**: `GET /demos/sample` · `GET /samples` (vibes + languages)

**Admin** (email ∈ ADMIN_EMAILS): `GET /admin/funnel` · `POST /admin/inactive-cleanup` ·
`GET /admin/diagnose-feed` ← open signed-in in a browser to dump feed internals
(`locals`, `same_town`, browse center, geocache entry, build stamp)

**Push**: `GET /push/public-key` · `GET /push/status` · `POST /push/subscribe` ·
`POST /push/unsubscribe`

**Static**: `/api/videos` (79 demo mp4s) · `/api/user-videos` (legacy) ·
`/api/share-cards`.

---

## 7. Feed & Location System (hardest-won logic — read §15 first)

**Current model (v1.6.6, owner-directed): HOME TOWN ONLY.**

1. Feed candidates for a browsed city =
   - **label locals**: `home_city` prefix-matches the browsing city (case-insensitive), PLUS
   - **same-town coordinate matches** (`_same_town_candidates`): anyone whose
     HOME coords are within **`SAME_TOWN_KM = 8` km** of the browse center.
   Both merged and sorted chronologically (oldest first — "first video made here").
2. **Why 8 km**: Photon-verified — Marlton↔Evesham Township centers are 6.5 km
   apart (SAME physical town, two names; the map reverse-geocode returns either),
   while the nearest genuinely different towns (Medford, Cherry Hill) are 9.4+ km.
   8 km merges naming variants without leaking across towns.
3. **REMOVED (do not re-add without explicit owner request)**: the whole
   10/25/50 km nearby-radius system — `_nearby_candidates`, `_radius_suggestion`,
   `/users/nearby-radius`, radius picker UI, widen-radius prompts/banners,
   "FROM <TOWN> · N KM" chips. The owner's words: "remove the near cities from
   the whole thing" — he wants a video visible ONLY in its own town.
4. **Browse center** (`_browse_center`): anchor = median of label-locals' home
   coords, else geocode of the browsing-city label; stored `city_lat/lng` used
   only if within 100 km of the anchor, otherwise **healed**.
5. **Heal writes are cache-free**: healed `city_lat/lng` (and `home_lat/lng` when
   the user browses their own home city) are persisted ONLY from a fresh Photon
   geocode (`use_cache=False`) — never from `db.city_geo`. Cached poison once
   re-infected user records (§15.1 R5).
6. **Geocoder guardrail**: `POST /users/location` validates every city change via
   Photon (`photon.komoot.io`, httpx); if supplied coords are >100 km from where
   the label geocodes, the label wins.
7. `city_stats.total` = number of feed items (honest count; empty-state copy
   distinguishes "first here" from "seen everyone").
8. Self-exclusion: you never see your own card. "I see my own video" = the person
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
- Demo cards: "✨ AI DEMO" badge + "HEAR ME SAY MY NAME" chip; never matchable
  (70% auto-match on like is demo-only and gated behind a real reverse-like check).
- **Tests must never use demo-NN users as mutable subjects** — healing resets them
  mid-test (see §14).

---

## 9. Media / Video Pipeline

- Recording: `VideoPick.js` — MediaRecorder with `pickRecorderMime()` probing
  (webm → mp4 → default; iOS Safari records mp4, Chrome/Android record webm).
  The camera box has `shrink-0` + `minHeight: 360` — **load-bearing**: flex-column
  pages crush aspect-ratio boxes to zero on small iPhones.
- Upload: `POST /users/video/upload` multipart → size-capped spool (25 MB) →
  **if webm: transcode to H.264/AAC mp4** (`transcode.py`, imageio-ffmpeg static
  binary; fallback = store webm if the encode fails) → GCS
  `gs://nicemeechu/user_videos/<uid>.mp4` (publicRead per-object ACL,
  `cache_control` 1 y) → returns public URL + `?v=` cache-bust. The
  other-extension sibling is deleted so re-records never serve stale.
- **One-shot migration** `transcode_webm_videos_v1` (server.py, background task on
  startup): repoints every non-demo `.webm` `video_url` to an mp4 sibling in GCS
  (transcodes if the sibling is missing, reuses if present). Webm originals are
  KEPT (the other environment's un-migrated URLs must not 404). Ran in both
  environments; all production webm blobs have mp4 siblings.
- Face/age check: `POST /video/face-check` — GPT-4o vision confirms one real face,
  content safety, and an age-assurance gate (hard block <16; block 16–17 claiming
  adult). Fail-open when the LLM key is missing. Audit trail in `db.age_checks`.
- Share cards: `GET /og/{handle}` renders branded PNGs with PIL (LiberationSans).
- `FeedCard.js` renders ONE `<video><source>` with a query-string-safe extension
  check (the old dual-source webm probe was removed — it also broke the `type=`
  attribute on `?v=` URLs).

---

## 10. Push Notifications (VAPID Web Push)

- Keys in backend/.env; `push.py` via pywebpush; subs in `db.push_subscriptions`
  (unique endpoint index); opt-in flag `users.notify_new_nearby` (LEGACY NAME —
  it now gates match & message pushes only).
- **Events (current)**: new match ("💌 It's a match…", tag `match-<id>`) and new
  message ("💬 New message from…", tag `chat-<match_id>`), both via
  `notify_user()`, both deep-linking `/?chat=<match_id>`.
- **REMOVED (owner request)**: the "👋 Someone new just joined near <City>"
  broadcast and its first-video trigger. Do not re-add unprompted.
- UI: single opt-in surface — Profile row toggle (`notify-me-toggle`), copy
  "Notify me: matches & messages". The empty-feed "Notify me" pill was removed.
- `sw.js` handles push + notificationclick + resubscribe; NO fetch/caching.
- iOS web push only works for Home-Screen PWAs (16.4+). The iOS native wrapper
  has push **stubbed** (placeholder Firebase plist; drop in a real one later).

---

## 11. Store Distribution (PARKED — owner will publish months from now, do not nudge)

### Android — Google Play (artifacts READY)
- TWA via Bubblewrap: `/app/android-build/twa-project`. Package
  `com.nice2meechu.app`, versionName 1.0.1, versionCode 2.
- **Signing keystore: `/app/android-build/twa-project/android.keystore` (alias
  `android`) — BACK IT UP; losing it forces a new package id.**
- Downloads at `/store-assets/` (frontend/public): `nice2meechu-play.aab`,
  `play-icon-512.png`, `feature-graphic-1024x500.png`, `play-listing.md`
  (copy-paste listing text + content-rating + data-safety cheat sheets).
- `/.well-known/assetlinks.json` holds the LOCAL keystore SHA-256. When the owner
  eventually uploads to Play, Google re-signs → the *App signing key certificate*
  SHA-256 from Play Console must be appended to assetlinks.json + redeployed,
  or the installed app shows a browser URL bar.

### iOS — App Store (project READY; first cloud build never run)
- Wrapper at `/app/ios-build/ios-app/` (khmyznikov/ios-pwa-wrap template):
  bundle `com.nice2meechu.app`, Team `J99N4XLB3D`, v1.0.0, loads nice2meechu.com,
  auth popups allowed (appleid.apple.com, accounts.google.com), WKAppBoundDomains
  set, icons generated (alpha-flattened), descriptive camera/mic/location strings,
  ATS ArbitraryLoads=false, arm64, no remote-notification bg mode.
- **HealthKit fully removed** (rejection risk). Placeholder
  `GoogleService-Info.plist` present AND git-trackable (the template .gitignore
  that hid it was removed — it broke clean-checkout builds).
- **NOT COMPILE-TESTED** (no Xcode on Linux) — babysit the first Codemagic build.
- Pipeline: `/app/codemagic.yaml` — workflow `ios-appstore`: pod install → auto
  signing via ASC API key integration named **exactly `nice2meechu-asc`** →
  build-ipa → auto-publish to TestFlight.
- Owner's eventual steps are written out in `/app/ios-build/README.md`
  (Save to GitHub → ASC app record → ASC API key → Codemagic → TestFlight).
- Review posture: SIWA ✔, in-app account deletion ✔, UGC report/block ✔,
  permission strings ✔.

---

## 12. Credentials & Env Inventory

**backend/.env** (never git-tracked): `MONGO_URL`, `DB_NAME`, `CORS_ORIGINS`
(explicit allowlist — NEVER `*`), `EMERGENT_LLM_KEY`, `GOOGLE_CLIENT_ID`,
`ADMIN_EMAILS`, `GCP_PROJECT_ID`, `GCS_BUCKET=nicemeechu`,
`GOOGLE_APPLICATION_CREDENTIALS=/app/backend/gcs-credentials.json`,
`VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`, `APPLE_SERVICE_ID`,
`INACTIVE_CLEANUP_*` tunables.

**frontend/.env**: `REACT_APP_BACKEND_URL`, `REACT_APP_GOOGLE_CLIENT_ID`,
`REACT_APP_APPLE_SERVICE_ID`.

**User-held, not in repo**: Apple Developer account, ASC API .p8, Google Play
account, Android keystore passwords, GCS JSON key (file git-ignored).

**Test credentials**: `/app/memory/test_credentials.md` (git-ignored) — includes
`TEST_SESSION_TOKEN` (365-day QA session) and the QA fixture-state contract.

**Safety/privacy contact**: Google Form (no domain email exists) —
constant `SAFETY_CONTACT_URL` in `LegalPages.jsx`; auto-notifies
localfiveguy@gmail.com.

---

## 13. Security Posture (audited + code-reviewed 2026-06, fixes verified)

- CORS: explicit origin allowlist, credentials on. (Preview ingress injects
  `ACAO:*`, harmless — browsers reject wildcard+credentials.)
- `/translate` auth-required + 2000-char cap; message/transcript caps.
- OG cache bounded (500, FIFO); bogus handles uncached.
- Auth errors generic to clients; details in server logs only.
- `/users/video` URL-prefix validation (GCS / user-videos only).
- Apple email linking requires `email_verified`.
- Unique user indexes + insert race guard.
- Upload pipeline: MIME allowlist (webm/mp4, codec-suffix normalized), 25 MB cap,
  spooled read (no OOM), transcode in temp dir with cleanup.
- **Accepted risks** (deliberate — do not "fix"):
  localStorage token fallback (iOS Safari), no per-user rate limiting yet (P3).
- `.env`, `gcs-credentials.json`, `memory/test_credentials.md` are NOT git-tracked
  → safe for the GitHub push Codemagic needs.

---

## 14. Testing

- Backend: `/app/backend/tests/` — 9 files, **109 tests, all passing**. Run:
  ```
  cd /app/backend
  export TEST_SESSION_TOKEN=<from /app/memory/test_credentials.md>
  export REACT_APP_BACKEND_URL=<from /app/frontend/.env>   # some suites need it
  python3 -m pytest tests/ -q
  ```
- Notable suites: `test_home_town_feed.py` (8 km same-town rules, Evesham↔Marlton
  absorption, no-leak to Cherry Hill/Erial, nearby-radius endpoint 404),
  `test_webm_transcode.py` (BYTE-LEVEL: uploaded webm must serve `ftyp` mp4 with
  h264+aac — this catches the "URL renamed but bytes not transcoded" class of bug),
  `test_home_city.py`, `test_refactor_regression.py`, etc.
- QA account: `qa-tester@nice2meechu.local`, id `2b0f5a67-…` — **fixture
  contract**: home_city MUST stay "Tokyo, Japan" (test_home_city.py asserts it);
  browsing city Marlton NJ; has `age`, `agreed_to_rules_at`, `handle`, and a real
  `video_url` so a cookie login lands directly on the Feed.
- Persistent fixtures: `test-john-erial` (Erial), `test-kathy-cherryhill`
  (Cherry Hill) — now have REAL playable mp4s at
  `gs://nicemeechu/user_videos/test-john-erial.mp4` / `test-kathy-cherryhill.mp4`
  (the old placeholder `storage.googleapis.com/test-fixtures/intro.mp4` is a 403
  and rendered as a black card — don't reuse it for anything user-visible).
  GCS-style URLs keep the ghost purge away; if a fixture vanishes, the purge ate
  it: re-seed with a GCS-style URL.
- Rules learned the hard way:
  - Never use demo-NN users as mutable test subjects (healing resets them mid-test).
  - Tests needing a specific browse city must set it themselves (no file-order deps).
  - **Headless Chromium (Playwright) has NO H.264 codec** — every mp4 (demos
    included) reports MediaError 4 / readyState 0 in automation. That is a
    test-browser limitation, NOT an app bug. Verify codecs with ffprobe instead.
- Testing-agent artifacts: `/app/test_reports/iteration_1..24.json`, `/app/test_result.md`.
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
     validate the source; (d) build stamps end deploy ambiguity; (e) when stuck,
     ship a diagnostic endpoint and get direct evidence.
2. **Real videos black on iPhone — RESOLVED (v1.6.5/v1.6.6, deployed)**
   - 16/20 real intros in GCS were `.webm` (Chrome/Android MediaRecorder);
     iOS Safari cannot decode webm. Demo videos are mp4 → they always played,
     which disguised the pattern.
   - Fix: server-side webm→mp4 transcode on upload + one-shot URL-repoint
     migration + pre-rendered mp4 siblings for all prod blobs (shared bucket).
   - **Testing-agent save**: the first patch renamed the URL and set
     Content-Type mp4 but uploaded the ORIGINAL webm bytes (a closure captured
     `spool` instead of the transcoded handle). Byte-level assertions
     (`body[4:8] == b'ftyp'`, ffprobe h264) are now in the suite. Lesson:
     verify CONTENT, not just status codes and file names.
3. Failed prod deploy: k8s probes need root `GET /health` — never remove.
4. Apple Hide-My-Email duplicate: relay email ≠ Gmail → duplicate account.
   Manual merge done for the operator; automated linking is backlog.
5. iOS camera box crush: flex columns squeeze aspect-ratio boxes to 0 — the
   `shrink-0`/minHeight on VideoPick is load-bearing.
6. iOS Safari cookie drops: the Bearer/localStorage fallback exists because ITP
   eats SameSite=None cookies during OAuth redirects.
7. **Nearby-radius feature reversal (v1.6.6)**: the owner tried the 10/25/50 km
   nearby system live and rejected it — he does not want a video appearing
   outside its own town. It was REMOVED end-to-end (feed, endpoint, UI, chips,
   widen prompts, join-nearby push). The 8 km `SAME_TOWN_KM` tolerance is the
   only coordinate slack, and it exists solely for same-town naming variants
   (Marlton↔Evesham). Do not resurrect radius spreading without his explicit ask.
8. Placeholder fixture URLs look like real bugs: a dead `test-fixtures` video URL
   rendered as a black card and the owner reported it as "videos not working".
   Preview seed data must always be actually playable.
9. iOS template landmine: the wrapper's `.gitignore` hid `GoogleService-Info.plist`
   → clean-checkout builds fail. Removed; watch for it if re-generating.

---

## 16. Runbooks

- Restart: `sudo supervisorctl restart backend frontend`
- Logs: `tail -n 100 /var/log/supervisor/backend.*.log`
- Smoke: `curl $API/api/` (check `build`), `curl localhost:8001/health`
- Prod feed forensics: sign in as an admin on nice2meechu.com, then open
  `https://nice2meechu.com/api/admin/diagnose-feed` in the same browser
  (shows locals + same_town candidates, browse center, geocache, build).
- Force demo re-seed/heal/purge: any authenticated `GET /api/feed`.
- Re-run a one-shot migration: delete its marker doc from `db.migrations`
  (`repair_user_coords_v1` or `transcode_webm_videos_v1`), restart backend.
  The webm migration is idempotent and safe to re-run (skips existing mp4s).
- Mint a test session: insert into `user_sessions`, or copy `n2m_token` from
  localStorage after a UI sign-in. (Recipe in /app/memory/test_credentials.md.)
- Manually transcode a video: `python3 -c "from transcode import transcode_to_mp4;
  transcode_to_mp4('in.webm','out.mp4')"` from `/app/backend`.
- Full user wipe: users + user_sessions + swipes (both sides) + matches
  (user_ids) + messages. `DELETE /api/users/me` does it for self.

---

## 17. Current Status, Backlog & Etiquette

**Deployed & verified**
- v1.6.6-home-town-only is LIVE on nice2meechu.com (build stamp checked).
  It contains: webm→mp4 playback fix, home-town-only feed, nearby system removal,
  join-nearby push removal, Apple-first iOS sign-in ordering.

**Awaiting owner verification**
- Owner to confirm on his iPhone that real videos now play in Erial / Egg Harbor /
  Marlton on production. (They will only appear in each person's own home town now.)

**Parked (owner-scheduled, months out — DO NOT nudge)**
- Play Store publishing (AAB ready; assetlinks SHA-256 step documented in §11).
- App Store / Codemagic first build (project ready; steps in /app/ios-build/README.md).

**Backlog (P2/P3)**
- Per-user rate limiting (swipes, messages, reports)
- Apple↔Google account-linking flow (Hide-My-Email dedupe)
- Native FCM push in the iOS wrapper
- Referral/invite share flow polish (referral fields already in the data model) —
  the main growth lever now that feeds are strictly home-town
- "You're one of the first in <town> — invite a neighbor" empty-state welcome card
- Component refactors: ChangeLocationScreen (~520 lines), VideoPick, FeedScreen, App.js
- CI: wire the 109-test suite into GitHub Actions once the repo is on GitHub
- Store listing screenshot polish; localized listings

**Working etiquette with this owner**
- Non-technical; give click-by-click, browser-only instructions.
- Always clarify preview vs production before debugging a report.
- He values honest hyperlocal behavior over engagement tricks — when in doubt,
  choose "show only what's real and local" and confirm scope with him first.
- Do not bring up store publishing unprompted.
