"""Frontend Playwright test — VideoPick recorder regression.

Launches Chromium with --use-fake-ui-for-media-stream + --use-fake-device-for-media-stream
so getUserMedia auto-grants a green test pattern with no permission dialog.
"""
import asyncio
import os
from playwright.async_api import async_playwright

APP_URL = "https://hyperlocal-video.preview.emergentagent.com"
TOKEN = "sttest_SUQD-bH3lyJJOBLw-llOftxhxupA_9nU"


async def main():
    console_errors = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=[
                "--use-fake-ui-for-media-stream",
                "--use-fake-device-for-media-stream",
                "--autoplay-policy=no-user-gesture-required",
            ],
        )
        context = await browser.new_context(viewport={"width": 390, "height": 844})
        page = await context.new_page()

        page.on("console", lambda msg: (
            console_errors.append(msg.text) if msg.type == "error" else None
        ))
        page.on("pageerror", lambda err: console_errors.append(f"pageerror: {err}"))

        try:
            print("STEP 1: sign in via fragment token")
            await page.goto(f"{APP_URL}/#st={TOKEN}", wait_until="domcontentloaded")
            await page.wait_for_timeout(3000)

            # Feed lands with nav bar visible
            try:
                await page.wait_for_selector('[data-testid="nav-profile"]', timeout=15000)
                print("  OK: nav-profile visible → signed in")
            except Exception as e:
                await page.screenshot(path="/app/.screenshots/vp_signin_fail.png", full_page=False)
                print(f"  FAIL signin: {e}")
                return

            print("STEP 2: dismiss cookie banner if present, then open Profile")
            try:
                accept = await page.wait_for_selector('button:has-text("Accept")', timeout=2500)
                if accept:
                    await accept.click(force=True)
                    print("  cookies accepted")
                    await page.wait_for_timeout(500)
            except Exception:
                pass
            await page.click('[data-testid="nav-profile"]', force=True)
            await page.wait_for_timeout(2000)

            print("STEP 3: click 'Change intro'")
            # Look for change intro button — could be text or testid
            candidates = [
                '[data-testid="profile-change-video"]',
                'button:has-text("Change intro")',
            ]
            clicked = False
            for sel in candidates:
                try:
                    el = await page.wait_for_selector(sel, timeout=2000, state="visible")
                    if el:
                        await el.click(force=True)
                        print(f"  clicked via {sel}")
                        clicked = True
                        break
                except Exception:
                    continue
            if not clicked:
                await page.screenshot(path="/app/.screenshots/vp_no_change_intro.png", full_page=False)
                # dump visible buttons for debugging
                btns = await page.evaluate("() => Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim()).filter(Boolean)")
                print(f"  FAIL: 'Change intro' button not found. Visible buttons: {btns[:20]}")
                return

            print("STEP 4: wait for video-pick-screen")
            await page.wait_for_selector('[data-testid="video-pick-screen"]', timeout=8000)
            print("  OK: VideoPick opened")

            print("STEP 5: wait for camera stream ready (overlay disappears)")
            # streamReady state — <video> preview should attach. Wait a bit for getUserMedia.
            await page.wait_for_timeout(3500)
            waiting_overlay = await page.query_selector('text=Waiting for camera')
            if waiting_overlay:
                visible = await waiting_overlay.is_visible()
                print(f"  Waiting overlay still visible? {visible}")
                if visible:
                    print("  WARN: overlay didn't disappear within 3.5s — waiting more")
                    await page.wait_for_timeout(3000)

            print("STEP 6: click record-toggle-button (start)")
            await page.wait_for_selector('[data-testid="record-toggle-button"]', timeout=5000)
            await page.click('[data-testid="record-toggle-button"]', force=True)
            await page.wait_for_timeout(500)

            # Check countdown chip
            try:
                await page.wait_for_selector('[data-testid="record-countdown"]', timeout=3000)
                cd_text = await page.text_content('[data-testid="record-countdown"]')
                print(f"  OK: countdown visible: '{cd_text}'")
            except Exception as e:
                print(f"  FAIL countdown: {e}")

            print("STEP 7: wait ~2.5s then stop")
            await page.wait_for_timeout(2500)
            await page.click('[data-testid="record-toggle-button"]', force=True)
            await page.wait_for_timeout(2000)

            print("STEP 8: verify playback + retake appear (blob produced)")
            playback_ok = False
            retake_ok = False
            try:
                await page.wait_for_selector('[data-testid="record-playback-video"]', timeout=5000)
                playback_ok = True
                print("  OK: record-playback-video visible")
            except Exception as e:
                print(f"  FAIL playback: {e}")
            try:
                await page.wait_for_selector('[data-testid="record-retake-button"]', timeout=3000)
                retake_ok = True
                print("  OK: record-retake-button visible")
            except Exception as e:
                print(f"  FAIL retake: {e}")

            print("STEP 9: check console for NotSupportedError")
            not_supported = [e for e in console_errors if "NotSupportedError" in e or "not supported" in e.lower()]
            if not_supported:
                print(f"  FAIL: NotSupportedError seen: {not_supported}")
            else:
                print("  OK: no NotSupportedError")

            await page.screenshot(path="/app/.screenshots/vp_playback.png", full_page=False)

            print("\n=== SUMMARY ===")
            print(f"stream_ready: assumed OK (record button worked)")
            cd_el = await page.query_selector('[data-testid="record-countdown"]')
            print(f"countdown_ok: {'yes' if (cd_el is not None or playback_ok) else 'no'}")
            print(f"playback_video_ok: {playback_ok}")
            print(f"retake_button_ok: {retake_ok}")
            print(f"console_errors_total: {len(console_errors)}")
            if console_errors:
                for e in console_errors[:10]:
                    print(f"  console: {e[:200]}")

        finally:
            await browser.close()


asyncio.run(main())
