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
- Backend: FastAPI + MongoDB. Endpoints: `/api/auth/send-otp`, `/api/auth/verify-otp`, `/api/users/onboarding`, `/api/users/me`, `/api/users/location`, `/api/users/video`, `/api/samples`, `/api/feed`, `/api/swipe`, `/api/matches`, `/api/messages/:id` (GET + POST), `/api/translate`.
- Twilio Verify integrated with graceful DEV/mock OTP fallback.
- OpenAI gpt-4o-mini translation via `emergentintegrations` + Emergent LLM Key.
- Demo users (6) auto-seeded with curated Mixkit portrait videos + transcripts in EN/ES/FR.
- Frontend: single-page App.js with 9 screens (Splash, Phone, OTP, Onboarding, Video-Pick, Feed, Matches, Chat, Profile) + Match celebration overlay.
- TikTok-style vertical scroll-snap feed with auto-play of in-view item, like/pass, translation overlay with typewriter animation.
- Bottom nav (Feed / Matches / You) with active state.
- Design: Unbounded display + Manrope body fonts, red (#FF4D4D) + cyan (#00E5FF) on near-black palette, mobile-first 480px phone frame with desktop framing.

## Prioritized backlog
- **P1** Plug live Twilio Verify keys (currently DEV mock).
- **P1** Real recorded-video upload to object storage (currently uses blob URL — not persistent across sessions).
- **P2** Push/online presence — show which matches are live now.
- **P2** Live translation for chat messages (currently only intro captions).
- **P2** Report / block user.
- **P3** Voice-note replies; audio translation (TTS over translated text).
- **P3** Invite-only friends-of-friends discovery.

## Next Tasks
- Capture live Twilio credentials from user; switch off DEV mode.
- (Optional) Move recorded video upload to backend + persistent storage.
