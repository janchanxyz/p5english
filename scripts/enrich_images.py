#!/usr/bin/env python3
"""Enrich words-data.json with CUTE CARTOON / clipart / illustration images."""
from __future__ import annotations

import json
import re
import ssl
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "src" / "words-data.json"
UA = {
    "User-Agent": "p5english-build/1.0 (educational spelling game; +https://p5english.chanplanet.workers.dev)",
    "Accept": "application/json",
}
ctx = ssl.create_default_context()
MAX_SECONDS = 1200
WORKERS = 10

PHOTO_HINT = re.compile(
    r"(photo|photograph|geograph|dsc_|img_|camera|portrait of)",
    re.I,
)
CARTOON_HINT = re.compile(
    r"(cartoon|clip ?art|clipart|illustration|drawing|svg|vector|icon|sticker|"
    r"comic|kawaii|cute|emoji|pictogram|silhouette|simple|outline|doodle|"
    r"openclipart|flat design|game-icons)",
    re.I,
)


def fetch_json(url: str, retries: int = 3):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, context=ctx, timeout=20) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            last = e
            time.sleep(0.4 * (i + 1))
    raise RuntimeError(str(last))


def strip_html(s: str) -> str:
    return re.sub(r"<[^>]+>", "", s or "")[:120]


def score_image(title: str, mime: str, credit: str, url: str, word: str = "") -> int:
    blob = f"{title} {credit} {url} {mime}"
    score = 0
    w = (word or "").lower().strip()
    title_l = (title or "").lower()
    if w:
        if re.search(rf"(^|[^a-z]){re.escape(w)}([^a-z]|$)", title_l):
            score += 50
        elif w in title_l:
            score += 20
        else:
            score -= 40
    if CARTOON_HINT.search(blob):
        score += 40
    if "svg" in (mime or "").lower() or ".svg" in url.lower():
        score += 35
    if re.search(r"\.(png)(/|$|\?)", url, re.I) and CARTOON_HINT.search(blob):
        score += 10
    if PHOTO_HINT.search(blob) and not CARTOON_HINT.search(blob):
        score -= 25
    if re.search(r"\.(jpe?g)(/|$|\?)", url, re.I) and not CARTOON_HINT.search(blob):
        score -= 15
    if "wikimedia.org" in url:
        score += 8
    return score


def commons_query(gsrsearch: str, limit: int = 8, word: str = ""):
    params = urllib.parse.urlencode({
        "action": "query",
        "format": "json",
        "generator": "search",
        "gsrsearch": gsrsearch,
        "gsrlimit": limit,
        "gsrnamespace": 6,
        "prop": "imageinfo",
        "iiprop": "url|extmetadata|mime|size",
        "iiurlwidth": 640,
    })
    url = f"https://commons.wikimedia.org/w/api.php?{params}"
    data = fetch_json(url)
    pages = (data.get("query") or {}).get("pages") or {}
    out = []
    for page in pages.values():
        title = page.get("title") or ""
        infos = page.get("imageinfo") or []
        if not infos:
            continue
        info = infos[0]
        mime = (info.get("mime") or "").lower()
        if not mime.startswith("image/"):
            continue
        if "djvu" in mime or "pdf" in mime or "tiff" in mime:
            continue
        thumb = info.get("thumburl") or info.get("url") or ""
        full = thumb or info.get("url") or ""
        if not full:
            continue
        if "svg" in mime and info.get("thumburl"):
            full = info["thumburl"]
            thumb = info["thumburl"]
        meta = info.get("extmetadata") or {}
        artist = ""
        lic = ""
        if isinstance(meta.get("Artist"), dict):
            artist = strip_html(meta["Artist"].get("value") or "")[:80]
        if isinstance(meta.get("LicenseShortName"), dict):
            lic = meta["LicenseShortName"].get("value") or ""
        credit = f"{artist} · {lic}".strip(" ·") if (artist or lic) else "Wikimedia Commons"
        sc = score_image(title, mime, credit, full, word=word)
        out.append({"url": full, "thumb": thumb or full, "credit": credit, "title": title, "score": sc})
    return out


def commons_search(word: str, theme: str):
    queries = [
        f"filetype:drawing OR filetype:svg {word} cartoon OR clipart OR illustration",
        f"filetype:drawing OR filetype:svg {word}",
        f"filetype:bitmap {word} cartoon OR clipart",
    ]
    seen = set()
    collected = []
    for q in queries:
        try:
            batch = commons_query(q, limit=8, word=word)
        except Exception:
            batch = []
        for im in batch:
            if im["url"] in seen:
                continue
            seen.add(im["url"])
            collected.append(im)
        strong = [x for x in collected if x["score"] >= 60]
        if len(strong) >= 3:
            break
        time.sleep(0.05)
    collected.sort(key=lambda x: x["score"], reverse=True)
    strong = [x for x in collected if x["score"] >= 45]
    return (strong or collected)[:5]


