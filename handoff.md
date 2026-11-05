# Nice2Meechu — Engineering & Operations Handoff

_Last updated: November 2026 · Live build stamp: **v1.6.8-town-label-match** (check anytime at `GET https://nice2meechu.com/api/`)_
_Source of truth: GitHub **`localfiveguy/Nice2Meechu`**, branch **`netlify-migration`** — this branch is what is live. Admins can download this file from `https://nice2meechu.com/api/handoff.md` while signed in._

This document is written so that a new engineer, or a new AI assistant, can pick up the project cold: what the product is, where every piece runs, how changes go live, how the code is organized, which rules are deliberate, and how to fix things when they break. It contains **no passwords or keys** — only where they are kept.

---

## Table of contents
1. Quick facts
2. The product
3. The owner and how to work with him
4. Hosting map — every service and account
5. How a change goes live
6. Repository layout
7. Backend architecture
8. Startup tasks and one-shot migrations
9. Frontend architecture and routing
10. Authentication and sessions
11. Data model (MongoDB)
12. API reference
13. Feed and location rules (the hardest-won logic)
14. Demo persona system
15. Video pipeline and AI safety checks
16. Messaging and translation
17. Push notifications
18. Admin tools
19. Configuration and secrets inventory
20. Security posture
21. Testing
22. Runbooks
23. Costs, renewals, and things that break if they lapse
24. Hard rules and gotchas
25. App store distribution (parked)
26. Backlog

---

## 1. Quick facts

| | |
|---|---|
| Live site | https://nice2meechu.com (and `www.nice2meechu.com`, which redirects to it) |
| Same site, Netlify address | https://nice2meechu.netlify.app |
| API (direct) | https://nice2meechu-api.onrender.com (browsers never call this directly; see §5) |
| Stack | React 19 (Create React App + craco) · FastAPI (Python 3.11) · Motor (async MongoDB) · Google Cloud Storage · OpenAI |
| Accounts | 31 real people plus 78 demo personas |
| Repository | github.com/localfiveguy/Nice2Meechu (public) |
| Live branch | `netlify-migration` |
| Tests | 15 files, 120 backend tests (`backend/tests/`) |

---

## 2. The product

**Nice2Meechu** is a hyperlocal, video-first social app. People meet through a short spoken video introduction instead of photos.
Tagline: **"Meet the world. Video-first. Anonymous until the spark."**

### Core product rules (deliberate — do not change without the owner's explicit request)
1. **Anonymous until a match.** Everyone appears under a codename (for example "Cosmic Phoenix") until two people both like each other. Then a match is created and they can chat.
2. **Home-town-only feed.** A person's video appears **only in their own home town.** There is no "nearby" radius. An 8 km tolerance exists purely so that two names for the same physical town (Marlton and Evesham Township, NJ) count as one place. See §13.
3. **Video-first.** One short intro video (target 7 seconds, with an on-screen script such as "Hello, my name is Steve, and I live in Voorhees, NJ, USA. Nice to meet you!") is the whole profile. All stored intros are H.264/AAC mp4 so iPhones can play them.
4. **Honest AI.** Demo profiles exist only in 12 big world cities to make the app feel alive. They are always badged "✨ AI DEMO", never appear in small towns, and can never become real matches.
5. **Safety first.** Every intro passes an AI check for exactly one real human face, no prohibited content, and an age gate before it is posted. Users can report and block. Users can delete their account and export their data from inside the app.

### Main screens
Splash → Sign in (Google, Apple) → Onboarding (first name, age, home town, vibes, language, avatar emoji) → Community Rules (with signature) → Intro video (record, review, AI check, upload) → Feed (swipe like or pass) → Matches → Chat (with live translation) → Profile (home town, change intro, notifications toggle, download my data, delete account).

---

## 3. The owner and how to work with him

- **Steven ("Steve") Rice**, independent developer and owner of the app. Email: localfiveguy@gmail.com (also signs in as steavinrice@gmail.com).
- **Non-technical by preference.** He relies on the engineer or assistant for all code changes and avoids command-line tools. Give **click-by-click, browser-only** instructions, one step at a time, and confirm before moving on.
- He uses text-to-speech to listen to answers: **never read code aloud.** Put code or exact values in separate copy-paste blocks and describe them in plain words.
- He prefers **complete file replacements** over "edit line 42" instructions.
- Devices: iPhone, iPad, Google Pixel, Windows 11 desktop. **No Mac** — all Apple work must be browser-based (App Store Connect on the web plus Codemagic cloud builds).
- He values **honest hyperlocal behavior over engagement tricks.** When in doubt, show only what is real and local, and confirm scope with him first.
- **Do not bring up app-store publishing** unless he raises it (§25).
- Changes to DNS, certificates, billing, deleting data, and anything involving passwords or payment are **his clicks** — guide him to the exact button and let him press it.

---

## 4. Hosting map — every service and account

| Piece | Service and name | Plan / cost | Where to manage it |
|---|---|---|---|
| Website (the built React app) | **Netlify**, project `nice2meechu` (team "Steven Rice") | Free tier | app.netlify.com → Projects → nice2meechu |
| API server (FastAPI) | **Render**, web service `nice2meechu-api` (region Virginia), managed by a Blueprint named `nice2meechu` | **Starter, about $7/month**, always on | dashboard.render.com → nice2meechu-api |
| Database | **MongoDB Atlas**, cluster `Cluster0` (AWS N. Virginia, us-east-1), project "Project 0", database **`nice2meechu`** | Free tier (512 MB) | cloud.mongodb.com |
| Intro video storage | **Google Cloud Storage**, bucket **`nicemeechu`**, Google Cloud project **`gen-lang-client-0271718241`** (display name "Nice2Meechu") | Pennies per month; billed to billing account **"B of A"** | console.cloud.google.com |
| AI face/age check and chat translation | **OpenAI API**, model `gpt-4o-mini` | Prepaid credit (started with $5) | platform.openai.com → Billing / API keys |
| Google sign-in | Google OAuth client `780373908792-5paopj52a9u3pf1dh47778d22kvvajfm.apps.googleusercontent.com` (same Google Cloud project as above) | Free | console.cloud.google.com → Google Auth Platform → Clients |
| Apple sign-in | Apple Developer, Services ID `nice2meechu.app.web`, Team `J99N4XLB3D` | Apple Developer membership | developer.apple.com |
| Domain and DNS | **Network Solutions**, domain `nice2meechu.com` | Auto-renews **2027-04-26** | networksolutions.com → My Account → Domains → nice2meechu.com → DNS |
| HTTPS certificate | Let's Encrypt, issued and renewed automatically by Netlify | Free | Netlify → Domain management → HTTPS |
| Source code | GitHub `localfiveguy/Nice2Meechu` | Free | github.com |

