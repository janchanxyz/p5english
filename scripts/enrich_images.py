#!/usr/bin/env python3
"""Enrich words-data.json with CUTE CARTOON / clipart / illustration images.

Rejects geographic/electoral/census maps and common proper-name false friends
(e.g. Cook County for "cook"). Prefers clipart, SVG icons, and cute cartoons.
By default re-fetches missing images and any current image that looks map-like.
"""
from __future__ import annotations

import argparse
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
PROJECT = ROOT.name  # p2english / p3english / …
UA = {
    "User-Agent": f"{PROJECT}-build/1.1 (educational spelling game; +https://{PROJECT}.chanplanet.workers.dev)",
    "Accept": "application/json",
}
ctx = ssl.create_default_context()
MAX_SECONDS = 7200
WORKERS = 8
MIN_ACCEPT_SCORE = 35

PHOTO_HINT = re.compile(
    r"(photo|photograph|geograph|dsc_|img_|camera|portrait of)",
    re.I,
)
CARTOON_HINT = re.compile(
    r"(cartoon|clip ?art|clipart|illustration|drawing|svg|vector|icon|sticker|"
    r"comic|kawaii|cute|emoji|pictogram|silhouette|simple|outline|doodle|"
    r"openclipart|flat design|game-icons|noun project|twemoji|noto emoji)",
    re.I,
)

# Geographic / cartographic / electoral maps — hard reject
MAP_HINT = re.compile(
    r"(?i)(?:"
    r"(?:^|[^a-z0-9])(?:"
    r"maps?|locator|cartograph(?:y|ic)?|openstreetmap|\bosm\b|"
    r"choropleth|topograph(?:y|ic)?|planisphere|roadmap|subway[\s_-]?map|"
    r"coverage[\s_-]?map|location[\s_-]?map|relief[\s_-]?map|"
    r"boundary[\s_-]?map|administrative[\s_-]?map|election[\s_-]?map|"
    r"electoral|census[\s_-]?map|results[\s_-]?map|floor[\s_-]?map|"
    r"floor[\s_-]?plan|precinct|constituency|ward[\s_-]?map|"
    r"district[\s_-]?map|county[\s_-]?map|city[\s_-]?map|world[\s_-]?map|"
    r"street[\s_-]?map|route[\s_-]?map|transit[\s_-]?map"
    r")(?:[^a-z0-9]|$)"
    r"|Incorporated_and_Unincorporated|areas_.*?_Highlighted|"
    r"MapOf|Walk_District|based on map|Original map|base map|"
    r"_County(?:_|\.|%|$)|County_(?:Illinois|Idaho|Michigan|State)|"
    r"election_results|demographic_map|Blaenau_Gwent|"
    r"Senate_election|House_of_Representatives_elections|"
    r"forecast_region|neighbour_states|Ocean_Currents"
    r")"
)

# Soft-penalize OSM map-marker icons (better than maps, worse than real clipart)
PINHEAD_HINT = re.compile(r"(?i)pinhead|OSM Carto|Temaki contributors")

# Words where a literal map/atlas image is acceptable
MAP_WORDS = {"map", "maps", "atlas", "globe"}


def fetch_json(url: str, retries: int = 3):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, context=ctx, timeout=20) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            last = e
            time.sleep(0.5 * (i + 1))
    raise RuntimeError(str(last))


def strip_html(s: str) -> str:
    return re.sub(r"<[^>]+>", "", s or "")[:120]


def is_map_word(word: str) -> bool:
    return (word or "").lower().strip() in MAP_WORDS


def looks_map_like(title: str = "", credit: str = "", url: str = "", word: str = "") -> bool:
    """True if this candidate is a geographic/electoral map (bad for most words)."""
    if is_map_word(word):
        return False
    blob = f"{title} {credit} {url}"
    return bool(MAP_HINT.search(blob))


def item_looks_map_like(item: dict) -> bool:
    word = item.get("word") or ""
    blob_parts = [
        item.get("imageUrl") or "",
        item.get("thumbUrl") or "",
        item.get("imageCredit") or "",
        " ".join(item.get("imageUrls") or []),
        " ".join(item.get("imageCredits") or []),
    ]
    return looks_map_like(title="", credit=" ".join(blob_parts), url=" ".join(blob_parts), word=word)


