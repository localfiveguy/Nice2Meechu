# Nice2Meechu — Product Requirements Doc

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

## Updated (2026-05-30)
- **Profile edit form fixed** (`/app/frontend/src/App.js` ProfileScreen ~L1500). Edit form now collects `first_name`, `city` (via `CityAutocomplete`/Photon), `age`, `language`, `avatar_emoji` — matching the new `OnboardingReq` schema. Removed legacy `handle`/`vibes` inputs from the edit UI. View-mode now shows name · age · city · native language.
- Verified end-to-end: seeded a fully-onboarded user, opened `/profile` → Edit → changed name + age → Save → green "Saved" toast and updated view-mode card. Backend curl: 200 on valid payload, 400 on empty first_name / age=10.
- `/app/handoff.md` rewritten with embedded code (backend model + endpoint, old broken JSX, new JSX, curl verification).

## Prioritized backlog
- **P1** Real recorded-video upload to object storage (currently `URL.createObjectURL(blob)` — not persistent across sessions).
- **P1** Live translate-as-you-type preview in Chat before send (reuse `/api/translate`).
- **P2** Mark `onboarding_completed`, `community_rules_accepted`, `match_made`, `share_started` as Key Events in GA4 Admin.
- **P2** Push/online presence — show which matches are live now.
- **P2** Report / block user.
- **P2** Decommission old Netlify `nice2meechu` site once Emergent SSL stable ≥7 days.
- **P3** Voice-note replies; audio translation (TTS over translated text).
- **P3** Invite-only friends-of-friends discovery.
- **P3** Split `App.js` into per-screen files once it stops being a single-file brief.

## Next Tasks
- Click **Deploy** in Emergent workspace to push the Profile fix to `nice2meechu.com`.
- (Optional) Move recorded video upload to backend + persistent storage.
