# Resuming Sora 2 demo-video generation

The Nice2Meechu demo feed is currently filled by **24 AI-generated talking-head
videos** rendered with **Sora 2** (via the Emergent LLM universal key).
The original plan was 78 videos — 24 succeeded before the LLM key hit
`insufficient_balance`. The remaining 54 are queued but not generated.

## Where things live
- Persona blueprint (78 entries):  `/app/backend/videos/demo_meta.json`
- Rendered MP4s (24 of 78):        `/app/backend/videos/demo_XX.mp4`
- Generator script:                `/app/backend/scripts/generate_demo_videos.py`
- Backend seeder:                  `seed_demo_users()` in `/app/backend/server.py`
  reads `demo_meta.json` at startup and only seeds personas whose MP4 exists.
  → As you generate more videos, more demos appear in the feed automatically.

## To resume (and pay for the rest)

> **Important** — the 24 already-rendered videos used the original generic prompt (no specific dialogue), so their audio is silent or improvised. The new generator prompts Sora to **say the exact line "Hi, my name is {NAME}, and I live in {CITY}."** with lip-sync. To get matching audio for the 24 existing ones, delete them first so they get re-rendered:
> ```bash
> # OPTIONAL — only if you want the 24 existing videos to be re-spoken with the new line.
> # Skip if you're OK with the 24 existing being silent / off-script.
> rm /app/backend/videos/demo_*.mp4 /app/backend/videos/demo_meta.json
> ```

1. **Top up the Emergent LLM key.**
   In the Emergent workspace: *Profile → Universal Key → Add Balance*
   (or enable auto-top-up). Budget hint: ~$0.10–0.50 per 4-sec Sora 2 video.
   Remaining 54 ≈ **$5–$30** to finish the full 78.

2. **Rerun the generator** (it's idempotent — any already-rendered file is skipped):
   ```bash
   cd /app/backend
   SORA_CONCURRENCY=6 nohup python3 -u scripts/generate_demo_videos.py \
     > /tmp/sora_resume.log 2>&1 &
   echo "PID=$!"
   ```
   Progress:
   ```bash
   tail -f /tmp/sora_resume.log
   ls /app/backend/videos/demo_*.mp4 | wc -l   # should climb to 78
   ```
   Expected wall time at concurrency 6: ~30–60 min.

3. **Pick up the new demos** without restarting:
   The backend calls `seed_demo_users()` on every `/api/feed` request, so the
   first feed load after a new file lands will insert that demo user into Mongo.

4. **Deploy** to push the new MP4s to production
   (`/app/backend/videos/` is bundled with the backend container).

## Tweaking before resume
- **Add / change cities:** edit `CITY_PLAN` and `VIBES_BY_CITY` in
  `scripts/generate_demo_videos.py`, then rerun.
- **Change transcripts / languages:** edit `TRANSCRIPTS` in the same file.
- **Change video duration / size:** `render_one(..., duration=4, size="720x1280")`.
  Sora 2 only accepts `720x1280` (portrait) or `1280x720` (landscape).
- **Wipe + start over:** delete `demo_*.mp4` AND `demo_meta.json`, then rerun.

## Note on local SDK patch
`emergentintegrations.llm.openai.video_generation.SIZES` was locally edited
to add `720x1280` (the upstream SDK was missing it). If you pip-install / upgrade
that package, re-apply the same one-line patch.