def score_image(title: str, mime: str, credit: str, url: str, word: str = "") -> int:
    blob = f"{title} {credit} {url} {mime}"
    score = 0
    w = (word or "").lower().strip()
    title_l = (title or "").lower()

    # Hard reject maps for non-map words
    if looks_map_like(title, credit, url, word):
        return -1000
    # Hard reject unsafe / inappropriate titles for a kids spelling game
    if re.search(r"(?i)\b(?:slave|slavery|nude|naked|nsfw|porn|corpse|kill|murder|guillotine)\b", f"{title} {credit}"):
        return -1000

    if w:
        # Title is clearly a proper-name place/person using the word as a toponym
        # e.g. "Cook County", "Baker County", "Eagle, Idaho", "Cherry Highlighted"
        if re.search(
            rf"(?i)(?:^|[^a-z]){re.escape(w)}[\s_-]+(?:county|parish|district|township|city|borough|village)\b",
            title_l,
        ):
            return -1000
        if re.search(
            rf"(?i)\b(?:county|parish|district|election|census|precinct).{{0,40}}{re.escape(w)}\b",
            title_l,
        ) and not CARTOON_HINT.search(blob):
            return -900

        if re.search(rf"(^|[^a-z]){re.escape(w)}([^a-z]|$)", title_l):
            score += 50
        elif w in title_l:
            score += 20
        else:
            # Unrelated hit (e.g. random Openclipart) — almost always reject
            score -= 90
        # Scientific / diagram false friends (Baker-Nathan effect, etc.)
        if re.search(r"(?i)\b(?:effect|equation|diagram|graph|chart|histogram|schema)\b", title_l):
            score -= 40
        if re.search(r"(?i)\b(?:logo|emblem|flag|coat of arms|arms of|seal of|signature|diocese)\b", title_l) and w not in ("flag", "logo", "seal", "signature"):
            score -= 80
        if re.search(r"(?i)\b(?:umlagerung|rearrangement|venkataraman|molecule|chemical|reaction mechanism)\b", title_l):
            score -= 100


    # Soft synonym hits (chef≈cook) so related illustrations can win
    synonyms = {
        "cook": ["chef", "cooking", "kitchen"],
        "baker": ["chef", "pastry", "bread", "baguette"],
        "aunt": ["woman", "lady", "family"],
        "walk": ["walking", "pedestrian", "hiker"],
        "neighbour": ["neighbor", "neighbors", "neighbours"],
        "neighbor": ["neighbour", "neighbors"],
    }
    for syn in synonyms.get(w, []):
        if re.search(rf"(^|[^a-z]){re.escape(syn)}([^a-z]|$)", title_l):
            score += 35
            break

    # Exact File:Word.svg / File:Word.png is usually the clean pictogram
    if w and re.search(rf"(?i)^File:{re.escape(w)}\.(svg|png)$", (title or "").strip()):
        score += 30

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
    if PINHEAD_HINT.search(blob):
        # Usable object icon, but prefer real clipart/illustrations
        score -= 15
    if "openclipart" in blob.lower() or "noun project" in blob.lower():
        score += 15
    if "wikimedia.org" in url:
        score += 8
    # Prefer filenames that start with the word (File:Word_…)
    if w and re.search(rf"(?i)(?:/|^)(?:\d+px-)?{re.escape(w)}[_\\.\\-]", url):
        score += 10
    return score


def commons_query(gsrsearch: str, limit: int = 10, word: str = ""):
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
        if sc <= -500:
            continue  # hard reject
        out.append({"url": full, "thumb": thumb or full, "credit": credit, "title": title, "score": sc})
    return out


def commons_search(word: str, theme: str):
    # Commons search: exclude map-ish terms; prefer drawings/SVG/clipart
    excl = "-map -locator -cartography -election -census -county -choropleth -topographic"
    queries = [
        f'filetype:svg "{word}" {excl}',
        f'filetype:drawing OR filetype:svg "{word}" (cartoon OR clipart OR illustration OR pictogram OR icon) {excl}',
        f'filetype:drawing OR filetype:svg {word} cartoon OR clipart OR illustration OR pictogram {excl}',
        f'File:{word}.svg OR File:{word}.png {excl}',
        f'filetype:bitmap {word} cartoon OR clipart OR openclipart {excl}',
        f'{word} pictogram OR "game-icons" OR openclipart {excl}',
    ]
    # Occupation / action synonyms help when Commons is flooded with surnames
    extra = {
        "cook": "chef OR cooking",
        "baker": "pastry OR bread OR baguette OR chef",
        "aunt": "family OR woman illustration",
        "walk": "walking OR pedestrian",
        "neighbour": "neighbor OR neighbours",
    }
    if word.lower() in extra:
        queries.insert(2, f'filetype:drawing OR filetype:svg ({word} OR {extra[word.lower()]}) cartoon OR clipart OR icon {excl}')
    if theme:
        queries.insert(2, f'filetype:drawing OR filetype:svg "{word}" {theme} illustration {excl}')
    seen = set()
    collected = []
    for q in queries:
        try:
            batch = commons_query(q, limit=10, word=word)
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
        time.sleep(0.06)
    collected.sort(key=lambda x: x["score"], reverse=True)
    strong = [x for x in collected if x["score"] >= MIN_ACCEPT_SCORE]
    return (strong or collected)[:8]


