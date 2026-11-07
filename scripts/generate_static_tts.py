#!/usr/bin/env python3
"""Pre-generate Edge TTS MP3s into public/audio/{w,e}/ for every word + example.

Voice: en-GB-SoniaNeural (clear British English, suitable for HK kids).
No Cloudflare Workers AI — static assets only.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "src" / "words-data.json"
OUT_W = ROOT / "public" / "audio" / "w"
OUT_E = ROOT / "public" / "audio" / "e"
VOICE = "en-GB-SoniaNeural"


def sanitize_text(t: str) -> str:
    t = re.sub(r"\s+", " ", str(t or "").strip())
    return t[:500]


async def synth_one(edge_tts, text: str, dest: Path, sem: asyncio.Semaphore) -> bool:
    async with sem:
        for attempt in range(5):
            try:
                communicate = edge_tts.Communicate(text, VOICE)
                await communicate.save(str(dest))
                if dest.exists() and dest.stat().st_size > 200:
                    return True
            except Exception as err:
                await asyncio.sleep(1.2 * (attempt + 1))
                last = err
        print(f"FAIL {dest.name}: {last}", file=sys.stderr)
        return False


async def main_async(limit: int | None, force: bool):
    try:
        import edge_tts
    except ImportError:
        sys.path.insert(0, "/workspace/p5english/.venv/lib/python3.13/site-packages")
        import edge_tts

    items = json.loads(DATA.read_text(encoding="utf-8"))
    OUT_W.mkdir(parents=True, exist_ok=True)
    OUT_E.mkdir(parents=True, exist_ok=True)

    jobs = []
    for it in items:
        wid = re.sub(r"[^a-z]", "", str(it.get("id") or it.get("word") or "").lower())
        if not wid:
            continue
        wtxt = sanitize_text(it.get("word") or "")
        etxt = sanitize_text(it.get("example") or "")
        if wtxt:
            jobs.append(("w", wid, wtxt, OUT_W / f"{wid}.mp3"))
        if etxt:
            jobs.append(("e", wid, etxt, OUT_E / f"{wid}.mp3"))
    if limit:
        jobs = jobs[:limit]

    sem = asyncio.Semaphore(6)
    ok = skip = fail = 0
    pending = []
    for kind, wid, text, dest in jobs:
        if dest.exists() and dest.stat().st_size > 200 and not force:
            skip += 1
            continue
        pending.append(synth_one(edge_tts, text, dest, sem))

    print(f"synth {len(pending)} (skip existing {skip}) voice={VOICE}")
    results = await asyncio.gather(*pending) if pending else []
    ok = sum(1 for r in results if r)
    fail = sum(1 for r in results if not r)
    w_count = len(list(OUT_W.glob("*.mp3")))
    e_count = len(list(OUT_E.glob("*.mp3")))
    print(f"done ok={ok} fail={fail} skip={skip} files w={w_count} e={e_count}")
    return 0 if fail == 0 else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    raise SystemExit(asyncio.run(main_async(args.limit, args.force)))


if __name__ == "__main__":
    main()
