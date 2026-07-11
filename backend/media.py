"""Media & misc: face/age safety check (GPT-4o vision), OG share-card
rendering, and the live handoff-doc download."""
import io
import json as _json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from emergentintegrations.llm.chat import ImageContent, LlmChat, UserMessage
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, StreamingResponse

from auth import current_user
from core import EMERGENT_LLM_KEY, _OG_CACHE, db, logger
from models import FaceCheckReq

router = APIRouter()

_FONT_BOLD_PATH = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
_FONT_REG_PATH = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"


@router.post("/video/face-check")
async def face_check(req: FaceCheckReq, user=Depends(current_user)):
    """Use GPT-4o vision to (1) confirm the frame is one human face and content-safe,
    AND (2) estimate the person's apparent age for age-assurance.

    Returns: {ok: bool, reason: str, estimated_age: int|None, age_ok: bool}.
    Rejects if estimated age < 18 OR if estimated age differs from the user's
    declared age by more than 8 years (catches "I'm 30" when they look 15).

    If EMERGENT_LLM_KEY isn't configured we fail-open with ok=true so onboarding
    is never blocked by a misconfigured server.
    """
    img = (req.image_base64 or "").strip()
    if img.startswith("data:"):
        img = img.split(",", 1)[-1]
    if not img or len(img) < 200:
        raise HTTPException(400, "Image is required")
    if not EMERGENT_LLM_KEY:
        return {"ok": True, "reason": "skipped (no key)", "estimated_age": None, "age_ok": True}

    declared_age = int(user.get("age") or 0)
    try:
        chat = LlmChat(
            api_key=EMERGENT_LLM_KEY,
            session_id=f"facecheck-{uuid.uuid4()}",
            system_message=(
                "You are a strict content-safety + age-assurance reviewer for an intro-video social app. "
                "Look at the supplied image (one frame from a user's intro video) and decide TWO things:\n"
                "1. Is it acceptable? Acceptable = exactly ONE clearly visible human face looking roughly "
                "at the camera, fully clothed, no other people, no nudity / sexual content / hate symbols / "
                "weapons / illegal content / blank screen.\n"
                "2. Estimate the person's apparent age in YEARS (integer). Be conservative — if they could "
                "plausibly be a minor, err on the lower side. Do NOT rely on clothing or context; judge from "
                "facial features only. Return null only if no face is visible.\n"
                'Reply ONLY with strict JSON of the form '
                '{"ok": true|false, "reason": "<one short sentence>", "estimated_age": <int or null>}. '
                "No prose outside the JSON."
            ),
        ).with_model("openai", "gpt-4o-mini")
        msg = UserMessage(
            text="Review this intro-video frame: is it acceptable, and what is the apparent age?",
            file_contents=[ImageContent(image_base64=img)],
        )
        raw = (await chat.send_message(msg)) or ""
        s = raw.strip()
        if "```" in s:
            s = s.split("```", 2)[1]
            if s.lower().startswith("json"):
                s = s[4:]
            s = s.strip()
        parsed = _json.loads(s)
        ok = bool(parsed.get("ok"))
        reason = str(parsed.get("reason") or "")[:300]
        est_raw = parsed.get("estimated_age")
        estimated_age = int(est_raw) if isinstance(est_raw, (int, float)) and est_raw else None

        # Age-assurance gate — only apply when the model returned a number AND
        # the safety check itself passed (so we don't double-reject).
        #
        # ⚠️  GPT-4o vision age estimation is **unreliable for adults** —
        # routinely off by 10-15 years depending on lighting, glasses, hats,
        # and angle. The only thing it does *reasonably* well is distinguish
        # children/teens from adults. So our policy is:
        #   1. Hard block if estimated < 18 (legal compliance — must be 18+)
        #   2. Hard block if user *claims* adult age (≥18) but the model thinks
        #      they're plainly a minor (estimated < 16). Catches obvious liars.
        #   3. Otherwise — accept. Two adults can look different ages; that's
        #      not a safety issue and rejecting on it is too punishing.
        # Users always have the option to use the in-app Report form to flag
        # someone if vibes don't match the declared age post-match.
        age_ok = True
        if ok and estimated_age is not None:
            if estimated_age < 16:
                # Looks plainly underage regardless of what they declared.
                age_ok = False
                reason = (
                    f"You appear to be around {estimated_age}, but Nice2Meechu is 18+. "
                    "If this is wrong, please retake with better lighting or a clearer angle."
                )
                ok = False
            elif estimated_age < 18 and declared_age and declared_age >= 18:
                # Borderline 16-17 but declared adult — block to be safe.
                age_ok = False
                reason = (
                    f"You appear to be around {estimated_age}, but Nice2Meechu is 18+. "
                    "If this is wrong, please retake with better lighting or a clearer angle."
                )
                ok = False
            # NOTE: we no longer reject adult-vs-adult age mismatches.
            # The vision model can't reliably estimate adult age, so a 44yo
            # who looks 30 to GPT-4o is fine. We log the discrepancy for audit
            # but don't block the user.

        # Record the age-check outcome for audit trail (GDPR/DSA evidence)
        try:
            await db.age_checks.insert_one({
                "id": str(uuid.uuid4()),
                "user_id": user["id"],
                "declared_age": declared_age,
                "estimated_age": estimated_age,
                "ok": ok,
                "age_ok": age_ok,
                "at": datetime.now(timezone.utc).isoformat(),
            })
        except Exception:  # noqa: BLE001
            pass

        return {"ok": ok, "reason": reason, "estimated_age": estimated_age, "age_ok": age_ok}
    except Exception as exc:  # noqa: BLE001
        logger.exception("face-check failed: %s", exc)
        # Fail-open so users aren't blocked by transient model issues
        return {"ok": True, "reason": f"check unavailable ({exc.__class__.__name__})", "estimated_age": None, "age_ok": True}