def openverse_search(word: str):
    queries = [
        {"q": f"{word} cartoon clipart", "category": "illustration"},
        {"q": f"{word} cute illustration icon", "category": "illustration"},
        {"q": f"{word} pictogram svg clipart", "category": "illustration"},
    ]
    if word.lower() == "cook":
        queries.insert(0, {"q": "chef cooking cartoon clipart", "category": "illustration"})
    if word.lower() == "baker":
        queries.insert(0, {"q": "baker bread pastry cartoon", "category": "illustration"})
    out = []
    seen = set()
    for qp in queries:
        params = urllib.parse.urlencode({
            "q": qp["q"],
            "license_type": "commercial,modification",
            "category": qp["category"],
            "page_size": 8,
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
            if sc <= -500:
                continue
            seen.add(u)
            out.append({"url": u, "thumb": thumb, "credit": credit[:160], "title": title, "score": sc})
        if len([x for x in out if x["score"] >= 45]) >= 3:
            break
        time.sleep(0.1)
    out.sort(key=lambda x: x["score"], reverse=True)
    strong = [x for x in out if x["score"] >= MIN_ACCEPT_SCORE]
    return (strong or out)[:8]


def looks_cartoon(item: dict) -> bool:
    blob = " ".join(
        [
            item.get("imageUrl") or "",
            " ".join(item.get("imageUrls") or []),
            item.get("imageCredit") or "",
        ]
    ).lower()
    return bool(CARTOON_HINT.search(blob)) or ".svg" in blob


def needs_refresh(item: dict, force_bad: bool) -> bool:
    if not item.get("imageUrl"):
        return True
    if force_bad and item_looks_map_like(item):
        return True
    return False


def enrich_one(item: dict, force_bad: bool = True):
    word = item.get("word") or ""
    theme = item.get("theme") or ""

    if not needs_refresh(item, force_bad):
        # Keep existing good (non-map) cartoon images
        if item.get("imageUrl") and looks_cartoon(item) and not item_looks_map_like(item):
            return item, "skip"
        if item.get("imageUrl") and not item_looks_map_like(item):
            return item, "skip"

    old = dict(item)
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

    # Drop any residual map-like results
    imgs = [im for im in imgs if not looks_map_like(im.get("title", ""), im.get("credit", ""), im.get("url", ""), word)]

    if not imgs or imgs[0].get("score", 0) < MIN_ACCEPT_SCORE:
        # Prefer clearing a map over keeping it; keep a non-map old image if we found nothing better
        if item_looks_map_like(old):
            cleared = dict(old)
            for k in ("imageUrl", "thumbUrl", "imageCredit"):
                cleared[k] = ""
            cleared["imageUrls"] = []
            cleared["imageCredits"] = []
            return cleared, "cleared-map"
        return old, "miss" if not old.get("imageUrl") else "skip"

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
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--force-bad",
        dest="force_bad",
        action="store_true",
        default=True,
        help="Re-fetch when current image looks map-like (default: on)",
    )
    ap.add_argument(
        "--no-force-bad",
        dest="force_bad",
        action="store_false",
        help="Only fill missing images; leave existing (even maps) alone",
    )
    ap.add_argument("--workers", type=int, default=WORKERS)
    ap.add_argument("--max-seconds", type=int, default=MAX_SECONDS)
    args = ap.parse_args()

    items = json.loads(DATA.read_text(encoding="utf-8"))
    # Prefer missing + map-like first so time budget covers the worst cases
    def priority(i: int) -> int:
        it = items[i]
        if not it.get("imageUrl"):
            return 2
        if args.force_bad and item_looks_map_like(it):
            return 1
        return 0

    order = sorted(range(len(items)), key=priority, reverse=True)
    t0 = time.time()
    results = [None] * len(items)
    ok = miss = skip = cleared = 0

    def flush():
        out = [results[i] if results[i] is not None else items[i] for i in range(len(items))]
        DATA.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(enrich_one, items[i], args.force_bad): i for i in order}
        for fut in as_completed(futs):
            if time.time() - t0 > args.max_seconds:
                print("hit max-seconds budget; flushing partial…", flush=True)
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
            elif status == "cleared-map":
                cleared += 1
            else:
                skip += 1
            done = ok + miss + skip + cleared
            if done % 25 == 0:
                flush()
                print(
                    f"… {done}/{len(items)} ok={ok} miss={miss} skip={skip} cleared={cleared} "
                    f"elapsed={time.time()-t0:.0f}s",
                    flush=True,
                )
    for i, r in enumerate(results):
        if r is None:
            results[i] = items[i]
    flush()
    with_img = sum(1 for x in results if x.get("imageUrl"))
    cart = sum(1 for x in results if looks_cartoon(x))
    maps_left = sum(1 for x in results if item_looks_map_like(x))
    print(
        f"Done. with_image={with_img}/{len(results)} cartoonish={cart} maps_left={maps_left} "
        f"ok={ok} miss={miss} skip={skip} cleared={cleared} elapsed={time.time()-t0:.1f}s"
    )
    for x in results[:5]:
        print(" sample:", x["word"], (x.get("imageUrl") or "")[:90])


if __name__ == "__main__":
    main()