def openverse_search(word: str):
    queries = [
        {"q": f"{word} cartoon clipart", "category": "illustration"},
        {"q": f"{word} cute illustration", "category": "illustration"},
    ]
    out = []
    seen = set()
    for qp in queries:
        params = urllib.parse.urlencode({
            "q": qp["q"],
            "license_type": "commercial,modification",
            "category": qp["category"],
            "page_size": 6,
            "format": "json",
        })
        url = f"https://api.openverse.org/v1/images/?{params}"
        try:
            data = fetch_json(url)
        except Exception:
            continue
        for r in data.get("results") or []:
            u = r.get("url") or r.get("thumbnail") or ""
            if not u or u in seen:
                continue
            thumb = r.get("thumbnail") or u
            title = r.get("title") or ""
            credit = f"{r.get('creator') or 'Openverse'} · {r.get('license') or 'CC'}"
            sc = score_image(title, "", credit, u, word=word)
            seen.add(u)
            out.append({"url": u, "thumb": thumb, "credit": credit[:160], "title": title, "score": sc})
        if len([x for x in out if x["score"] >= 45]) >= 3:
            break
        time.sleep(0.08)
    out.sort(key=lambda x: x["score"], reverse=True)
    strong = [x for x in out if x["score"] >= 25]
    return (strong or out)[:5]


def looks_cartoon(item: dict) -> bool:
    blob = " ".join(
        [
            item.get("imageUrl") or "",
            " ".join(item.get("imageUrls") or []),
            item.get("imageCredit") or "",
        ]
    ).lower()
    return bool(CARTOON_HINT.search(blob)) or ".svg" in blob


def enrich_one(item: dict):
    word = item.get("word") or ""
    theme = item.get("theme") or ""
    if item.get("imageUrl") and looks_cartoon(item):
        return item, "skip"
    imgs = []
    try:
        imgs = commons_search(word, theme)
    except Exception:
        imgs = []
    need_ov = (not imgs) or (imgs and imgs[0].get("score", 0) < 45)
    if need_ov:
        try:
            ov = openverse_search(word)
        except Exception:
            ov = []
        by_url = {im["url"]: im for im in imgs}
        for im in ov:
            prev = by_url.get(im["url"])
            if not prev or im["score"] > prev["score"]:
                by_url[im["url"]] = im
        imgs = sorted(by_url.values(), key=lambda x: x["score"], reverse=True)
    if not imgs:
        return item, "miss"

    def rank(im):
        return im.get("score", 0) + (5 if "wikimedia.org" in im["url"] else 0)

    imgs = sorted(imgs, key=rank, reverse=True)
    urls, credits = [], []
    for im in imgs:
        if im["url"] not in urls:
            urls.append(im["url"])
            credits.append(im.get("credit") or "")
        if len(urls) >= 3:
            break
    item = dict(item)
    item["imageUrl"] = urls[0]
    item["imageCredit"] = credits[0] if credits else ""
    item["imageUrls"] = urls
    item["imageCredits"] = credits
    item["thumbUrl"] = imgs[0].get("thumb") or urls[0]
    return item, "ok"


def main():
    items = json.loads(DATA.read_text(encoding="utf-8"))
    # missing-first so new P5 words get images before time budget ends
    order = sorted(range(len(items)), key=lambda i: 0 if items[i].get("imageUrl") else 1, reverse=True)
    t0 = time.time()
    results = [None] * len(items)
    ok = miss = skip = 0

    def flush():
        out = [results[i] if results[i] is not None else items[i] for i in range(len(items))]
        DATA.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(enrich_one, items[i]): i for i in order}
        for fut in as_completed(futs):
            if time.time() - t0 > MAX_SECONDS:
                break
            i = futs[fut]
            try:
                item, status = fut.result()
            except Exception:
                item, status = items[i], "miss"
            results[i] = item
            if status == "ok":
                ok += 1
            elif status == "miss":
                miss += 1
            else:
                skip += 1
            done = ok + miss + skip
            if done % 25 == 0:
                flush()
                print(f"… {done}/{len(items)} ok={ok} miss={miss} skip={skip} elapsed={time.time()-t0:.0f}s", flush=True)
    for i, r in enumerate(results):
        if r is None:
            results[i] = items[i]
            miss += 1
    flush()
    with_img = sum(1 for x in results if x.get("imageUrl"))
    cart = sum(1 for x in results if looks_cartoon(x))
    print(f"Done. with_image={with_img}/{len(results)} cartoonish={cart} ok={ok} miss={miss} skip={skip} elapsed={time.time()-t0:.1f}s")
    for x in results[:5]:
        print(" sample:", x["word"], (x.get("imageUrl") or "")[:90])


if __name__ == "__main__":
    main()
