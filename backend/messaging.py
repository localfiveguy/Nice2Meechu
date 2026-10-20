"""Match chat: message history w/ cached AI translation, sending, /translate."""
import asyncio
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pymongo import UpdateOne

from auth import current_user
from core import LANG_NAMES, _rng, db, logger
from llm import chat_text, llm_enabled
from models import MessageReq, TranslateReq
from push import notify_user

router = APIRouter()


async def _translate_text(text: str, target_lang: str, source_lang: Optional[str]) -> str:
    """Translate text via the OpenAI helper (llm.py). Returns original on same-language or LLM failure."""
    if not text:
        return ""
    if (source_lang or "") == target_lang:
        return text
    if not llm_enabled():
        return text
    target = LANG_NAMES.get(target_lang, target_lang)
    src = LANG_NAMES.get(source_lang or "", "the source language")
    try:
        out = await chat_text(
            f"You are a real-time translator. Translate the user's text from {src} to {target}. "
            "Return ONLY the translated text, no quotes, no preface, no explanation.",
            text,
        )
        return (out or text).strip()
    except Exception as exc:  # noqa: BLE001
        logger.exception("translate failed: %s", exc)
        return text


@router.get("/messages/{match_id}")
async def get_messages(match_id: str, user=Depends(current_user)):
    match = await db.matches.find_one({"id": match_id, "user_ids": user["id"]}, {"_id": 0})
    if not match:
        raise HTTPException(404, "Match not found")
    msgs = await db.messages.find({"match_id": match_id}, {"_id": 0}).sort("at", 1).to_list(500)

    reader_lang = (user.get("language") or "en")

    # First pass — pull cached translations and collect un-cached ones to translate
    needs_translation = []  # list of indices in msgs
    translations_out: dict[int, Optional[str]] = {}
    for i, m in enumerate(msgs):
        source_lang = m.get("source_lang") or "en"
        is_own = m.get("from_user_id") == user["id"]
        if is_own or source_lang == reader_lang:
            translations_out[i] = None
            continue
        cached = (m.get("translations") or {}).get(reader_lang)
        if cached:
            translations_out[i] = cached
        else:
            needs_translation.append(i)

    # Translate all uncached messages in parallel via asyncio.gather
    if needs_translation:
        results = await asyncio.gather(
            *[
                _translate_text(
                    msgs[i]["text"], reader_lang, msgs[i].get("source_lang") or "en"
                )
                for i in needs_translation
            ],
            return_exceptions=True,
        )
        bulk_ops = []
        for i, res in zip(needs_translation, results):
            if isinstance(res, Exception):
                translations_out[i] = None
                continue
            translations_out[i] = res
            bulk_ops.append(
                UpdateOne(
                    {"id": msgs[i]["id"]},
                    {"$set": {f"translations.{reader_lang}": res}},
                )
            )
        # Persist all new translations in one round-trip
        if bulk_ops:
            await db.messages.bulk_write(bulk_ops, ordered=False)

    out = []
    for i, m in enumerate(msgs):
        out.append(
            {
                **m,
                "translated_text": translations_out.get(i),
                "source_lang": m.get("source_lang") or "en",
            }
        )
    return {"messages": out}


@router.post("/messages")
async def send_message(req: MessageReq, user=Depends(current_user)):
    match = await db.matches.find_one({"id": req.match_id, "user_ids": user["id"]}, {"_id": 0})
    if not match:
        raise HTTPException(404, "Match not found")
    msg = {
        "id": str(uuid.uuid4()),
        "match_id": req.match_id,
        "from_user_id": user["id"],
        "text": req.text,
        "source_lang": user.get("language") or "en",
        "translations": {},
        "at": datetime.now(timezone.utc).isoformat(),
    }
    await db.messages.insert_one(msg.copy())
    msg.pop("_id", None)

    # Quick demo auto-reply so the chat doesn't feel empty in a demo match.
    other_id = [uid for uid in match["user_ids"] if uid != user["id"]][0]
    other = await db.users.find_one({"id": other_id}, {"_id": 0})
    if other and not other.get("is_demo"):
        # Human recipient → push (opt-in; collapses per-chat via tag).
        asyncio.create_task(notify_user(
            other_id,
            f"💬 New message from {user.get('codename') or 'your match'}",
            url=f"/?chat={req.match_id}",
            tag=f"chat-{req.match_id}",
        ))
    if other and other.get("is_demo"):
        replies = [
            "haha love that 😄",
            "okay you have great taste",
            "tomorrow then? meet at 6?",
            "tell me more about that",
            "you sound like trouble (good kind)",
        ]
        await db.messages.insert_one(
            {
                "id": str(uuid.uuid4()),
                "match_id": req.match_id,
                "from_user_id": other_id,
                "text": _rng.choice(replies),
                "source_lang": "en",
                "translations": {},
                "at": datetime.now(timezone.utc).isoformat(),
            }
        )
    return {"ok": True}


@router.post("/translate")
async def translate(req: TranslateReq, user=Depends(current_user)):
    if not llm_enabled():
        raise HTTPException(500, "OPENAI_API_KEY not configured")
    out = await _translate_text(req.text, req.target_lang, req.source_lang)
    return {"translation": out, "target_lang": req.target_lang}
