# Nice2Meechu — Product Requirements Doc


## Updated (2026-06-21 part 7) — PRODUCTION BUG FIX: Tokyo demos in the Marlton feed 🐛✅

- **Report**: user browsing Marlton NJ saw 12 Tokyo AI demos labelled "FROM TOKYO · 0 KM"; Marlton locals appeared but were auto-skipped (already swiped → PASSED/LIKED chips; feed resumes at first unswiped card = Yui/Tokyo).
- **Root cause**: the viewer's production record had `city="Marlton"` but `city_lat/city_lng` stuck on Tokyo's EXACT center (35.6762, 139.6503) from an earlier Tokyo browse. The nearby-towns Haversine scan ran around Tokyo → all Tokyo demos (whose home coords are exactly that center) matched at 0.0 km. Reproduced 1:1 in preview.
- **Fix (`feed.py _browse_center`)**: when the browse city has local candidates, the nearby center is anchored to the locals' MEDIAN home coords; the stored `city_lat/city_lng` is only trusted if within 100 km of that. On mismatch the feed **self-heals** the user doc (updates `city_lat/city_lng`) and logs a warning — so the production record fixes itself on the user's first feed load after redeploy. Heal is one-shot (verified: second request trusts the corrected coords).
- Verified in preview: corrupted viewer now gets Marlton locals + Voorhees 3.2 km + Cherry Hill 10.5 km + Erial ~15 km, ZERO Tokyo. Regression 33/33.
- ⚠️ REQUIRES REDEPLOY to reach production.
- **Round 2 (deploy 56 didn't clear it)**: production Marlton locals likely have NO stored coords (geolocation denied + typed city), so the locals-median heal silently skipped. `_browse_center` now falls back to a **server-side Photon geocode** of the city label (`_geocode_city`, cached in `db.city_geo`, User-Agent header required, failures not cached). Verified: viewer with Tokyo coords + coordless locals → geocode resolves Marlton NJ (39.9006,-74.9339) → healed → zero Tokyo. Regression 33/33. Needs redeploy (57).
- **Round 3 — ORIGINAL CORRUPTION VECTOR found & killed**: `/api/cities/popular` used `$first` resident's coords with a fallback to their BROWSING coords (`city_lat`) — a Marlton resident exploring Tokyo poisoned the "Marlton · 3 people" list entry with Tokyo coordinates, and tapping it wrote city="Marlton"+Tokyo coords onto the viewer. Fixes (all verified):
  1. Popular-cities coords = `$avg` of residents' HOME coords only (never browsing coords); cities where no resident has coords get geocoded server-side.
  2. `POST /users/location` now geocode-validates: if supplied coords are >100 km from where the city label geocodes, the label wins (logged warning). Kills the corruption at the source for any client, stale frontends included.
  3. Feed `_browse_center` heal (rounds 1-2) remains as the last line of defense.
  `_geocode_city` moved to core.py (shared by feed + users). Regression 33/33. ⚠️ Needs redeploy.
- **Follow-up (same session)**: feed city pill now shows the full "region, country" line under the town name (`feed-location-detail` testid) so a location mix-up is instantly visible. Verified via screenshot.


## Updated (2026-06-21 part 6) — Push deep-linking into chats ✅

- Match & message pushes now carry `url: /?chat=<match_id>`. `sw.js` notificationclick navigates the focused tab (or opens a new one) to that URL.
- `App.js`: captures `?chat=` at mount into `pendingChatRef` (URL stripped immediately); after auth hydration, `openPendingChat()` fetches `/api/matches`, finds the match, and lands straight in ChatScreen. Falls back to normal routing for bad/foreign ids or incomplete onboarding. GA event `push_deep_link_opened`.
- ⚠️ StrictMode gotcha (documented in code): hydration effect double-runs in dev; the pending-chat ref is intentionally NOT cleared on success (second run would stomp chat with feed). Cleared on sign-out.
- Verified via Playwright: `/?chat=<id>` opens the right chat with message visible + cleaned URL; normal load and bogus-id both land on feed. Regression 33/33.


## Updated (2026-06-21 part 5) — Match & message push notifications ✅

- New `notify_user(user_id, body, url, tag)` helper in `push.py` — single-recipient push gated on the same `notify_new_nearby` opt-in; per-thread `tag` (supported in sw.js) collapses same-conversation notifications instead of stacking.
- **Match**: `feed.py swipe()` fires "💌 It's a match with {codename}! Say hi!" (tag `match-<id>`) to the other side when a match is created. No-op for demos/opted-out.
- **Message**: `messaging.py send_message()` fires "💬 New message from {codename}" (tag `chat-<match_id>`) to human recipients only (demo auto-replies never push — the human is actively in the chat).
- Profile toggle + enable toast copy updated: "Notify me: new people, matches & messages".
- Verified via curl: match creation → `match-` push logged; message → `chat-` push logged; opted-out recipient → correctly skipped. Regression suite 33/33. Real delivery still needs the real-device check noted in part 3.


## Updated (2026-06-21 part 4) — Code review fixes applied ♻️

- **Backend complexity refactors** (all verified by the 33-test regression suite, 33/33 pass):
  - `feed.py`: `feed()` split into `_prior_actions`, `_local_candidates`, `_nearby_candidates`, `_radius_suggestion`, `_liked_me_ids`, `_feed_item`, shared `_bbox_filter`.
  - `auth.py`: `_finalize_google_signin` split into `_upsert_google_user` + `_mint_session`.
  - `media.py`: `face_check` split into `_llm_review_frame`, `_apply_age_gate`, `_audit_age_check`.
  - `push.py`: `notify_new_nearby` split into `_radius_covers`, `_matching_recipient_ids`, `_deliver_to_subscriptions`.
  - `admin.py`: `admin_funnel` split into `_funnel_steps` + `_top_cities`.
- **Frontend**: extracted `components/EmptyFeedState.js` from FeedScreen (445→345 lines); fixed the one REAL react-hooks warning (App.js unread-poll effect now keys off `userId`); improved the lone undocumented empty-catch comment (LegalPages consent). Webpack compiles with ZERO warnings.
- **Review findings assessed as false positives / intentionally kept** (documented so future reviews don't re-flag):
  - "Hardcoded secrets in tests" — all tokens are `uuid4()`-generated per run; nothing real.
  - "Insecure localStorage token" — INTENTIONAL: the `n2m_token` localStorage fallback is the fix for iOS PWA cookie isolation (ITP drops the httpOnly cookie). The httpOnly cookie IS still primary. Do not remove.
  - "39 missing hook deps" — CRA's own eslint reports only the one App.js case (fixed); the others were tool hallucinations (`IntersectionObserver`, `L`, `classList` are not reactive values).
  - "`is` comparisons / undefined Python vars" — grep + pyflakes found zero real instances.
  - "console statements" — all are `console.error/warn` inside catch blocks (proper error logging, no sensitive data); kept.
  - Deferred (high regression risk, need dedicated session + full E2E): splitting `App.js` (325 l), `FeedCard.js` (292 l), `CityAutocomplete.js`, `ChangeLocationScreen.js` (557 l) into sub-components/hooks.


## Updated (2026-06-21 part 3) — Opt-in Web Push: "someone new joined nearby" ✅

- **Pure browser-native Web Push (VAPID)** — no Firebase/OneSignal. `pywebpush` added to backend; VAPID keys in `/app/backend/.env` (`VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`). ⚠️ Keep these keys stable — rotating them breaks all existing subscriptions.
- **Backend `/app/backend/push.py`**: `GET /api/push/public-key` (public), `GET /api/push/status`, `POST /api/push/subscribe` (upserts into `db.push_subscriptions`, unique endpoint index, sets `users.notify_new_nearby=true`), `POST /api/push/unsubscribe`. `notify_new_nearby(new_user)` pushes "👋 Someone new just joined near {City} — come say hi!" to every opted-in user whose home city matches OR whose `nearby_radius_km` covers the new user's home (Haversine). Stale endpoints (404/410) auto-deleted.
- **Trigger**: `POST /api/users/video` fires the notify task only on the user's FIRST intro video (re-records don't re-notify).
- **Frontend**: `public/sw.js` (push + notificationclick + pushsubscriptionchange resubscribe; NO fetch/caching interception), registered in `index.js`. `lib/push.js` helpers (enable/disable, iOS install gate via `isIosWebkit && !isStandalonePwa`). `components/NotifyMeButton.js` — pill variant in BOTH feed empty-state branches (`notify-me-btn`), row variant in Profile (`notify-me-toggle`).
- Verified via curl: subscribe → status → first-video trigger (1 recipient matched) → re-save no-retrigger → unsubscribe clears flag. UI verified via Playwright on both surfaces; actual pushManager.subscribe can't run in headless (Chrome blocks Push API in incognito) — **needs a real-device check** (Android Chrome + iOS installed PWA).


## Updated (2026-06-21 part 2) — Empty-feed widen-radius retention prompt ✅

- **Backend `/api/feed`**: now returns `radius_suggestion: {current_km, next_km, extra_people}` when the next radius tier (10→25→50) would surface ≥1 more person (bounding-box + Haversine ring count, excludes people already in the feed). `null` at 50 km or when nothing extra exists.
- **Frontend FeedScreen**:
  - Empty state (first-in-city AND exhausted branches): primary button "{N} people within {next} km — widen?" (`feed-widen-radius-btn`); "Explore another city" demotes to ghost style when the widen option shows.
  - Last-card banner: when the viewer reaches the final video and a suggestion exists, a pill under the header shows "Only {feed.length} within {X} km — widen to {Y} km? (+{extra})" (`feed-widen-radius-banner-btn`). Positioned top-24 — bottom placement collided with BottomNav (z-40) and intercepted clicks.
  - One tap → POST `/users/nearby-radius` → optimistic `setUser` radius update → toast → feed reload. Tracked as `radius_widened` GA event.
- Verified end-to-end via Playwright: empty-state button (0→9 people) and last-card banner (1/1→1/10) both work; banner disappears once at max useful radius.
- ⚠️ Fixed during this work: feed.py had a corrupted duplicate tail (leftover from refactor edit) — removed.


## Updated (2026-06-21) — Backend modularization COMPLETE ♻️✅

- Split the 2,125-line monolithic `server.py` into modular FastAPI routers under `/app/backend/`:
  - `core.py` — config, Mongo client, GCS lazy init, shared helpers (haversine, codename gen, city-noise stripping, LANG_NAMES, OG cache)
  - `models.py` — all Pydantic request models
  - `auth.py` — Google sign-in (popup + redirect), session exchange, `current_user` dependency, logout
  - `users.py` — onboarding, community rules, location/home, nearby-radius, GDPR export/delete, report/block, GCS video upload
  - `feed.py` — feed (Haversine nearby), swipe (like/unlike/pass/block), matches, cities/popular
  - `messaging.py` — chat messages w/ cached AI translation, /translate
  - `media.py` — GPT-4o face/age check, OG share-card PNG rendering, handoff.md download
  - `demos.py` — demo-user seeding, /demos/sample, /samples
  - `admin.py` — funnel dashboard, inactive-video cleanup + daily background loop
- New `server.py` is a ~150-line thin entrypoint: includes all routers with `/api` prefix, static mounts (videos, user-videos, share-cards), CORS, and startup migrations (legacy demo retirement, city-noise cleanup, home-city backfill) + cleanup scheduler. Supervisor entrypoint unchanged (`uvicorn server:app`).
- Route parity verified via openapi.json: 32/32 paths. Full regression: **33/33 backend tests pass** (`/app/backend/tests/test_refactor_regression.py`, report `/app/test_reports/iteration_20.json`). Zero behavior changes.
- User decision (2026-06, superseded): originally NO Sign in with Apple — reversed once App Store submission required it (see 2026-06 SIWA section below).


## Updated (2026-06-20) — Android APK build (TWA) ✅

- **Built a signed Android APK** (`com.nice2meechu.app` v1.0.0, ~1.6 MB) and matching `.aab` (~1.8 MB) using **Bubblewrap / Trusted Web Activity** wrapping `https://nice2meechu.com`. TWA lets the system Chrome run the live site full-screen, so Google Sign-in, camera, mic and geolocation work natively without any code changes.
- **Pod plumbing**: installed OpenJDK 17 + Android SDK 34 + build-tools 34.0.0; pod is aarch64 but Android SDK ships x86_64 binaries — wrapped `aapt2` (both SDK copy and the Gradle-cached `androidx` copy), `aapt`, `zipalign`, `dexdump` in qemu-x86_64-static shims after installing `libc6:amd64`/`libstdc++6:amd64` via dpkg multiarch. Build now reproducible inside the pod.
- **PWA manifest + Digital Asset Links** added to `/app/frontend/public/manifest.json` and `/app/frontend/public/.well-known/assetlinks.json` (with the APK's SHA-256 fingerprint `02:65:F5:AC:…:71`). Once redeployed, the assetlinks file lets the TWA render full-screen without a URL bar. Until then, the APK falls back to a Custom Tab (still works, slim URL bar).
- **Icons**: generated 512×512 + maskable 512×512 N2M logos, served from `/icon-512.png` and `/icon-maskable-512.png`. Linked from `<link rel="manifest">` and `apple-touch-icon`.
- **Distribution**: APK + AAB copied into `frontend/public/` so they're downloadable from `https://nice2meechu.com/nice2meechu.apk` and `…/nice2meechu.aab` after the next prod deploy.
- **Keystore**: `/app/android-build/twa-project/android.keystore` (password `nice2meechu`, alias `android`). MUST be kept for every future update; losing it forces a new package id.
- Full rebuild instructions + Play-Store-publishing checklist in `/app/android-build/README.md`.


## Updated (2026-02-07) — Split monolithic App.js into per-screen modules ♻️

- **App.js**: 3090 → 292 lines (~90% reduction). Now a pure orchestrator (routing, auth lifecycle, top-level state).
- **New structure** under `/app/frontend/src/`:
  - `lib/` — `api.js` (axios client + translate + share helpers), `constants.js` (LANG_OPTIONS, EMOJIS, COMMUNITY_RULES, GOOGLE_CLIENT_ID), `cityFormat.js` (Photon label formatting), `ua.js` (iOS WebKit detection).
  - `components/` — 7 reusable components: VideoEl, CityAutocomplete, SignaturePad, BottomNav, ShareCard, MatchCelebration, FeedCard.
  - `screens/` — 10 screen files, one per route: Splash, SignInScreen, AuthCallback, Onboarding, CommunityRulesScreen, VideoPick, FeedScreen, ChangeLocationScreen, MatchesScreen, ChatScreen, ProfileScreen.
- **Zero behavioral changes** — pure structural refactor. Build compiles cleanly. Sign-in screen renders identically. No new console errors.
- Largest single file is now FeedScreen.js (404 lines), down from a 3090-line god file. All other files <330 lines.

## Updated (2026-02-07) — iOS Safari Google Sign-In fix (redirect-mode) + automated inactive-video cleanup ✅

- **iOS Safari sign-in fix**: GIS popup mode is blocked by iOS WebKit ITP, leaving iPhone users unable to sign in. `SignInScreen` now detects iOS (`isIosWebkit()` checks UA + iPadOS `MacIntel`/touch heuristic) and switches `ux_mode` to `"redirect"` on iOS only — desktop + Android keep popup mode for the snappier UX.
- **Backend `/api/auth/google-redirect`**: now accepts `?ref=<handle>` query param so referral codes survive the iOS redirect path (popup path keeps reading from localStorage). Returns 303 → `/?auth_error=<code>` on failure; `App.js` mount-time hydration now reads `auth_error` and toasts the user.
- **⚠️ User action required**: register the redirect URI `https://<your-prod-domain>/api/auth/google-redirect` AND the preview URI under "Authorized redirect URIs" in the Google Cloud Console OAuth 2.0 Client settings. Without it Google will reject the redirect.
- **Automated inactive cleanup**: `_run_inactive_cleanup()` helper extracted from the admin endpoint. New `@app.on_event("startup")` spawns `_inactive_cleanup_loop` — sleeps 15min, then runs `dry_run=False` cleanup every 24h. Tunable via `INACTIVE_CLEANUP_ENABLED` / `INACTIVE_CLEANUP_DAYS` / `INACTIVE_CLEANUP_INTERVAL_SECONDS` / `INACTIVE_CLEANUP_INITIAL_DELAY_SECONDS`. Manual admin curl still works.
- Backend testing: 18/18 in-scope tests pass (TestGoogleRedirectMode, TestGoogleIdTokenPopup, TestAdminGate, TestRoot, TestAuthGuard). iPhone happy-path verification deferred to user.


## Updated (2026-06-05 part 3) — Feed playback controls + per-city position memory ✅
- **Backend `/api/feed`**: now returns the FULL set of users in the viewer's city (chronological, oldest-first), not just the unswiped ones. Each item gets `prior_action` (null | "like" | "pass" | "block"). Blocked users still excluded entirely. Also returns `saved_position` from `user.city_positions[city]`.
- **Backend `/api/swipe`**: now an upsert — re-swiping a target overwrites the prior action. Match logic skips if a match already exists between the pair (Back→Like rewatch is safe and doesn't duplicate matches).
- **Backend new endpoint** `POST /api/users/me/city-position` — saves `{city, index}` to `user.city_positions[city_lowercase]`. Frontend writes it debounced 600ms after each active-index change.
- **Backend `/api/cities/popular`**: excludes the requesting user from the count, so "2 PEOPLE in Wildwood" doesn't tick up just because you moved there.
- **Frontend FeedScreen**: bottom-left overlay now shows `[← Back] [↻ Restart]` and bottom-right shows `[N/Total]` counter (1-indexed). Skip/Like remain on each card's right edge. Restart pops a confirmation modal that explicitly says "won't reset your likes or passes". On feed load: resume from `saved_position` first, else first-unswiped, else 0. Optimistic swipe state — Back/Restart preserves visible state. Auto-advance only fires when the swipe was on the active card (so swiping on a back-viewed video doesn't yank the viewer back to position).
- **Verified end-to-end via Playwright**: feed loads with 11/11 counter (12 SP demos - 1 self), back button disabled at idx 0, playback controls visible.

## Updated (2026-06-05 part 2) — Safety/privacy contact swapped from email to Google Form ✅
- User chose to skip paid email hosting (Network Solutions wanted $2.99/mo; Cloudflare requires DNS migration). Replaced all `mailto:safety@nice2meechu.com` / `mailto:privacy@nice2meechu.com` references with a single Google Form: https://docs.google.com/forms/d/e/1FAIpQLSe-57lGZwk9_6EOD5ZT1nkurdpges3sYznY0QJa5oRrhsZybg/viewform
- Form auto-emails operator at `localfiveguy@gmail.com` on submit (response notifications turned on in the form's Responses tab).
- Touched: `LegalPages.jsx` (Privacy Policy + Terms contact, GDPR access link, CSAM section), `App.js` (Profile "Report safety" link, delete-account toast, download-data toast, report-user error toast). All open in new tab with `rel="noopener noreferrer"`.
- Exported `SAFETY_CONTACT_URL` constant from LegalPages so it's a single source of truth.
- ⚠️ Side effect: the docs reference `/app/EMAIL_ROUTING_SETUP.md` is now obsolete — we never set up domain email. Keeping it for posterity but noting it's not active.

## Updated (2026-06-05) — GCS migration COMPLETE ✅
- Replaced local-disk write in `POST /api/users/video/upload` with Google Cloud Storage upload to `gs://nicemeechu/user_videos/<uid>.<ext>`. Files now persist across container restarts and redeploys.
- Per-object `publicRead` ACL — individual videos playable via `<video src=...>`, bucket itself stays unlisted.
- Used `google-cloud-storage` + `run_in_threadpool` to keep the async event loop free. SpooledTemporaryFile buffers up to 4 MB in RAM, spills to disk for larger files. 25 MB cap retained.
- Cross-extension cleanup retained (Safari mp4 ↔ Chrome webm).
- Env vars: `GCP_PROJECT_ID=gen-lang-client-0271718241`, `GCS_BUCKET=nicemeechu`, `GOOGLE_APPLICATION_CREDENTIALS=/app/backend/gcs-credentials.json`.
- Service account `nice2meechu-video-uploader@gen-lang-client-0271718241.iam.gserviceaccount.com` with role `Storage Object Admin` on the bucket. Bucket location: `us-east1`, fine-grained access control, public access prevention OFF.
- Verified end-to-end: 2 MB mp4 → 200 + GCS public URL → anonymous fetch returns 200 with correct `Content-Type: video/mp4` and exact byte size; bad MIME → 415; unauth → 401.
- ⚠️ Service account key was pasted in chat during setup — recommend rotating it after deploy.


## Original Problem Statement
A hyperlocal, video-first social app where users connect by watching short video introductions instead of looking at static photos. Anonymity until matching, low-friction onboarding, simulated real-time AI audio translation to break language barriers.

## User Personas
- **The newcomer in a new city** — needs to meet locals quickly, may not speak the local language.
- **The introvert** — prefers to be seen as themselves on video without revealing identity upfront.
- **The night owl** — wants spontaneous, hyperlocal connections rather than long-distance matching.

## Core Requirements (static)
- Phone-OTP sign-in (Twilio Verify; DEV/mock fallback when keys missing).
- Low-friction onboarding: codename handle, 1-5 vibe tags, native language, aura emoji.
- Video intro: pick a curated sample OR record a 10s clip via browser camera.
- Hyperlocal: browser geolocation; distance-km badge.
- Anonymity until match: avatar/video blurred, only codename shown; reveal handle + clear blur on mutual like.
- Real-time AI translation of intro caption into user's native language (OpenAI gpt-4o-mini via Emergent LLM Key).
- Tinder-style swipe: Like / Pass; mutual = match.
- Match celebration screen.
- In-app chat per match.
- Profile screen: edit handle / vibes / language / emoji / change video.

## Implemented (2026-02-28)
- Backend: FastAPI + MongoDB. Endpoints: `/api/auth/session` (exchange Google OAuth session_id), `/api/auth/me`, `/api/auth/logout`, `/api/users/onboarding`, `/api/users/me`, `/api/users/location`, `/api/users/video`, `/api/samples`, `/api/feed`, `/api/swipe`, `/api/matches`, `/api/messages/:id` (GET + POST), `/api/translate`.
- Auth: **Emergent-managed Google OAuth** (replaced earlier Twilio phone-OTP). `current_user` reads `session_token` cookie first, then `Authorization: Bearer` header as fallback. Sessions in `user_sessions` collection with 7-day TTL.
- OpenAI gpt-4o-mini translation via `emergentintegrations` + Emergent LLM Key.
- Demo users (6) auto-seeded with curated portrait videos + transcripts in EN/ES/FR.
- Frontend: single-page App.js with 9 screens (Splash, SignIn, AuthCallback, Onboarding, Video-pick, Feed, Matches, Chat, Profile) + Match celebration overlay. URL fragment `#session_id=` detected synchronously on mount to avoid auth race.
- TikTok-style vertical scroll-snap feed with auto-play of in-view item, like/pass, translation overlay with typewriter animation.
- Bottom nav (Feed / Matches / You) with active state.
- Design: Unbounded display + Manrope body fonts, red `#FF4D4D` × cyan `#00E5FF` palette on near-black, mobile-first 480px phone frame with desktop framing.

## Updated (2026-02-28 part 2)
- **Auth migrated from Twilio phone-OTP → Emergent Google OAuth.** No phone numbers or SMS keys needed; users sign in with their Google account.
- Backend: removed `/api/auth/send-otp` and `/api/auth/verify-otp`; added `/api/auth/session`, `/api/auth/me`, `/api/auth/logout`.
- Frontend: replaced PhoneScreen + OtpScreen with `SignInScreen` (Google button) and `AuthCallback` (handles `#session_id=` URL fragment).
- Code-review fixes applied: `secrets` module for cryptographically secure RNG (codename + demo seed + OTP-era); empty catch blocks now log; stable React keys instead of array indexes; nested ternary flattened.

## Updated (2026-06-02) — Production video playback fix (P0)
- Mobile users on `nice2meechu.com` saw black video cards in the Feed because the production static CDN served `/videos/*.mp4` as `application/octet-stream` (no MIME sniffing, no byte-range) → mobile Chrome/Safari refused to autoplay.
- **Fix:** moved sample videos from `/app/frontend/public/videos/` → `/app/backend/videos/` and mounted via `app.mount("/api/videos", StaticFiles(directory="videos"))`. FastAPI sets proper `Content-Type: video/mp4` / `video/webm`.
- Updated `SAMPLE_VIDEOS` constant to `/api/videos/v{n}.mp4`. Added one-shot startup migration that rewrites legacy `/videos/*` paths in `user.video_url` → `/api/videos/*`.
- Verified preview: `Content-Type: video/mp4`, `readyState: 4`, 480×270 dimensions, no error.

## Updated (2026-06-03) — AI-generated demo users (Sora 2)
- **Removed all stock/sample videos** (`v1.mp4`…`v6.mp4`) and the "Use a sample" toggle in `VideoPick`. Real users must record their intro now — no fallback.
- **New demo user pipeline:** `/app/backend/scripts/generate_demo_videos.py` generates Sora 2 talking-head videos via the Emergent LLM key, saves to `/app/backend/videos/demo_NN.mp4`, and writes `demo_meta.json` describing each persona (city, language, transcript, age, vibe, avatar, lat/lng).
- **City distribution by population rank:** top-12 metros, count per city = `13 - rank` → Tokyo:12, São Paulo:11, Mumbai:10, NYC:9, Lagos:8, LA:7, Paris:6, London:5, Toronto:4, Madrid:3, Sydney:2, Berlin:1. Total = 78.
- **Status:** 24 of 78 videos rendered before the Emergent LLM key hit `insufficient_balance`. Generator is idempotent. To resume → top-up balance + rerun the script. Steps in `/app/RESUME_DEMOS.md`.
- **Backend:** restored `seed_demo_users()` to read `demo_meta.json` and only insert demo users whose MP4 file exists on disk. New startup hook `_retire_legacy_sample_demos` deletes old stock-video demo rows so the feed only ever shows AI personas.
- Verified in preview: 24 demos seeded across 10 cities; first feed card shows "Velvet Tide · Tokyo · 2.8 km" with live JA→EN translated transcript.
- Local SDK patch applied: `emergentintegrations.llm.openai.video_generation.SIZES` now includes `720x1280` (upstream was missing it; required by Sora 2 API).
- The Change Location map now has a transparent **tap-catcher overlay** on top of the OSM iframe. User taps any spot → pixel coordinates convert to lat/lng via the rendered bbox → Photon reverse-geocode resolves a human-readable city/region → persisted via `POST /api/users/location`.
- Visual hint pill on the map: "📍 Tap map to pick" (turns into "Resolving…" during the API call).
## Updated (2026-06-02 part 3) — Tap map to pick
- New GA4 event: `location_map_tapped`.
- Verified: tapped east of Madrid → reverse-geocoded to "Madrid, España" → green toast → feed refreshed with Spanish demo user + live LLM EN-translation badge appeared.

## Updated (2026-06-02 part 2) — Change Location screen
- Replaced the per-card "distance pill" tap-target with a full-screen **Change Location** modal modeled on the alpha screenshot:
  - 🔎 City search with debounced Photon autocomplete (`layer=city` — works for Tokyo, etc.)
  - 📡 "Use my current location" button (browser geolocation + Photon reverse-geocode)
  - 🗺️ OpenStreetMap iframe preview centered on selected lat/lng (zero deps, no API key)
  - 🔥 "Popular cities" list — curated baseline of 12 global cities (NYC, LA, London, Tokyo, Paris, Berlin, Madrid, Sydney, Mumbai, Lagos, São Paulo, Toronto) merged with live MongoDB signup counts
- Backend: `GET /api/cities/popular` aggregates `users.city` (case-insensitive substring match), returns curated + real, sorted by people-count desc.
- `POST /api/users/location` now also accepts optional `city` so picking a popular city updates the profile city + lat/lng atomically.
- Feed pill now shows `· {city}` suffix on every card so you always see which city's feed you're browsing.
- New GA4 event: `location_changed`.
- Reverted the short-lived "distance filter" popover (1km/5km/25km/anywhere) — superseded by the location flow.

## Updated (2026-06-04 part 3) — Unread match notification dot ✅
- New backend endpoint: `GET /api/matches/unread` returns `{count}` of matches created after `user.last_matches_viewed_at` (uses `count_documents` for cheap polling).
- `GET /api/matches` now also bumps `last_matches_viewed_at = now` server-side — visiting the Matches screen naturally resets the unread count.
- App-level polling: re-fetches the count when the user object is set, when screen changes, and every 60s in the background. Also bumps locally by 1 on `onMatch` so the dot appears the instant a mutual match happens.
- UI: small green (#22C55E) pulsing dot rendered on the top-right of the You-tab avatar (or fallback `UserIcon`) when `unreadCount > 0`. `aria-label` includes count for screen readers.
- Verified end-to-end with Playwright: 1 unread → dot visible on Feed/Profile; tap Matches → dot disappears; subsequent navigation stays clean.

## Updated (2026-06-04 part 2) — Google profile picture as "You" tab affordance ✅
- Bottom nav: the `You` tab icon now renders the user's Google profile picture (26×26 circle) when `user.picture` is set, falling back to the generic `UserIcon` glyph for legacy users without one. Active state adds a red ring (`ring-2 ring-[#FF4D4D]`) for affordance.
- `BottomNav` now accepts a `userPicture` prop; all three call sites (`FeedScreen`, `MatchesScreen`, `ProfileScreen`) pass `user.picture`.
- `<img referrerPolicy="no-referrer">` so Google's CDN doesn't 403 the request from `nice2meechu.com`.
- Verified in preview: seeded test user with `picture` URL → avatar visible on Feed and on Profile (with red ring when active).

## Updated (2026-06-04) — Direct Google OAuth (GIS) migration ✅
- **Replaced Emergent-managed Google Auth with Direct Google Identity Services (GIS).** Removes the "double sign-in" intermediate Emergent auth page — user now sees ONLY the Google consent popup.
- Frontend: GIS script (`https://accounts.google.com/gsi/client`) loaded via `index.html`. `SignInScreen` now renders the official GIS button via `google.accounts.id.renderButton` (pill, filled_white, "continue_with") and uses `ux_mode: "popup"` with `itp_support: true` for Safari/iOS.
- Backend: new `POST /api/auth/google` endpoint verifies the Google-issued ID-token JWT cryptographically against Google's public keys (audience check = our `GOOGLE_CLIENT_ID`, issuer + expiry validated). On success it upserts the user (storing `google_sub`) and mints a fresh `session_token` cookie.
- Shared `_finalize_google_signin()` helper consolidates user-upsert + session-mint logic between the new endpoint and the legacy `/api/auth/session` (kept for backwards compat; no UI surface).
- Env: `GOOGLE_CLIENT_ID` (backend) + `REACT_APP_GOOGLE_CLIENT_ID` (frontend) added. No Client Secret required — GIS ID-token verification is signature-based, not code-exchange.
- Google Cloud Console: Authorized JavaScript origins set for both `https://hyperlocal-video.preview.emergentagent.com` and `https://nice2meechu.com`.
- Verified: GIS button renders on /signin, `/api/auth/google` rejects bogus JWTs (401), seeded session bears authenticated `/api/auth/me`.

## Prioritized backlog
- **P1** Real recorded-video upload to object storage ✅ done — `/api/users/video/upload` persists to disk; URL is stable across sessions.
- **P1** GDPR Art. 20 data-export endpoint ✅ done — `/api/users/me/export` + Profile "Download my data" button.
- **P1** Set up `safety@` / `privacy@` mailboxes via Cloudflare Email Routing — **checklist drafted at `/app/EMAIL_ROUTING_SETUP.md` (5 min DNS-only task for the owner).**
- **P2** Mark `onboarding_completed`, `community_rules_accepted`, `match_made`, `share_started` as Key Events in GA4 Admin.
- **P2** Push/online presence — show which matches are live now.
- **P2** Decommission old Netlify `nice2meechu` site once Emergent SSL stable ≥7 days.
- **P3** Voice-note replies; audio translation (TTS over translated text).
- **P3** Invite-only friends-of-friends discovery.
- **P3** Split `App.js` into per-screen files once it stops being a single-file brief.

## 2026-06 — iOS Safari cookie-drop sign-in fix
- Bug: on some iPhones (owner Steavin's), GIS redirect-mode sign-in bounced back to the sign-in screen with no error. Safari silently dropped the `session_token` cookie set during the cross-site 303 redirect (ITP bounce-tracking mitigation). Backend sign-in actually succeeded.
- Fix: `POST /api/auth/google-redirect` now 303-redirects to `/#st=<token>` (cookie still set as belt-and-braces). `App.js` mount hydration reads `#st=`, stores it as `n2m_token` in localStorage (axios sends it as `Authorization: Bearer`), and scrubs the fragment via `history.replaceState`. Fragments never leave the browser.
- Verified by testing agent (iteration_6.json): fragment hydration in cookie-less fresh context, auth_error toast, unauthenticated load, Bearer API regression — all PASS.
- Remaining known iOS limitation: iOS PWA (Home Screen) still relies on the Safari→PWA cookie handoff; permanent fix remains "Sign in with Apple" (P1 backlog).

## 2026-06 — Referral "joined" counter + share attribution
- `GET /api/feed` now returns `referral_count` (viewer's attributed sign-ups).
- BottomNav share pill shows a "· N joined" chip (`bottom-nav-referral-count`) on Feed/Matches/Profile when N > 0; hidden at 0.
- Share button now shares/copies `${origin}/?ref=<handle>` so invites actually attribute (previously the link had no ref param); toast updated.
- Verified by testing agent (iteration_7.json): all 6 checkpoints pass, no regressions. Deployment health check: PASS.

## 2026-06 — iPhone intro-video recorder fix
- Production bug (user's screen recording): sign-in via the fragment-token fix WORKED on his iPhone, but the intro-video recorder was dead — record button silently no-op'd.
- Root cause: `new MediaRecorder(stream, {mimeType:'video/webm'})` throws NotSupportedError on iOS Safari (mp4-only), uncaught.
- Fix: `pickRecorderMime()` probes `isTypeSupported` (webm → mp4 → browser default), try/catch + error toasts, blob type strips codec suffix, `streamReady` state guarantees preview attach ("Waiting for camera…" until live). Backend upload now normalizes codec-suffixed Content-Types (`video/mp4;codecs=avc1` previously 415) and stores normalized type to GCS.
- Verified by testing agent (iteration_8.json): backend 6/6, frontend e2e record→stop→playback pass, no console errors. Regression suites added: /app/backend/tests/test_video_upload_codec.py, /app/tests/test_videopick_ui.py.

## 2026-06 — Interactive map on Change Location
- User report: map couldn't be dragged/pinch-zoomed and every touch instantly switched the city (old implementation = static OSM iframe + invisible tap-catcher).
- Fix (user chose "keep instant tap-to-pick, add real pan/zoom"): replaced with Leaflet 1.9.4 + OSM tiles — drag to pan, pinch/buttons to zoom; deliberate tap still instantly picks (Leaflet suppresses click after drag/pinch). Red circleMarker, "Drag to move · tap to pick" badge, z-0 stacking wrapper keeps search dropdown above map panes.
- Verified by testing agent (iteration_9.json, 9/9 pass): drag/zoom fire zero location POSTs; tap/search/popular flows all persist correctly; demo-00 restored to Tokyo.

## 2026-06 — Heat-dots on the map (discovery)
- Every city with intro'd people renders a glowing cyan dot (halo + core, radius scaled by headcount) on the Change Location Leaflet map, with tooltip "<City> · N people". Tapping a dot instantly switches to that city (exact popular-list coords + label).
- Fix during rollout (testing agent RCA iteration_10): the red selected-location pin covered the current city's dot and swallowed its hover/click — pin is now interactive:false, plus a defensive guard in the map click handler for `heat-dot-core` targets.
- Verified by testing agent (iteration_11): dot click POSTs exact city payload, tooltip works, empty-map tap & drag regressions pass, demo-00 restored to Tokyo.

## 2026-06 — New app icon (heart-handshake logo)
- User supplied a heart-handshake logo; recolored to the app palette (red #FF4D4D + cyan #00E5FF on black) via image generation — site colors unchanged per user request.
- Replaced: /icon-512.png, /icon-maskable-512.png (PWA + apple-touch + favicon), added /n2m-mark.png (transparent mark for future use).
- Rebuilt the signed Android TWA: versionCode 2, same keystore (fingerprint matches assetlinks.json), new icon baked in. New APK 2.4MB at /nice2meechu.apk (+ .aab). Install-pill copy updated to 2.4 MB. Toolchain reinstalled in this pod (openjdk-17, Android SDK at /opt/android-sdk, qemu wrappers for x86_64 aapt2 — including the Gradle-cache maven aapt2).
- Verified: apksigner cert fingerprint matches, new icon PNGs inside APK, all assets serve 200 in preview.
- NOTE for iOS: users who already added the PWA to their Home Screen keep the old icon until they re-add it (Apple caches apple-touch-icon at install time). Android: installing the new APK over the old one updates the icon.

## 2026-06 — New social share card
- og-default.png regenerated (1200×630): heart-handshake mark + "Nice2Meechu." wordmark + tagline on black. OG/Twitter image URLs versioned to ?v=2 to bust scraper caches.

## 2026-06 — Undo Like (unlike)
- POST /api/swipe now accepts action "unlike" → deletes the swipe row (already-created matches are intentionally kept, consistent with existing rewatch policy).
- FeedCard: while liked, the Like button goes gray + disabled for that video only; the "Liked ✕" pill is now a button — tapping it undoes the like ("Like removed" toast, red button restored, no auto-advance).
- Verified by testing agent: backend 3/3 (iteration_12, test_unlike_swipe.py) + frontend e2e 100% (iteration_13). Note: iteration_12 caught a corrupted FeedCard.js edit (orphaned JSX) — repaired before retest.
- Testing note: preview session token expiry extended +7 days by tester; minor backlog item — audit ~24 asset 404s seen in browser console (non-blocking).

## 2026-06 — "Likes you" hint
- GET /api/feed items include `likes_you` (person has an active like on the viewer AND pair not already matched).
- FeedCard: cyan "Likes you" pill (top-left) + pulsing cyan glow on the red Like button; liking back matches instantly.
- Contract fix: `_check_mutual_match` now honors a real reverse-like FIRST (demo random 70% only when no real reverse-like) — "like back" always matches.
- Bonus critical fix (found by testing agent): FeedCard action stack got z-50 — the bottom-nav's padding box (z-40) was swallowing like/pass/report taps on shorter screens. Real un-forced clicks verified.
- Verified: iteration_14 (found issues) + iteration_15 (100% backend + frontend, deterministic match 3/3, hitbox proof, nav regression clean). Preview seed: demo-01 likes demo-00.

## 2026-06 — Home city vs. Browsing city split (John/Erial bug)
- Bug report: John lives in Erial but his video appeared in Marlton. Root cause: single `city` field doubled as "where my video shows" and "what I'm browsing" — exploring another city silently relocated your video.
- Fix (user-approved): `home_city/home_lat/home_lng` added. Feed matches TARGETS on home_city; browsing city only selects what you watch. Onboarding sets both. `POST /users/location` gained `set_home` (default false). `cities/popular` + heat dots + city_stats now count residents (home_city). Startup migration backfills home_city=city (ran: 91 users; idempotent, will run on production deploy too). Demo seeds include home_city.
- UI: Change Location screen has a "Set as my home city — where your video appears" checkbox + "🏠 Current home: X" label; dual toasts (explore vs home).
- Verified: iteration_16 — backend 9/9 pytest (incl. the exact John scenario), frontend 100%. Test suite: /app/backend/tests/test_home_city.py.
- John's one-time fix after deploy: feed → tap city pill → search "Erial" → tick "Set as my home city" → pick it.

## 2026-06 — "Nearby towns" feed expansion
- Feed now also shows people whose HOME is within 25 km (`NEARBY_RADIUS_KM`, server.py) of the browsing city's center. Locals first (chronological), nearby appended by distance. Feed items carry `home_city` + `near_km`; FeedCard shows a "from <Town> · N km" chip (feed-nearby-badge) when home differs from the browsing city. city_stats.total includes nearby.
- Verified: iteration_17 — 100% backend (ordering, 25 km boundary, Tokyo regression) + frontend chips ("FROM ERIAL · 15 KM" etc.). Test suite: /app/backend/tests/test_nearby_feed.py. Preview fixture user kept: test-john-erial (home Erial, NJ).

## 2026-06 — Adjustable nearby radius (10/25/50 km)
- `POST /api/users/nearby-radius` (400 unless 10/25/50) → `users.nearby_radius_km`; feed nearby block uses it (default 25).
- Change Location screen: "Nearby radius" row with 10/25/50 pill toggles (cyan active), instant persist + toast; closing after a radius-only change reloads the feed (handleClose → onChanged with radiusDirty).
- Verified: iteration_18 (backend 8/8; caught the X-button wiring bug) + iteration_19 (fix confirmed, 100%: 10 km → 1 Marlton card, 50 km → 3 incl. Erial, no-change close = no reload). Suite: /app/backend/tests/test_nearby_radius.py.

## Next Tasks
- User to **Deploy** — radius pills live on the location screen.
- Verified: GIS button renders on /signin, `/api/auth/google` rejects bogus JWTs (401), seeded session bears authenticated `/api/auth/me`.

## Prioritized backlog
- **P1** Real recorded-video upload to object storage (currently `URL.createObjectURL(blob)` — not persistent across sessions).
- **P1** GDPR Art. 20 data-export endpoint ("Download my data").
- **P1** Set up `safety@` / `privacy@` mailboxes via Cloudflare Email Routing.
- **P2** Mark `onboarding_completed`, `community_rules_accepted`, `match_made`, `share_started` as Key Events in GA4 Admin.
- **P2** Push/online presence — show which matches are live now.
- **P2** Decommission old Netlify `nice2meechu` site once Emergent SSL stable ≥7 days.
- **P3** Voice-note replies; audio translation (TTS over translated text).
- **P3** Invite-only friends-of-friends discovery.
- **P3** Split `App.js` into per-screen files once it stops being a single-file brief.

## 2026-06 — Sign in with Apple (SIWA) — code complete, awaiting Apple credentials
- Why: App Store requires SIWA for any app offering Google login. User is an Apple Developer with only an iPad + Windows 11 PC (no Mac).
- Backend: `POST /api/auth/apple` in `auth.py` — verifies Apple identity token via PyJWT `PyJWKClient` against `https://appleid.apple.com/auth/keys` (RS256, aud=`APPLE_SERVICE_ID`, iss=appleid.apple.com). `_upsert_apple_user`: lookup apple_sub → link by email → create new (codename/referral parity with Google path). Mints the same session_token + httpOnly cookie.
- Frontend: `components/AppleSignInButton.js` — lazily loads Apple JS SDK, popup mode (`usePopup:true`, redirectURI=origin), posts id_token+first-signin-name+ref to backend, stores token, reloads. Renders NOTHING until `REACT_APP_APPLE_SERVICE_ID` is set. Wired into `SignInScreen.js` under the Google button. testid: `signin-apple-button`.
- Env placeholders added (empty): backend `APPLE_SERVICE_ID`, frontend `REACT_APP_APPLE_SERVICE_ID`. Fill with the Services ID (e.g. `com.nice2meechu.app.web`) once user creates it, then restart both services.
- Apple portal setup user must do (guided): App ID `com.nice2meechu.app` (explicit, SIWA capability) → Services ID with domain `nice2meechu.com` + preview domain, Return URLs `https://nice2meechu.com/` and preview URL → (optional for future) SIWA .p8 key.
- Tested: endpoint returns 500 pre-config, JWKS fetch + bad-token rejection verified in python, sign-in screen renders unchanged. FULL E2E BLOCKED until real Apple Services ID exists.
- Bundle ID = Apple's equivalent of Android package name → `com.nice2meechu.app` (matches Play Store).
- iOS build path chosen for Mac-less user: PWABuilder (generate Xcode project) → GitHub → Codemagic (cloud Mac build/sign/upload to App Store Connect).

## 2026-06 — SIWA live in preview + account fixes
- User created App ID `com.nice2meechu.app` + Services ID `nice2meechu.app.web` (domains/return URLs cover prod + preview; verified against Apple's authorize endpoint). Env vars filled; "Continue with Apple" button live and user signed in successfully on iPhone.
- Fixed VideoPick camera box crushed to a sliver on small iPhones (flex column shrink) — added `shrink-0` + minHeight 360; Continue button now toasts "Record your intro first" instead of being dead-disabled.
- Apple "Hide My Email" created a duplicate account (private relay email ≠ Gmail). Cleanup (user-approved): linked apple_sub to Steavin (steavinrice@gmail.com), deleted Aurora Lynx duplicate + old Loretta test account from preview. Added hint under Apple button: "Used Google before? Choose 'Share My Email' so we recognize you." (testid signin-apple-email-hint).

## 2026-06 — Production deploy fix + iOS App Store package
- Prod deploy failed: k8s probes hit GET /health (no /api prefix) → 404. Added root-level `/health` in server.py (returns {"status":"ok"}, curl-verified). Deployment agent re-check: PASS. demo_XX.webm 404s in logs are harmless (video source fallback probing).
- Built complete iOS Xcode project at `/app/ios-build/ios-app/` from khmyznikov/ios-pwa-wrap template (same as PWABuilder): bundle `com.nice2meechu.app`, Team `J99N4XLB3D`, v1.0.0, rootUrl nice2meechu.com, authOrigins appleid.apple.com+accounts.google.com, WKAppBoundDomains set, all AppIcon/Launch icons regenerated from icon-512 (alpha flattened), HealthKit fully removed (pbxproj+Swift), Firebase push stubbed via placeholder GoogleService-Info.plist. Entitlements slimmed to empty (App ID only has SIWA capability). NOT COMPILE-TESTED (no Xcode on Linux) — first Codemagic build is the real test.
- `/app/codemagic.yaml` (repo root): ios-appstore workflow — pod install, auto signing (App Store Connect integration named `nice2meechu-asc`), build-ipa, auto-publish to TestFlight.
- `/app/ios-build/README.md`: full browser-only user checklist (ASC app record, ASC API key, Save to GitHub, Codemagic setup, review notes).
- Play Store AAB ready: `/app/frontend/public/store-assets/nice2meechu-play.aab` (downloadable from prod at /store-assets/nice2meechu-play.aab after redeploy).

## 2026-06 — Security audit + fixes (all verified in preview)
- Audit verdict was FAIL (1 HIGH, 2 MEDIUM). All fixed same-day:
- SEC-001 HIGH CORS: `CORS_ORIGINS` env changed from `*` to explicit allowlist (nice2meechu.com, www, preview); server.py strips/filters entries. Verified: evil Origin gets no ACAO header; allowed origin reflected. (Preview ingress still injects ACAO:* but browsers reject wildcard+credentials per spec, so credentialed attack fails regardless.)
- SEC-002 MED: `/api/translate` now requires auth (401 verified) + TranslateReq.text max_length 2000. Frontend translate() helper fails gracefully (returns original text) and is only used signed-in.
- SEC-003 MED: OG card cache — bogus handles no longer cached; real-handle cache bounded at 500 (FIFO evict).
- Hardening: MessageReq.text + VideoUploadReq.transcript capped at 2000 chars; Google/Apple auth errors now generic (details still logged server-side).
- Remaining backlog (P3): per-user rate limiting on swipes/messages/reports; CSRF tokens (mitigated by CORS fix + JSON-only bodies).
- PRODUCTION NOTE: fixes require redeploy to take effect on nice2meechu.com.

## 2026-06 — Production demo-location corruption fix (Tokyo-in-Marlton, round 3)
- After user's successful prod deploy, Marlton still showed Tokyo AI demos (Sota/Yui/Aoi). Screen-recording analysis + code trace found root cause: PROD DB demo docs were seeded by an OLD build that homed demos in the viewer's browsing city; the new alignment pass in `seed_demo_users()` only $set name/handle/transcript — never location. Preview was re-seeded fresh so it never reproduced.
- Fix: alignment pass now heals location (city/home_city/home+city lat/lng, jittered lat/lng) whenever stored home_city != persona's canonical metro (demo_meta.json). Runs on every feed request → prod self-heals on first feed load after redeploy. Tested in preview by poisoning demo-00 to Marlton → healed to Tokyo.
- Demo metro distribution (78 personas): Tokyo 12, São Paulo 11, Mumbai 10, NY 9, Lagos 8, LA 7, Paris 6, London 5, Toronto 4, Madrid 3, Sydney 2, Berlin 1. Marlton gets ZERO demos after healing — feeds outside metros show only real people (honest hyperlocal by design).
- Also this session: applied code-review triage — moved hardcoded test session token to TEST_SESSION_TOKEN env in 6 test files (value in memory/test_credentials.md), removed unused import; verified .env/gcs-credentials NOT git-tracked (safe for GitHub push); declined localStorage migration (intentional iOS Safari fallback), hook-dep & complexity refactors (false positives / pre-launch risk).

## Next Tasks
- User: REDEPLOY to ship the demo-location healing (+ verify Marlton on iPhone: Tokyo demos gone).
- Then: Play Console AAB upload; Save to GitHub → App Store Connect → Codemagic build.
