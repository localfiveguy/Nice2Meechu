"""Thin OpenAI wrapper — replaces Emergent's `emergentintegrations` LlmChat.

Uses the official `openai` SDK with the owner's own key (OPENAI_API_KEY), so
the backend runs on any host (Render, Railway, ...). Callers check
`llm_enabled()` first and keep their existing fail-open behaviour when the
key is missing or the model errors.
"""
import os
from typing import Optional

from openai import AsyncOpenAI

import core  # noqa: F401  — importing core loads backend/.env before we read env vars

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
LLM_MODEL = os.environ.get("LLM_MODEL", "gpt-4o-mini").strip() or "gpt-4o-mini"

_client: Optional[AsyncOpenAI] = None


def llm_enabled() -> bool:
    """True when an OpenAI key is configured."""
    return bool(OPENAI_API_KEY)


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(api_key=OPENAI_API_KEY, timeout=30.0, max_retries=2)
    return _client


def _guess_image_mime(image_base64: str) -> str:
    """Infer the MIME type from the first bytes of a base64 image payload."""
    head = image_base64[:12]
    if head.startswith("iVBOR"):
        return "image/png"
    if head.startswith("UklGR"):
        return "image/webp"
    if head.startswith("R0lGOD"):
        return "image/gif"
    return "image/jpeg"


async def chat_text(system_message: str, user_text: str, temperature: float = 0.2) -> str:
    """Single-turn text completion. Raises on API errors (callers handle)."""
    resp = await _get_client().chat.completions.create(
        model=LLM_MODEL,
        temperature=temperature,
        messages=[
            {"role": "system", "content": system_message},
            {"role": "user", "content": user_text},
        ],
    )
    return (resp.choices[0].message.content or "").strip()


async def chat_vision(system_message: str, user_text: str, image_base64: str, temperature: float = 0.0) -> str:
    """Single-turn completion with one image (raw base64, no data: prefix)."""
    mime = _guess_image_mime(image_base64)
    resp = await _get_client().chat.completions.create(
        model=LLM_MODEL,
        temperature=temperature,
        messages=[
            {"role": "system", "content": system_message},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_text},
                    {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{image_base64}"}},
                ],
            },
        ],
    )
    return (resp.choices[0].message.content or "").strip()