### DNS records at Network Solutions (current, correct)
| Type | Name | Points to | TTL |
|---|---|---|---|
| A | `@` | `75.2.60.5` (Netlify's load balancer) | 15 minutes |
| CNAME | `www` | `nice2meechu.netlify.app` | 15 minutes |

Nameservers stay at Network Solutions (`ns43.worldnic.com`, `ns44.worldnic.com`). Domain Lock is on.

### GitHub app permissions
- **Netlify** and **Render** GitHub apps can read the repository so they can build on every push.
- The **Claude** GitHub app has access to this one repository so an assistant can read and push code.

---

## 5. How a change goes live

1. A change is committed and pushed to the **`netlify-migration`** branch on GitHub.
2. **Netlify** sees the push, runs `yarn install && yarn build` inside `frontend/`, and publishes the `build/` folder. Configuration lives in **`netlify.toml`** at the repo root. Typical build: 3–5 minutes.
3. **Render** sees the same push and rebuilds the API from `backend/` (`pip install -r requirements.txt`, then `uvicorn server:app`). Configuration lives in **`render.yaml`** (a Render Blueprint). Typical build: 2–3 minutes. Render health-checks `GET /health` before switching traffic, so a broken build never replaces a working one.
4. Nobody presses "Deploy". If a build fails, the previous version keeps running and Render/Netlify email localfiveguy@gmail.com.

### One origin, by design
- The browser only ever talks to **`nice2meechu.com`**. Netlify forwards every `/api/*` request to `https://nice2meechu-api.onrender.com/api/*` with a status-200 rewrite (`netlify.toml`).
- That keeps the httpOnly `session_token` cookie first-party and keeps Google's redirect sign-in working (its return address is `window.location.origin + /api/auth/google-redirect`).
- `REACT_APP_BACKEND_URL` is intentionally set to an **empty string**, so the frontend calls the relative path `/api`. That works on both nice2meechu.com and nice2meechu.netlify.app.
- If the Render address ever changes, update the `[[redirects]]` block in `netlify.toml`.

### Other `netlify.toml` rules
- Every other path falls back to `/index.html` (single-page app), so deep links like `/privacy` work.
- `/sw.js` is served `no-cache` so service-worker updates reach phones immediately.
- `/static/*` is cached for a year (file names are content-hashed).

### Branches
- **`netlify-migration`** — live. Always work here.
- `main` — an older snapshot of the code. Not deployed. Everything in it is already contained in `netlify-migration`. It can be retired or reset to match `netlify-migration` later.

### Build stamp
`GET /api/` returns `{"app": "Nice2Meechu", "build": "...", "auth": "google-direct"}`. The value is defined in `backend/auth.py`, and `backend/admin.py` carries its own copy for the feed diagnostic. **Bump both** on every meaningful change — it is the fastest way to answer "is my fix actually live?".

---

## 6. Repository layout

```
/                       repo root
├── backend/            FastAPI app (Render builds from here)
│   ├── server.py       entry point, CORS, router mounting, startup tasks
│   ├── core.py         database client, constants, helpers, geocoder, storage
│   ├── llm.py          OpenAI wrapper (text + vision)
│   ├── auth.py  users.py  feed.py  messaging.py  media.py
│   ├── demos.py  admin.py  push.py  transcode.py  models.py
│   ├── videos/         79 demo mp4 files + demo_meta.json
│   ├── tests/          pytest suite (120 tests)
│   └── requirements.txt
├── frontend/           React app (Netlify builds from here)
│   ├── src/            App.js, screens/, components/, lib/, legal/, constants/
│   ├── public/         index.html, manifest.json, sw.js, icons, store-assets/, .well-known/
│   ├── craco.config.js
│   └── package.json    (no lockfile — dependencies resolve fresh on each build)
├── android-build/      Android TWA project (Google Play)
├── ios-build/          iOS wrapper project (App Store)
├── codemagic.yaml      iOS cloud build pipeline
├── tests/              Playwright UI test for the intro recorder
├── scripts/            make_share_cards.py (renders the share-card PNGs)
├── share_cards/        generated share-card images
├── netlify.toml        website build + /api proxy
├── render.yaml         API service definition
└── handoff.md          this document
```

`README.md` at the root is a short pointer to this document. `tests/` at the root holds one Playwright UI test for the intro recorder (set `APP_URL` and `TEST_SESSION_TOKEN` to run it).

---

## 7. Backend architecture

All routes live under `/api` except the root-level `GET /health`.

| File | Responsibility |
|---|---|
| `server.py` | Entry point. Loads `.env` if present (local development only), sets up CORS with an explicit allowlist (`CORS_ORIGINS`), mounts every router under `/api`, mounts static folders (`/api/videos`, `/api/user-videos`, `/api/share-cards`), defines `GET /health`, and runs the startup tasks in §8. |
| `core.py` | Database client (`MONGO_URL`, `DB_NAME`, optional `MONGO_USERNAME` + `MONGO_PASSWORD`), constants (`SESSION_TTL` = **30 days**, **`SAME_TOWN_KM = 8`**, language names), `generate_unique_codename()` (1,600 combinations, uniqueness enforced at signup), `haversine_km()`, `_geocode_city(label, use_cache=True)` (Photon geocoder plus `db.city_geo` cache — **always pass `use_cache=False` for anything written onto a user record**), lazy Google Cloud Storage client, logger. |
| `llm.py` | Thin wrapper over the official OpenAI SDK: `llm_enabled()`, `chat_text()`, `chat_vision()`. Reads `OPENAI_API_KEY` and `LLM_MODEL` (default `gpt-4o-mini`). Callers fail open when the key is missing. |
| `models.py` | Pydantic request models; free-text fields are capped at 2,000 characters. `NearbyRadiusReq` is a leftover and unused. |
| `auth.py` | Google sign-in (popup and redirect), Sign in with Apple (JWKS verification), Apple-to-Google account linking, session minting, `current_user` dependency, duplicate-account race guard (`_insert_user_or_get_existing`), **build stamp**. |
| `users.py` | Onboarding, community-rules signature, location change (geocoder-validated), city position memory, welcome-tour flag, account deletion and data export, report and block, intro upload (with webm→mp4 transcode) to Google Cloud Storage, video URL validation. |
| `feed.py` | `/cities/popular`, `/feed` (home-town locals plus same-town candidates, browse-center healing, "likes you" flag), `/swipe` (like, pass, unlike, block; match creation), `/matches`, `/matches/unread`. |
| `messaging.py` | Chat messages (with push to the recipient) and `/translate`. |
| `media.py` | `/video/face-check` (AI vision safety and age gate), `/og/{handle}` share-card PNGs (Pillow, bounded cache of 500), admin-only `/handoff.md`. |
| `demos.py` | 78 demo personas: seeding, alignment, location healing, ghost purge; `/demos/sample`, `/samples`. |
| `admin.py` | Admin-only tools (§18), plus the daily inactive-video cleanup loop. |
| `push.py` | Web push (VAPID): subscribe, unsubscribe, status, public key, and `notify_user()` used by matches and messages. |
| `transcode.py` | `transcode_to_mp4(src, dst)` — H.264/AAC mp4 (faststart, CRF 26) using the static ffmpeg binary bundled in the `imageio-ffmpeg` pip package, so no system ffmpeg is needed on Render. |

### Key backend dependencies
fastapi, uvicorn, motor/pymongo, pydantic, google-auth (Google token verification), PyJWT with `PyJWKClient` (Apple), httpx (Photon geocoder), google-cloud-storage, imageio-ffmpeg, pywebpush/py-vapid, openai, Pillow, python-multipart.

### Render service settings (from `render.yaml`)
- Runtime Python, `rootDir: backend`, Python 3.11.9.
- Build: `pip install --upgrade pip && pip install -r requirements.txt`.
- Start: `uvicorn server:app --host 0.0.0.0 --port $PORT --proxy-headers --forwarded-allow-ips="*"`.
- Health check path: `/health`.
- Plan: `starter` (always on — the free plan would sleep after 15 idle minutes and make the first visitor wait up to a minute).

---

## 8. Startup tasks and one-shot migrations

Run by `server.py` every time the API boots:
- Create unique partial indexes on `users.email`, `users.google_sub`, `users.apple_sub`, and other collection indexes. (Each index is created idempotently, so boots are safe.)
- **Flush the geocode cache** (`db.city_geo`) — deliberately, on every boot (§24, rule 1).
- Retire legacy demo records.
- Start the **inactive-video cleanup loop** (§18): once a day, users who have not been active for 90 days have their intro video deleted from storage and must re-record when they return. Their account is kept. Controlled by `INACTIVE_CLEANUP_ENABLED` (default true), `INACTIVE_CLEANUP_DAYS` (default 90), `INACTIVE_CLEANUP_INTERVAL_SECONDS` (default one day).

One-shot migrations, each recorded in `db.migrations` so they run only once:
| Marker id | What it did |
|---|---|
| `repair_user_coords_v1` | Repaired user coordinates poisoned by a bad geocode cache. |
| `transcode_webm_videos_v1` | Pointed every real `.webm` intro at an mp4 copy in storage (transcoding if needed). Runs as a background task. |
| `move_signatures_v1` | Moved community-rules signature images off user records into `db.signatures` (user records shrank from megabytes to under 1 KB). |
| `unique_codenames_v1` | Renamed duplicate codenames; demos keep canonical names and the oldest real account keeps a contested name. |
| `welcome_tour_backfill_v1` | Marked existing users as having seen the welcome tour. |

To re-run one: delete its marker document from `db.migrations` and restart the API (§22). All are idempotent.

---

## 9. Frontend architecture and routing

- **`App.js`** — session bootstrap, routing, and push deep links (`/?chat=<match_id>`). Routing gate `routeToNext()`:
  1. Missing `handle`, `first_name`, `city`, or `age` → **Onboarding**.
  2. Missing `agreed_to_rules_at` → **Community Rules**.
  3. Missing `video_url` → **VideoPick** (record intro).
  4. Otherwise → **Feed**.
- **`lib/`** — `api.js` (axios; base URL `${REACT_APP_BACKEND_URL}/api`; sends `Authorization: Bearer <n2m_token>` from localStorage), `push.js`, `constants.js`, `cityFormat.js`, `ua.js` (device detection).
- **`screens/`** — `Splash`, `SignInScreen` (Apple first on iPhone/iPad), `AuthCallback`, `LinkGoogleScreen`, `Onboarding`, `CommunityRulesScreen`, `VideoPick`, `FeedScreen`, `ChangeLocationScreen` (Leaflet map), `MatchesScreen`, `ChatScreen`, `ProfileScreen`.
- **`components/`** — `FeedCard` (one mp4 `<source>`, query-string-safe type check), `AppleSignInButton`, `CityAutocomplete`, `BottomNav`, `MatchCelebration`, `ShareCard`, `AvatarThumb`, `VideoEl`, `EmptyFeedState`, `NotifyMeButton`, `IOSInstallSheet`, `SignaturePad`, `WelcomeTour`, `DemoPeekWidget`, and `ui/` (shadcn components).
- **`legal/LegalPages.jsx`** — Privacy Policy, Terms, and the safety contact link (`SAFETY_CONTACT_URL`, a Google Form that emails the owner).
- **`public/sw.js`** — push-only service worker: handles push, notification clicks, and resubscribe. **It does no caching on purpose.**
- **`public/index.html`** — contains only first-party code. Google Analytics 4 loads only after the visitor accepts the cookie banner.

### Build-time values (all public, set in `netlify.toml`)
`REACT_APP_BACKEND_URL` (empty), `REACT_APP_GOOGLE_CLIENT_ID`, `REACT_APP_APPLE_SERVICE_ID`. An optional `REACT_APP_GA4_MEASUREMENT_ID` enables analytics.

### Frontend dependencies
react-router-dom, framer-motion, leaflet, axios, sonner (toasts), lucide-react (icons), Radix/shadcn UI, Tailwind CSS.

---

## 10. Authentication and sessions

### Ways to sign in
1. **Google (primary)** — Google Identity Services.
   - Desktop and Android: popup → `POST /api/auth/google` with `{credential}`.
   - iPhone Safari: full redirect → `POST /api/auth/google-redirect` (form post) → `GET /auth-callback#token=…` (the token rides in the URL fragment because Safari's tracking prevention drops cookies during redirects).
   - **iPhone UX rule:** the sign-in screen shows "Continue with Apple" first, with a hint, and Google below with a Safari hint. A website can only see Google accounts that are signed in **inside Safari**; it can never read accounts from the native Gmail/Google apps.
   - Allowed origins on the Google OAuth client: `https://nice2meechu.com`, `https://www.nice2meechu.com`, `https://nice2meechu.netlify.app`. Allowed redirect URIs: each of those plus `/api/auth/google-redirect`. Any new domain must be added there, or sign-in shows "Error 400: origin_mismatch".
2. **Apple** (required for the App Store) — `AppleSignInButton.js` lazy-loads Apple's JS SDK in popup mode with `redirectURI = origin + "/"` → `POST /api/auth/apple` with `{id_token, name?, ref?}`. The server verifies with `PyJWKClient` against `https://appleid.apple.com/auth/keys`, audience `APPLE_SERVICE_ID` (`nice2meechu.app.web`), issuer appleid.apple.com.
   - Account lookup order: `apple_sub` → verified email → create new.
   - Email linking requires the `email_verified` claim.
   - **"Hide My Email" linking:** a brand-new Apple account with a private-relay email gets a 30-minute one-time `link_token` and is sent to `LinkGoogleScreen` (`/?link_google=1`) to merge into an existing Google account. Popup: `POST /api/auth/link-google`. iPhone redirect: `/api/auth/google-redirect?link=<token>`. The guard `_relay_mergeable` allows a merge only for an account with `apple_sub`, **no** `google_sub`, **no** video, and a `@privaterelay.appleid.com` email, so no data can be lost.
   - The Apple button renders only when `REACT_APP_APPLE_SERVICE_ID` is set.

### Sessions
- Tokens are `secrets.token_urlsafe` values stored in `user_sessions` with `expires_at` = now + **30 days**. Each device gets its own token; logout removes only that device's token.
- The token is sent **both** as an httpOnly cookie (`session_token`, SameSite=None, Secure) **and** in the JSON response. The frontend stores it as `n2m_token` in localStorage and sends `Authorization: Bearer`.
- **The localStorage fallback is a deliberate iPhone Safari workaround — do not remove it.** iPhone sign-in breaks without it. The risk was reviewed and accepted.

### Duplicate-account protection
Unique partial indexes on `email`, `google_sub`, and `apple_sub` (filtered to string values) plus `_insert_user_or_get_existing`, which catches `DuplicateKeyError` from two simultaneous sign-ins.

---

## 11. Data model (MongoDB, database `nice2meechu`)

MongoDB `_id` values never leave the API: every query projects `{"_id": 0}` and every document has a UUID `id`.

- **`users`** — `id`, `email`, `name`, `first_name`, `age`, `picture`, `google_sub?`, `apple_sub?`, `apple_relay_email?`, `codename`, `handle`, `avatar_emoji`, `vibes[]`, `language`, **`home_city`, `home_lat`, `home_lng`** (where the person lives — decides where their video appears), **`city`, `city_lat`, `city_lng`** (the city they are currently browsing), `lat`, `lng`, `city_positions{}` (remembered feed position per city), `video_url`, `transcript`, `source_lang`, `is_demo?`, `demo_age?`, `referrer_handle`, `referrer_id`, `referral_count`, `notify_new_nearby` (legacy name; now the on/off switch for match and message pushes), `nearby_radius_km` (legacy, ignored), `agreed_to_rules_at`, `welcome_tour_done`, `last_matches_viewed_at`, `inactivity_cleaned_at?`, `created_at`, `last_active_at`.
  - The Profile screen shows and edits **`home_city`** only. The browsing `city` is never displayed on a profile.
  - `video_url` is a public Google Cloud Storage URL with a `?v=` cache-buster, always an mp4 for real users.
  - `created_at` is a datetime in older documents and an ISO string in newer ones — sort with `str()`.
- **`user_sessions`** — `user_id`, `session_token`, `expires_at`.
- **`swipes`** — `id`, `user_id`, `target_user_id`, `action` (`like` | `pass` | `block`), `at`. One row per pair (upsert); "unlike" deletes the row.
- **`matches`** — `id`, `user_ids` (sorted pair), `at`.
- **`messages`** — `id`, `match_id`, `from_user_id`, `text`, `at`, plus translation metadata.
- **`reports`**, **`blocks`** — moderation records.
- **`signatures`** — community-rules signature images (moved off `users`).
- **`push_subscriptions`** — `endpoint` (unique), `keys{p256dh, auth}`, `user_id`.
- **`city_geo`** — geocode cache `{key, lat, lng}`. Flushed on every boot.
- **`age_checks`** — audit trail of every AI age-gate decision (kept for GDPR/DSA accountability).
- **`migrations`** — one-shot markers (§8).

---

## 12. API reference

Everything is under `/api` except `/health`. "Auth" means a valid session (cookie or Bearer). "Admin" means the signed-in email is listed in `ADMIN_EMAILS`.

**Meta**
- `GET /api/` — app name, build stamp, auth mode.
- `GET /health` — liveness probe used by Render. **Never remove it.**

**Auth**
- `POST /auth/google` — Google popup credential → session.
- `POST /auth/google-redirect` — Google redirect form post → `/auth-callback#token=…` (optional `?link=<token>` for Apple linking).
- `POST /auth/apple` — Apple ID token → session (may return `link_token`).
- `POST /auth/link-google` — merge a fresh Apple relay account into a Google account.
- `GET /auth/me` — current user.
- `POST /auth/logout` — ends this device's session.

**Users** (auth)
- `POST /users/onboarding` — first name, home city, age, vibes, language, avatar; sets home coordinates.
- `POST /users/community-rules` — records agreement plus signature.
- `POST /users/location` — change browsing city (geocoder-validated); optional `set_home`.
- `POST /users/me/city-position` — remember feed position for a city.
- `POST /users/welcome-tour-done`.
- `GET /users/me` — returns `{"user": …}`.
- `GET /users/me/export` — download my data (GDPR).
- `DELETE /users/me` — delete my account and all related data.
- `POST /users/report`, `POST /users/block`.
- `POST /users/video/upload` — multipart intro upload → webm transcoded to mp4 → Google Cloud Storage.
- `POST /users/video` — set video metadata; the URL must start with `https://storage.googleapis.com/` or `/api/user-videos/`.

**Feed and matching** (auth)
- `GET /cities/popular`.
- `GET /feed` → `{feed[], city_stats{total, remaining}, saved_position, referral_count}`. Items include `likes_you`. There is no radius data.
- `POST /swipe` — `like` | `pass` | `unlike` | `block`. A mutual like creates a match and sends a push.
- `GET /matches`, `GET /matches/unread`.

**Messaging** (auth)
- `GET /messages/{match_id}`, `POST /messages` (pushes to the recipient).
- `POST /translate` — up to 2,000 characters, OpenAI.

**Media**
- `POST /video/face-check` (auth) — AI face, content, and age gate.
- `GET /og/{handle}` — share-card PNG.
- `GET /handoff.md` (admin) — this document.

**Demos**
- `GET /demos/sample`, `GET /samples` (vibes and languages).

**Push**
- `GET /push/public-key`, `GET /push/status`, `POST /push/subscribe`, `POST /push/unsubscribe`.

**Admin** — see §18.

**Static**
- `/api/videos/*` — 79 demo mp4s bundled with the backend.
- `/api/user-videos/*` — legacy local uploads folder.
- `/api/share-cards/*` — generated share images.

FastAPI's automatic docs at `/docs` and `/redoc` are reachable on the Render address.

---

## 13. Feed and location rules (the hardest-won logic — read §24 first)

**Current model: HOME TOWN ONLY.**

1. The feed for a browsed city is the union of:
   - **Label locals:** users whose `home_city` matches the browsed city label (case-insensitive prefix match), and
   - **Same-town candidates** (`_same_town_candidates`): users whose **home-town label** geocodes to a center within **`SAME_TOWN_KM` = 8 km** of the browse center. It matches by the town label's center, **not** by the person's exact house location.
   Results are sorted oldest first ("the first video made here").
2. **Why 8 km:** Marlton and Evesham Township centers are 6.5 km apart — the same physical town under two names, and the map's reverse geocode returns either. The nearest genuinely different towns (Medford, Cherry Hill at 9.4–9.5 km) stay out.
3. **Removed on purpose — do not re-add without the owner's explicit request:** the 10/25/50 km "nearby" system (`_nearby_candidates`, `_radius_suggestion`, `/users/nearby-radius`, the radius picker, widen-radius prompts, and "FROM <TOWN> · N KM" chips). The owner's words: he wants a video visible **only in its own town.**
4. **Browse center** (`_browse_center`): the anchor is the median of the label locals' home coordinates, otherwise a fresh geocode of the browsed label. A stored `city_lat/lng` is trusted only if it is within 100 km of the anchor; otherwise it is healed.
5. **Healing writes never use the cache.** Healed coordinates are written only from a fresh Photon geocode (`use_cache=False`), never from `db.city_geo` (§24).
6. **Geocoder guardrail:** `POST /users/location` validates every change through Photon (`photon.komoot.io`). If supplied coordinates are more than 100 km from where the label geocodes, the label wins.
7. `city_stats.total` is the honest number of feed items. The empty state distinguishes "you're the first here" from "you've seen everyone".
8. You never see your own card. If someone says "I see my own video", they are signed into a second (duplicate) account — check `apple_sub` and emails with the admin tools.

---

## 14. Demo persona system

- 78 personas defined in `backend/videos/demo_meta.json` (name, city, lat, lng, transcript, avatar emoji, file), with mp4s in `backend/videos/`.
- Big-city-only distribution: Tokyo 12, São Paulo 11, Mumbai 10, New York 9, Lagos 8, Los Angeles 7, Paris 6, London 5, Toronto 4, Madrid 3, Sydney 2, Berlin 1. **Small towns get none.**
- `seed_demo_users()` runs on **every feed request** (cheap and idempotent):
  1. **Ghost purge** — deletes any user whose `video_url` matches `/videos/demo_NN.(mp4|webm)` but whose id is not `demo-NN`. Real uploads live in Google Cloud Storage, so this fingerprint is safe.
  2. Stale cleanup — `is_demo: true` records with unknown ids are deleted.
  3. Alignment by id — codename, handle, name, transcript, the `is_demo` flag, and home location are reset to canonical values.
- Demo cards show the "✨ AI DEMO" badge and a "HEAR ME SAY MY NAME" chip. They are never matchable; a demo auto-like is gated behind a real reverse-like check.
- **Never use `demo-NN` users as mutable subjects in tests** — healing resets them mid-test.

---

## 15. Video pipeline and AI safety checks

### Recording (`VideoPick.js`)
- `MediaRecorder` with `pickRecorderMime()`: tries webm, then mp4, then the browser default (iPhone Safari records mp4; Chrome and Android record webm).
- The camera/review box uses `shrink-0` and a minimum height of 360 px so flex layouts cannot crush it on small iPhones, and a **maximum height of 50dvh** so the red **Continue** button below it always stays on screen.
- Flow: record (with on-screen script) → review → **Continue** → "Verifying your video…" (face check) → "Saving…" (upload). "Re-record" starts over.

### AI face, content, and age gate
- `POST /video/face-check` sends one still frame to OpenAI `gpt-4o-mini` vision (through `llm.py`). It must find **exactly one real human face**, no prohibited content, and pass the age gate: hard block under 16; block 16–17 when the person claims to be an adult.
- **Fails open** if the OpenAI key is missing or OpenAI errors, so an outage never locks out sign-ups. Watch the OpenAI balance (§23).
- Every decision is written to `db.age_checks`.
- The frame is not stored after the check (as stated in the Privacy Policy).

### Upload (`POST /users/video/upload`)
1. Multipart upload, MIME allowlist (webm/mp4, codec suffixes normalized), **25 MB cap**, spooled to disk (no memory blow-up).
2. If webm: transcode to H.264/AAC mp4 with `transcode.py` (falls back to storing the webm only if encoding fails).
3. Upload to `gs://nicemeechu/user_videos/<user-id>.mp4`, public-read per object, cache-control one year.
4. Return the public URL with a `?v=` cache-buster. The other-extension sibling is deleted so a re-record never serves the old file.

### Storage access
- The server authenticates to Google Cloud Storage with service account **`nice2meechu-video-uploader@gen-lang-client-0271718241.iam.gserviceaccount.com`**, using a JSON key stored as a Render **Secret File** named `gcs-credentials.json` (mounted at `/etc/secrets/gcs-credentials.json`, pointed to by `GOOGLE_APPLICATION_CREDENTIALS`). Exactly **one** key should exist at a time.
- Videos are read directly from `storage.googleapis.com` by browsers.

### Share cards
`GET /og/{handle}` renders a branded PNG with Pillow (LiberationSans font). Results are cached in memory (bounded at 500 entries, oldest evicted first). Unknown handles are not cached.

### Playback
`FeedCard.js` renders one `<video><source>` with a query-string-safe type check.

---

## 16. Messaging and translation

- `GET /messages/{match_id}` and `POST /messages` — only members of the match can read or write. A new message sends a push to the recipient (§17).
- `POST /translate` — auth required, maximum 2,000 characters, translates via OpenAI using the reader's language. If OpenAI is unavailable, the original text is returned unchanged.

---

## 17. Push notifications (VAPID Web Push)

- Keys: `VAPID_PUBLIC_KEY` and `VAPID_SUBJECT` (`mailto:localfiveguy@gmail.com`) are plain values in `render.yaml`; `VAPID_PRIVATE_KEY` is a Render secret. If the key pair is ever replaced, existing subscriptions stop working and users must re-enable notifications.
- `push.py` uses pywebpush. Subscriptions are stored in `db.push_subscriptions` (unique endpoint). The opt-in switch is `users.notify_new_nearby` (legacy name — it controls match and message pushes only).
- **Events:** new match ("💌 It's a match…", tag `match-<id>`) and new message ("💬 New message from…", tag `chat-<match_id>`). Both deep-link to `/?chat=<match_id>`.
- **Removed on owner request — do not re-add unprompted:** the "👋 Someone new just joined near <City>" broadcast.
- UI: a single toggle on the Profile screen, "Notify me: matches & messages" (`notify-me-toggle`).
- iPhone web push works only for Home-Screen-installed web apps on iOS 16.4 or newer. The native iOS wrapper's push is stubbed (§25).

---

## 18. Admin tools

All are restricted to `ADMIN_EMAILS` (currently localfiveguy@gmail.com and steavinrice@gmail.com). Most are simple GET links the owner can open in a signed-in browser.

| Endpoint | What it does |
|---|---|
| `GET /api/admin/funnel` | Sign-up funnel counts (signed in → onboarded → rules → video). |
| `GET /api/admin/diagnose-feed` | Dumps the viewer's location state, geocode-cache entry, browse center, raw label locals and same-town candidates, and build stamp. First stop for any "wrong people in my feed" report. |
| `GET /api/admin/find-user?q=…` | Search users by name, email, handle, or codename. Results include a ready-made `delete_url`. |
| `GET /api/admin/delete-user?id=…&confirm=DELETE` | Full wipe of one user, including their video in storage. Refuses demos and admin-listed emails. |
| `GET /api/admin/set-home-city?id=…&city=…&confirm=…` | Corrects a user's home town (fresh geocode, no cache). |
| `POST /api/admin/inactive-cleanup?days=90&dry_run=true` | Shows (or, with `dry_run=false`, performs) the inactive-video cleanup. Minimum 14 days. The same job also runs automatically once a day (§8). |

---

## 19. Configuration and secrets inventory

### Render → nice2meechu-api → Environment
**Plain values, defined in `render.yaml` and synced automatically:**
`PYTHON_VERSION=3.11.9`, `DB_NAME=nice2meechu`, `MONGO_USERNAME=localfiveguy_db_user`, `CORS_ORIGINS=https://nice2meechu.com,https://www.nice2meechu.com`, `GOOGLE_CLIENT_ID`, `APPLE_SERVICE_ID=nice2meechu.app.web`, `ADMIN_EMAILS`, `LLM_MODEL=gpt-4o-mini`, `GCP_PROJECT_ID=gen-lang-client-0271718241`, `GCS_BUCKET=nicemeechu`, `GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/gcs-credentials.json`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`.

**Secrets, entered by hand in the Render dashboard (never in git):**
| Name | What it is |
|---|---|
| `MONGO_URL` | Atlas address **without** a password: `mongodb+srv://cluster0.rkhvgso.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0` |
| `MONGO_PASSWORD` | Password of Atlas database user `localfiveguy_db_user`. `core.py` passes it to the driver separately, so it never has to be spliced into the URL. |
| `OPENAI_API_KEY` | OpenAI key named "Nice2Meechu". |
| `VAPID_PRIVATE_KEY` | Private half of the push key pair. |
| Secret File `gcs-credentials.json` | Service-account key for video storage (§15). |

A leftover variable named `IMPORT_TOKEN` may still be listed. It does nothing and can be deleted.

**Important Blueprint behavior:** a variable with a plain `value` in `render.yaml` is overwritten from the file on every push. Change those in `render.yaml`, not in the dashboard. Variables marked `sync: false` are kept as entered in the dashboard. A newly added `sync: false` variable must be created by hand in the dashboard.

### Netlify
No secrets. Public build values are in `netlify.toml` (§9).

### MongoDB Atlas
- Database user `localfiveguy_db_user` (Atlas Admin role).
- Network Access: `0.0.0.0/0` (allow from anywhere), because Render has no fixed outbound IP; the long random password protects the database. A second entry allows the owner's home IP.
- Free tier: no automatic backups (§22).

### Local development
`server.py` loads `backend/.env` if one exists. A local `.env` would hold the same names as the Render list above (plus `MONGO_URL` pointing at a local or Atlas database). `.env` files and `gcs-credentials.json` are git-ignored.

### Held only by the owner
Atlas password, OpenAI key, Network Solutions login, Render/Netlify/GitHub logins, Apple Developer and Google Play accounts, Android keystore passwords.

---

## 20. Security posture

- CORS: explicit origin allowlist with credentials. **Never use `*`.**
- `/translate` requires auth and caps input at 2,000 characters; messages and transcripts are capped too.
- Share-card cache is bounded (500); unknown handles are not cached.
- Auth errors are generic to clients; details go to server logs only.
- `/users/video` accepts only Google Cloud Storage or `/api/user-videos/` URLs.
- Apple email linking requires `email_verified`.
- Unique user indexes plus an insert race guard prevent duplicate accounts.
- Upload pipeline: MIME allowlist, 25 MB cap, spooled read, transcode in a temp folder with cleanup.
- `/api/handoff.md` is admin-only, because this document maps the hosting accounts.
- **Accepted risks (deliberate — do not "fix"):** the localStorage token fallback (needed for iPhone Safari), and no per-user rate limiting yet (backlog).
- Secrets live only in Render's dashboard; nothing secret is committed. The repository is public, so keep it that way.
- Google automatically disables any service-account key it finds in a public repository — another reason never to commit `gcs-credentials.json`.

---

## 21. Testing

- Suite: `backend/tests/` — 15 files, **120 tests**. They are integration tests that call a running API with a real session:
  ```
  cd backend
  export TEST_SESSION_TOKEN=<a valid session token for the QA account>
  export REACT_APP_BACKEND_URL=<base URL of the API under test>
  python3 -m pytest tests/ -q
  ```
  Point them at a **local or staging** API and database — several tests create and delete data, so do not run them against production.
- Notable suites: `test_home_town_feed.py` (8 km same-town rules, Marlton↔Evesham merging, no leak to Cherry Hill or Erial, removed radius endpoint returns 404), `test_webm_transcode.py` (byte-level: an uploaded webm must be served as an `ftyp` mp4 with h264 and aac), `test_home_city.py`, `test_unique_codenames.py` (uniqueness plus multi-device sessions), `test_admin_tools.py`, `test_likes_you.py`, `test_first_match.py`, `test_auth_surface.py`, `test_refactor_regression.py`.
- QA fixtures used by the suite: a QA account (`qa-tester@nice2meechu.local`, home city must stay "Tokyo, Japan") and two persistent fixtures, `test-john-erial` and `test-kathy-cherryhill`, with real playable mp4s in `gs://nicemeechu/user_videos/`. These fixtures do not exist in the production database; create them in whatever database the tests run against.
- Rules learned the hard way:
  - Never use `demo-NN` users as mutable test subjects.
  - Tests needing a particular browse city must set it themselves (no reliance on file order).
  - **Headless Chromium (Playwright) has no H.264 codec**, so every mp4 reports MediaError 4 in automation. That is a test-browser limit, not an app bug — verify codecs with ffprobe.
  - Verify **content**, not just status codes and file names (§24).
- There is no CI yet; wiring the suite into GitHub Actions is in the backlog.

---

## 22. Runbooks

**Is everything up?**
- Open `https://nice2meechu.com/api/` — shows the build stamp.
- Open `https://nice2meechu-api.onrender.com/health` — should say `{"status":"ok"}`.
- Render dashboard → nice2meechu-api should show "Live"; Netlify → Deploys should show "Published".

**Logs**
- API: Render → nice2meechu-api → Logs (search box supports text such as `POST /api/`).
- Website builds: Netlify → Deploys → click a deploy.

**Restart the API:** Render → nice2meechu-api → Manual Deploy → "Deploy latest commit".

**Roll back**
- API: Render → nice2meechu-api → Events → choose an earlier successful deploy → Rollback.
- Website: Netlify → Deploys → choose an earlier deploy → "Publish deploy".

**A build failed**
- Render: open the failed deploy's log. "bad auth: authentication failed" means `MONGO_PASSWORD` is wrong. "Exited with status 3" is an app startup error — read the traceback above it.
- Netlify: open the deploy log. The frontend has no lockfile, so a new upstream package release can occasionally break a build; pin the offending package version in `package.json`.

**Rotate the MongoDB password**
1. Atlas → Database Access → `localfiveguy_db_user` → Edit → Edit Password → Autogenerate → Copy → Update User.
2. Render → nice2meechu-api → Environment → Edit → paste into `MONGO_PASSWORD` → Save, rebuild, and deploy.

**Rotate the storage key**
1. Google Cloud → IAM & Admin → Service Accounts → `nice2meechu-video-uploader` → Keys → Add key → JSON (downloads a file).
2. Render → Environment → Secret Files → edit `gcs-credentials.json` → paste the whole file → Save, rebuild, and deploy.
3. After the new deploy is live, delete the old key in Google Cloud and delete the downloaded file.

**Rotate the OpenAI key:** platform.openai.com → API keys → create → Render `OPENAI_API_KEY` → save and deploy → revoke the old key.

**Videos stopped playing (403 errors):** check Google Cloud → Billing for project `gen-lang-client-0271718241`. It must be linked to an active billing account (§24, rule 4).

**"Error 400: origin_mismatch" at Google sign-in:** the site's address is missing from the OAuth client's authorized JavaScript origins (§10).

**Wrong people in a feed:** sign in as an admin and open `https://nice2meechu.com/api/admin/diagnose-feed`.

**Fix someone's home town:** `/api/admin/find-user?q=<name>` → copy the id → `/api/admin/set-home-city?id=<id>&city=<Town, ST>&confirm=…`.

**Remove a duplicate or abusive account:** `/api/admin/find-user?q=…` → open its `delete_url`.

**Force demo re-seed, heal, and ghost purge:** any signed-in visit to the feed (`GET /api/feed`).

**Re-run a one-shot migration:** delete its marker in Atlas → Browse Collections → `nice2meechu.migrations`, then restart the API.

**Back up the database (free tier has no automatic backups):** before risky changes, export collections from Atlas (Browse Collections → each collection → Export), or upgrade the cluster to a tier with backups. Note: Atlas's free tier does not support `mongodump` restores of system collections, but plain collection exports and imports work.

**Change DNS:** Network Solutions → Domains → nice2meechu.com → DNS. Keep the records in §4. TTL is 15 minutes, so changes spread quickly. After any DNS change, check Netlify → Domain management for a valid certificate and press "Renew certificate" if it shows an error.

---

## 23. Costs, renewals, and things that break if they lapse

| Item | Approximate cost | If it lapses |
|---|---|---|
| Render Starter | ~$7/month | API goes down → the whole site stops working. |
| Netlify | Free | Website goes down. |
| MongoDB Atlas | Free (512 MB) | Database becomes read-only when full. Current data is under 1 MB plus indexes. |
| Google Cloud Storage | Pennies per month | **If billing is unlinked, every video returns 403** Billing account "B of A" is at its 5-project limit — unlinking another project frees a slot. A budget alert is recommended. |
| OpenAI | Prepaid credit | **When credit runs out, the face check fails open** (videos post unchecked) and translation returns original text. A low-balance alert is recommended. |
| Domain (Network Solutions) | Yearly | Renews 2027-04-26. If it expires, the site disappears. |
| Apple Developer | Yearly | Apple sign-in keeps working on the web for existing configuration; needed for any App Store release. |

---

## 24. Hard rules and gotchas (read before changing anything)

1. **Never trust the geocode cache for writes.** `db.city_geo` is flushed on every boot, and anything written onto a user record must come from a fresh Photon geocode (`use_cache=False`). A wrong cached entry would otherwise be copied onto users and spread.
2. **Validate every location at the source.** `POST /users/location` checks the label against Photon; coordinates more than 100 km from the label lose.
3. **All real intros must be H.264/AAC mp4.** iPhone Safari cannot play webm. The upload pipeline transcodes webm, and tests check the actual file bytes (`ftyp`, h264, aac) — verify content, not just status codes or file names.
4. **Google Cloud billing must stay linked** to project `gen-lang-client-0271718241`, or every video returns 403.
5. **Never remove the root `GET /health` route.** Render's health check depends on it, and a deploy fails without it.
6. **Keep the localStorage/Bearer token fallback.** iPhone Safari's tracking prevention drops SameSite=None cookies during sign-in redirects.
7. **Keep `shrink-0`, the 360 px minimum, and the 50dvh maximum on the VideoPick camera box.** Without them, small iPhones crush the camera to nothing or push "Continue" off-screen.
8. **The Profile shows and edits `home_city` only.** Showing the browsing `city` would display a town the person merely looked at, and saving would move their home.
9. **No nearby radius.** The owner explicitly wants videos visible only in their own town. The 8 km same-town tolerance is the only slack. Do not add radius spreading without his explicit request.
10. **Apple "Hide My Email" accounts** don't match a Gmail address, so they would create duplicates. The linking flow (§10) handles this — keep it.
11. **Seed and test data must always be playable.** A dead test video renders as a black card that looks like a real bug.
12. **Codenames must stay unique** (1,600 combinations, enforced at signup).
13. **Every new web address** must be added to the Google OAuth client's authorized origins and redirect URIs, or sign-in shows "origin_mismatch".
14. **After any DNS change,** check Netlify's certificate; if it shows an error once DNS points at Netlify, press "Renew certificate".
15. **Self-healing code can spread bad data.** When something looks wrong in a feed, get direct evidence first with `/api/admin/diagnose-feed` before changing logic.

---

## 25. App store distribution (PARKED — the owner will publish months from now; do not nudge)

### Android — Google Play (artifacts ready)
- Trusted Web Activity built with Bubblewrap: `android-build/twa-project`. Package `com.nice2meechu.app`, versionName 1.0.1, versionCode 2.
- Signing keystore `android-build/twa-project/android.keystore` (alias `android`). **Back it up — losing it forces a new package id.** Keystore passwords are held by the owner.
- Downloads in `frontend/public/store-assets/`: `nice2meechu-play.aab`, `play-icon-512.png`, `feature-graphic-1024x500.png`, `play-listing.md` (listing text, content-rating and data-safety answers). `frontend/public/` also has `nice2meechu.aab` and `nice2meechu.apk`.
- `/.well-known/assetlinks.json` holds the local keystore SHA-256. When the app is uploaded to Play, Google re-signs it: the **App signing key certificate** SHA-256 from Play Console must be **added** to `assetlinks.json` and deployed, or the installed app shows a browser address bar.

### iOS — App Store (project ready; first cloud build never run)
- Wrapper at `ios-build/ios-app/` (ios-pwa-wrap template): bundle `com.nice2meechu.app`, Team `J99N4XLB3D`, version 1.0.0, loads nice2meechu.com, allows the Apple and Google sign-in popups, App-Bound Domains set, icons generated, descriptive camera/microphone/location permission strings, App Transport Security strict, arm64.
- HealthKit fully removed (rejection risk). A placeholder `GoogleService-Info.plist` is present and tracked in git.
- **Not compile-tested** (no Xcode available) — watch the first Codemagic build closely.
- Pipeline: `codemagic.yaml`, workflow `ios-appstore`: pod install → automatic signing through an App Store Connect API key integration named **exactly `nice2meechu-asc`** → build IPA → publish to TestFlight.
- The owner's eventual steps are written in `ios-build/README.md`.
- Review readiness: Sign in with Apple ✔, in-app account deletion ✔, report/block for user content ✔, permission strings ✔.

---

## 26. Backlog

**Recommended soon**
- Google Cloud budget alert and OpenAI low-balance alert (§23).
- Delete the unused `IMPORT_TOKEN` variable in Render.
- Remove old, unused redirect entries from the Google OAuth client (keep the nice2meechu.com, www, and netlify.app ones).
- Database backups (paid Atlas tier, or a scheduled export).
- Have a lawyer review the Privacy Policy and Terms (both still marked "Draft v1") before a public launch push.

**Product and engineering (P2/P3)**
- Per-user rate limiting (swipes, messages, reports).
- Native push (FCM) in the iOS wrapper.
- Referral/invite flow polish — the main growth lever now that feeds are strictly home-town (referral fields already exist).
- "You're one of the first in <town> — invite a neighbor" empty-state card.
- Component refactors: `ChangeLocationScreen` (~520 lines), `VideoPick`, `FeedScreen`, `App.js`.
- CI: run the test suite in GitHub Actions against a disposable database.
- Add a frontend lockfile for reproducible builds.
- Store listing screenshots and localized listings.
