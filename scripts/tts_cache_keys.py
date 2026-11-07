"""Shared TTS cache key helpers — must match src/worker.js exactly."""
from __future__ import annotations

import hashlib
import re

AURA_MODEL = "@cf/deepgram/aura-2-en"
TTS_CACHE_VERSION = "v1"
AURA_SPEAKERS = ("asteria", "luna")


def sanitize_speak_text(raw: str | None) -> str | None:
    text = str(raw or "").strip()
    text = re.sub(r"\s+", " ", text)
    if not text or len(text) > 200:
        return None
    if not re.match(r"^[A-Za-z][A-Za-z0-9\s\-',.?!]*[.?!]?$", text):
        return None
    if re.search(r"[<>{}\[\]\\|;`]", text):
        return None
    return text


def tts_cache_key(text: str, speaker: str, model: str = AURA_MODEL) -> str:
    material = f"{TTS_CACHE_VERSION}|{model}|{speaker}|{text}"
    digest = hashlib.sha256(material.encode("utf-8")).hexdigest()
    return f"tts/{TTS_CACHE_VERSION}/{digest}.mp3"
