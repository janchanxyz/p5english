#!/usr/bin/env python3
"""Rewrite Wikimedia URLs in words-data.json to Commons-allowed 500px thumbs."""
from __future__ import annotations
import json, re
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "src" / "words-data.json"
WIDTH = 500  # allowed size: https://w.wiki/GHai

ORIG_RE = re.compile(
    r"^https?://(?:upload|thumb)\.wikimedia\.org/wikipedia/([^/]+)/(?!thumb/)([0-9a-f])/([0-9a-f]{2})/([^/?#]+)$",
    re.I,
)
THUMB_RE = re.compile(
    r"^https?://(?:upload|thumb)\.wikimedia\.org/wikipedia/([^/]+)/thumb/([0-9a-f])/([0-9a-f]{2})/([^/]+)/((?:lossy-page\d+-)?\d+px-[^/?#]+)$",
    re.I,
)

def strip_qs(url: str) -> str:
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))

def to_thumb(url: str, width: int = WIDTH) -> str:
    if not url or not isinstance(url, str):
        return url
    u = strip_qs(url.strip())
    m = THUMB_RE.match(u)
    if m:
        wiki, a, ab, fname, thumbfile = m.groups()
        thumbfile2 = re.sub(r"\d+px-", f"{width}px-", thumbfile, count=1)
        return f"https://upload.wikimedia.org/wikipedia/{wiki}/thumb/{a}/{ab}/{fname}/{thumbfile2}"
    m = ORIG_RE.match(u)
    if m:
        wiki, a, ab, fname = m.groups()
        return f"https://upload.wikimedia.org/wikipedia/{wiki}/thumb/{a}/{ab}/{fname}/{width}px-{fname}"
    return u

def main() -> None:
    data = json.loads(DATA.read_text())
    for w in data:
        urls = []
        for key in ("thumbUrl", "imageUrl"):
            if w.get(key):
                urls.append(w[key])
        urls += list(w.get("imageUrls") or [])
        seen, norm = set(), []
        for u in urls:
            if not u:
                continue
            n = to_thumb(u)
            if n in seen:
                continue
            seen.add(n)
            norm.append(n)
            if len(norm) >= 4:
                break
        if not norm:
            continue
        credits = list(w.get("imageCredits") or [])
        if w.get("imageCredit"):
            credits = [w["imageCredit"]] + [c for c in credits if c != w["imageCredit"]]
        while len(credits) < len(norm):
            credits.append(credits[-1] if credits else "Wikimedia Commons")
        credits = credits[: len(norm)]
        w["imageUrl"] = norm[0]
        w["thumbUrl"] = norm[0]
        w["imageUrls"] = norm
        w["imageCredit"] = credits[0]
        w["imageCredits"] = credits
    DATA.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    print(f"normalized {len(data)} words → {DATA}")

if __name__ == "__main__":
    main()
