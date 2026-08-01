"""Face-check moderation policy — clothing must be ignored, safety/age kept."""
import asyncio
import sys
from unittest.mock import AsyncMock, patch

sys.path.insert(0, "/app/backend")
import media  # noqa: E402


def test_prompt_ignores_clothing():
    p = media._REVIEW_SYSTEM_PROMPT
    assert "fully clothed" not in p
    assert "IGNORE" in p and "clothing" in p
    assert "shirtless" in p


def test_prompt_keeps_safety_and_face_checks():
    p = media._REVIEW_SYSTEM_PROMPT
    assert "ONE clearly visible human face" in p
    assert "explicit sexual content" in p
    assert "estimated_age" in p


def test_llm_parse_ok(monkeypatch):
    raw = '{"ok": true, "reason": "One clear face, casual tank top.", "estimated_age": 34}'
    with patch.object(media.LlmChat, "send_message", new=AsyncMock(return_value=raw)):
        monkeypatch.setattr(media, "EMERGENT_LLM_KEY", "test-key", raising=False)
        ok, reason, age = asyncio.run(media._llm_review_frame("x" * 300))
    assert ok is True and age == 34


def test_llm_parse_reject_nudity():
    raw = '```json\n{"ok": false, "reason": "Explicit nudity visible.", "estimated_age": null}\n```'
    with patch.object(media.LlmChat, "send_message", new=AsyncMock(return_value=raw)):
        ok, reason, age = asyncio.run(media._llm_review_frame("x" * 300))
    assert ok is False and age is None


def test_age_gate_blocks_minor():
    ok, reason, age_ok = media._apply_age_gate(True, "fine", 14, 25)
    assert ok is False and age_ok is False and "18+" in reason


def test_age_gate_accepts_adult():
    ok, reason, age_ok = media._apply_age_gate(True, "fine", 34, 40)
    assert ok is True and age_ok is True