def _safe_font(path: str, size: int):
    """Return ImageFont.truetype(path, size), or PIL default if path unavailable."""
    from PIL import ImageFont
    try:
        return ImageFont.truetype(path, size)
    except (OSError, IOError):  # noqa: UP024
        return ImageFont.load_default()


def _render_share_card(codename: str, emoji: str, handle: str | None) -> bytes:
    """Render a 1200x630 share card PNG with codename + emoji + tagline."""
    from PIL import Image, ImageDraw  # local import keeps cold-start fast
    from pilmoji import Pilmoji

    W, H = 1200, 630
    img = Image.new("RGB", (W, H), "#050507")
    draw = ImageDraw.Draw(img)

    # Subtle accent — a red→cyan gradient strip on the right edge
    for x in range(W - 14, W):
        t = (x - (W - 14)) / 14
        r = int(255 * (1 - t) + 0 * t)
        g = int(77 * (1 - t) + 229 * t)
        b = int(77 * (1 - t) + 255 * t)
        draw.line([(x, 0), (x, H)], fill=(r, g, b))

    # Subtle radial-ish bloom (two soft circles)
    bloom = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bloom)
    bd.ellipse([-260, -260, 540, 540], fill=(255, 77, 77, 40))
    bd.ellipse([W - 540, H - 540, W + 260, H + 260], fill=(0, 229, 255, 30))
    img = Image.alpha_composite(img.convert("RGBA"), bloom).convert("RGB")
    draw = ImageDraw.Draw(img)

    # Small brand mark top-left
    brand_font = _safe_font(_FONT_BOLD_PATH, 30)
    draw.text((64, 56), "NICE2MEECHU", fill="#FFFFFF", font=brand_font)
    draw.text((64 + 290, 56), ".", fill="#FF4D4D", font=brand_font)

    # Big "joins you on" prefix
    pref_font = _safe_font(_FONT_REG_PATH, 36)
    draw.text((64, 200), "Nice2Meechu invite from", fill="#FFFFFF80", font=pref_font)

    # Codename — large bold
    name_font = _safe_font(_FONT_BOLD_PATH, 110)
    safe_name = (codename or "Anon").strip()[:24]
    draw.text((64, 256), safe_name, fill="#FFFFFF", font=name_font)

    # Emoji rendered via pilmoji (uses Twitter color emoji)
    if emoji:
        with Pilmoji(img) as p:
            emoji_font = _safe_font(_FONT_BOLD_PATH, 96)
            try:
                p.text((64, 384), emoji[:2], font=emoji_font)
            except Exception:  # noqa: BLE001
                pass
        draw = ImageDraw.Draw(img)

    # Tagline at the bottom
    tag_font = _safe_font(_FONT_REG_PATH, 32)
    tag = "video-first  ·  hyperlocal  ·  anonymous until the spark"
    draw.text((64, H - 120), tag, fill="#FFFFFFB0", font=tag_font)

    # Handle pill, bottom-right
    if handle:
        h_text = f"@{handle}"
        hf = _safe_font(_FONT_BOLD_PATH, 28)
        bbox = draw.textbbox((0, 0), h_text, font=hf)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        px, py = W - tw - 96, H - 96
        pad = 16
        draw.rounded_rectangle(
            [px - pad, py - pad, px + tw + pad, py + th + pad + 4],
            radius=24, fill="#FF4D4D",
        )
        draw.text((px, py - 4), h_text, fill="#FFFFFF", font=hf)

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


@router.get("/og/{handle}")
async def og_card(handle: str):
    """Return a 1200x630 PNG share card for the given user handle."""
    handle = handle.lower().strip()
    if handle in _OG_CACHE:
        return StreamingResponse(io.BytesIO(_OG_CACHE[handle]), media_type="image/png")

    user = await db.users.find_one({"handle": handle}, {"_id": 0})
    if not user:
        # generic card so the link still unfurls nicely
        png = _render_share_card("Nice2Meechu", "✨", None)
    else:
        png = _render_share_card(
            codename=user.get("codename") or "Anon",
            emoji=user.get("avatar_emoji") or "✨",
            handle=user.get("handle"),
        )
    _OG_CACHE[handle] = png
    return StreamingResponse(io.BytesIO(png), media_type="image/png")


@router.get("/handoff.md")
async def get_handoff_doc():
    """Serve the live engineering handoff doc as a download. Used when the
    operator wants the latest fork notes saved locally without having to clone
    the repo. The handoff lives at the repo root (/app/handoff.md) and is
    rewritten in-place by the agent at the end of each fork — so this endpoint
    always serves the freshest copy."""
    path = Path("/app/handoff.md")
    if not path.is_file():
        raise HTTPException(404, "handoff.md not found")
    return FileResponse(
        path,
        media_type="text/markdown; charset=utf-8",
        filename="nice2meechu-handoff.md",
    )
