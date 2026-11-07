#!/usr/bin/env python3
"""
Pre-generate TTS MP3s for every word + example in words-data.json and upload
to the TTS_CACHE KV namespace (same keys /api/speak uses).

Workers AI daily free neurons are often exhausted (Aura-2 ≈ 2727 neurons / 1k
chars). This script defaults to Microsoft Edge neural TTS (edge-tts) so the
full catalog can be cached offline. Pass --provider aura once neurons/paid
plan is available to regenerate with @cf/deepgram/aura-2-en.

Usage:
  .venv/bin/python scripts/backfill_tts.py
  .venv/bin/python scripts/backfill_tts.py --speakers asteria
  .venv/bin/python scripts/backfill_tts.py --limit 5   # dry smoke
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import sys
import time
import tomllib
from pathlib import Path

import edge_tts
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from tts_cache_keys import (  # noqa: E402
    AURA_SPEAKERS,
    sanitize_speak_text,
    tts_cache_key,
)

WORDS_PATH = ROOT / "src" / "words-data.json"
OUT_DIR = ROOT / ".tts-cache"
WRANGLER_TOML = Path.home() / ".config" / ".wrangler" / "config" / "default.toml"
ACCOUNT_ID = "17d7ed80731ea6ee7a43aba9835f2cc8"
# From wrangler.jsonc TTS_CACHE binding
KV_NAMESPACE_ID = "3d3b2c7a3db8468ea35659af25260f98"

# Map Aura speaker names → Edge neural voices (female EN, clear for kids)
EDGE_VOICE = {
    "asteria": "en-US-AriaNeural",
    "luna": "en-US-JennyNeural",
}


def load_texts() -> list[str]:
    data = json.loads(WORDS_PATH.read_text())
    texts: list[str] = []
    for it in data:
        for field in ("word", "example"):
            clean = sanitize_speak_text(it.get(field))
            if clean:
                texts.append(clean)
    # stable unique
    return sorted(set(texts))


def oauth_token() -> str:
    with WRANGLER_TOML.open("rb") as f:
        cfg = tomllib.load(f)
    return cfg["oauth_token"]


async def synth_edge(text: str, speaker: str, dest: Path, sem: asyncio.Semaphore) -> bool:
    voice = EDGE_VOICE[speaker]
    async with sem:
        for attempt in range(4):
            try:
                communicate = edge_tts.Communicate(text, voice)
                await communicate.save(str(dest))
                if dest.exists() and dest.stat().st_size > 0:
                    return True
            except Exception as err:
                wait = 1.5 * (attempt + 1)
                print(f"  retry {attempt+1} {speaker!r} {text[:40]!r}: {err}", flush=True)
                await asyncio.sleep(wait)
        return False


async def generate_all(texts: list[str], speakers: list[str], concurrency: int) -> list[tuple[str, str, Path]]:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    sem = asyncio.Semaphore(concurrency)
    jobs = []
    meta: list[tuple[str, str, Path]] = []
    for text in texts:
        for speaker in speakers:
            key = tts_cache_key(text, speaker)
            # filesystem-safe filename = hash part
            fname = key.replace("/", "__")
            dest = OUT_DIR / fname
            meta.append((text, speaker, dest))
            if dest.exists() and dest.stat().st_size > 0:
                continue
            jobs.append(synth_edge(text, speaker, dest, sem))

    print(f"Generating {len(jobs)} mp3s (skip {len(meta)-len(jobs)} cached on disk); concurrency={concurrency}", flush=True)
    ok = 0
    fail = 0
    if jobs:
        results = await asyncio.gather(*jobs, return_exceptions=True)
        for r in results:
            if r is True:
                ok += 1
            else:
                fail += 1
                if isinstance(r, Exception):
                    print("  gen err:", r, flush=True)
    print(f"Generate done: ok={ok} fail={fail} disk_total={sum(1 for *_, p in meta if p.exists())}", flush=True)
    return meta


def kv_bulk_put(items: list[dict], token: str) -> None:
    url = (
        f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}"
        f"/storage/kv/namespaces/{KV_NAMESPACE_ID}/bulk"
    )
    body = json.dumps(items).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="PUT",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        payload = json.loads(resp.read().decode())
    if not payload.get("success"):
        raise RuntimeError(f"KV bulk failed: {payload}")


def upload_all(meta: list[tuple[str, str, Path]], batch_size: int = 40) -> tuple[int, int]:
    token = oauth_token()
    uploaded = 0
    skipped = 0
    batch: list[dict] = []
    batch_bytes = 0
    max_batch_bytes = 80 * 1024 * 1024  # stay under API limits

    def flush():
        nonlocal batch, batch_bytes, uploaded
        if not batch:
            return
        for attempt in range(4):
            try:
                kv_bulk_put(batch, token)
                uploaded += len(batch)
                print(f"  uploaded batch n={len(batch)} total={uploaded}", flush=True)
                batch = []
                batch_bytes = 0
                time.sleep(0.35)  # gentle rate limit
                return
            except Exception as err:
                print(f"  upload retry {attempt+1}: {err}", flush=True)
                time.sleep(2 * (attempt + 1))
        raise RuntimeError("upload failed after retries")

    for text, speaker, path in meta:
        if not path.exists() or path.stat().st_size == 0:
            skipped += 1
            continue
        key = tts_cache_key(text, speaker)
        raw = path.read_bytes()
        entry = {
            "key": key,
            "value": base64.b64encode(raw).decode("ascii"),
            "base64": True,
            "metadata": {
                "speaker": speaker,
                "chars": len(text),
                "source": "edge-tts",
                "textPreview": text[:80],
            },
        }
        # flush if batch would be huge
        if batch and (len(batch) >= batch_size or batch_bytes + len(raw) > max_batch_bytes):
            flush()
        batch.append(entry)
        batch_bytes += len(raw)
    flush()
    return uploaded, skipped


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--speakers", nargs="+", default=["asteria"], choices=list(AURA_SPEAKERS))
    ap.add_argument("--limit", type=int, default=0, help="only first N texts (smoke test)")
    ap.add_argument("--concurrency", type=int, default=6)
    ap.add_argument("--skip-upload", action="store_true")
    ap.add_argument("--upload-only", action="store_true")
    args = ap.parse_args()

    texts = load_texts()
    if args.limit:
        texts = texts[: args.limit]
    print(f"texts={len(texts)} speakers={args.speakers}", flush=True)

    if args.upload_only:
        meta = []
        for text in texts:
            for speaker in args.speakers:
                key = tts_cache_key(text, speaker)
                dest = OUT_DIR / key.replace("/", "__")
                meta.append((text, speaker, dest))
    else:
        meta = asyncio.run(generate_all(texts, args.speakers, args.concurrency))

    missing = [(t, s, p) for t, s, p in meta if not p.exists() or p.stat().st_size == 0]
    print(f"local mp3 ready={len(meta)-len(missing)} missing={len(missing)}", flush=True)
    if missing[:5]:
        print("  missing sample:", missing[:5], flush=True)

    if args.skip_upload:
        print("skip upload", flush=True)
        return 0 if not missing else 1

    uploaded, skipped = upload_all(meta)
    print(f"DONE uploaded={uploaded} skipped_missing_file={skipped} expected={len(meta)}", flush=True)
    return 0 if uploaded + skipped == len(meta) and skipped == 0 else (0 if uploaded else 1)


if __name__ == "__main__":
    raise SystemExit(main())
