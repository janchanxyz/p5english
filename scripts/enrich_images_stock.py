#!/usr/bin/env python3
"""Enrich words-data.json with Unsplash photos using example-sentence context.

API key is loaded from repo .env or /home/box/.config/image-apis/unsplash.env.
Never prints the key. Shared cache + checkpoint under /workspace/.cache/unsplash/.
Demo apps: 50 requests/hour — serialize and sleep when remaining is low.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

CACHE_DIR = Path("/workspace/.cache/unsplash")
CACHE_FILE = CACHE_DIR / "query-cache.json"
CHECKPOINT_FILE = CACHE_DIR / "checkpoint.json"
ENV_FALLBACK = Path("/home/box/.config/image-apis/unsplash.env")

UA = "chanplanet-spelling-enrich/1.0 (educational; contact via workers.dev)"
STOPWORDS = {
    "a", "an", "the", "and", "or", "but", "if", "then", "so", "as", "at", "by",
    "for", "from", "in", "into", "of", "on", "onto", "to", "with", "without",
    "is", "am", "are", "was", "were", "be", "been", "being", "do", "does", "did",
    "have", "has", "had", "will", "would", "can", "could", "may", "might", "must",
    "shall", "should", "i", "you", "he", "she", "it", "we", "they", "me", "him",
    "her", "us", "them", "my", "your", "his", "its", "our", "their", "this",
    "that", "these", "those", "there", "here", "very", "too", "also", "just",
    "not", "no", "yes", "please", "like", "love", "want", "go", "goes", "went",
    "going", "get", "got", "make", "made", "see", "saw", "look", "looks", "looking",
    "play", "plays", "playing", "said", "say", "says", "about", "after", "before",
    "over", "under", "again", "once", "every", "each", "some", "any", "all", "many",
    "much", "more", "most", "other", "when", "where", "why", "how", "what", "who",
    "which", "while", "during", "than", "then", "up", "down", "out", "off", "away",
}

# Ambiguous primary-school words → preferred Unsplash sense hints (kids-safe).
SENSE_HINTS = {
    "mouse": "animal rodent",
    "mice": "animal rodent",
    "bat": "animal flying",
    "bank": "building finance",
    "jam": "fruit food jar",
    "cook": "cooking kitchen chef",
    "spring": "season nature blossoms",
    "fall": "autumn season leaves",
    "park": "park outdoor nature",
    "watch": "wristwatch timepiece",
    "letter": "alphabet writing",
    "nail": "fingernail hand",
    "bark": "dog animal",
    "wave": "ocean sea water",
    "rock": "stone nature",
    "plant": "plant green nature",
    "light": "lamp light bulb",
    "match": "matchstick fire",
    "fan": "electric fan cooling",
    "pupil": "student school child",
    "ruler": "school stationery measuring",
    "scale": "weighing scale",
    "note": "music notebook",
    "chip": "potato chip snack",
    "toast": "bread breakfast",
    "orange": "fruit citrus",
    "date": "calendar day",
    "tie": "necktie clothing",
    "bow": "ribbon gift",
    "cold": "weather winter",
    "hot": "temperature warm",
    "left": "direction left side",
    "right": "direction right side",
    "present": "gift wrapped",
    "box": "cardboard box",
    "trunk": "tree trunk",
    "crane": "bird animal",
    "seal": "animal marine",
    "turkey": "bird animal",
    "china": "porcelain dish",
    "turkey": "bird thanksgiving",
    "arm": "human arm body",
    "foot": "human foot body",
    "hand": "human hand body",
    "head": "human head face",
    "back": "human back body",
    "palm": "hand palm",
    "kid": "child kid",
    "kidney": "organ anatomy",
    "organ": "musical organ",
    "pipe": "water pipe",
    "ball": "sports ball",
    "racket": "tennis badminton",
    "bat": "baseball bat sports",  # overridden below by example if animal context
}

# If example contains these tokens, override SENSE_HINTS for that word
EXAMPLE_OVERRIDES = {
    "mouse": [
        (re.compile(r"\b(computer|click|cursor|screen)\b", re.I), "computer mouse"),
        (re.compile(r"\b(small|hole|cheese|cat|animal|tiny)\b", re.I), "mouse animal rodent"),
    ],
    "bat": [
        (re.compile(r"\b(baseball|cricket|hits?|swing|sports?|ball)\b", re.I), "baseball bat sports"),
        (re.compile(r"\b(fly|night|cave|wing|animal)\b", re.I), "bat animal flying"),
    ],
    "bank": [
        (re.compile(r"\b(river|stream|shore|water)\b", re.I), "river bank nature"),
        (re.compile(r"\b(money|friday|go to|save|cash|atm)\b", re.I), "bank building finance"),
    ],
    "jam": [
        (re.compile(r"\b(traffic|car|road|stuck)\b", re.I), "traffic jam cars"),
        (re.compile(r"\b(bread|toast|fruit|sweet|jar|eat)\b", re.I), "fruit jam jar food"),
    ],
    "spring": [
        (re.compile(r"\b(season|blossom|flower|outside|warm|march|april|cherry)\b", re.I), "spring season nature blossoms"),
        (re.compile(r"\b(coil|metal|bounce|mattress)\b", re.I), "metal spring coil"),
        (re.compile(r"\b(water|fountain)\b", re.I), "water spring nature"),
    ],
    "cook": [
        (re.compile(r"\b(dinner|kitchen|food|meal|chef|mom|dad)\b", re.I), "cooking kitchen chef"),
        (re.compile(r"\b(county|island|captain)\b", re.I), "cooking kitchen"),
    ],
    "watch": [
        (re.compile(r"\b(tv|movie|see|look)\b", re.I), "watching television"),
        (re.compile(r"\b(time|wrist|wear|clock)\b", re.I), "wristwatch timepiece"),
    ],
    "park": [
        (re.compile(r"\b(car|parking)\b", re.I), "parking car"),
        (re.compile(r"\b(play|tree|grass|walk|picnic)\b", re.I), "park outdoor nature"),
    ],
}

MAP_HINT = re.compile(
    r"(?i)(?:\bmaps?\b|locator|cartograph|choropleth|topograph|electoral|census[\s_-]?map|"
    r"floor[\s_-]?plan|openstreetmap|\bosm\b|world[\s_-]?map|street[\s_-]?map)"
)

UNSAFE = re.compile(
    r"(?i)\b(?:nude|naked|nsfw|porn|sex|slave|corpse|kill|murder|blood|gun|weapon|cigarette|drug)\b"
)

ctx = ssl.create_default_context()


def load_key() -> str:
    # Prefer process env, then cwd .env, then shared file. Never log value.
    k = os.environ.get("UNSPLASH_ACCESS_KEY", "").strip()
    if k:
        return k
    for p in (Path(".env"), ENV_FALLBACK):
        if p.is_file():
            for line in p.read_text().splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                name, val = line.split("=", 1)
                if name.strip() == "UNSPLASH_ACCESS_KEY":
                    return val.strip().strip('"').strip("'")
    raise SystemExit("UNSPLASH_ACCESS_KEY not found in env or .env")


def load_json(path: Path, default):
    if path.is_file():
        try:
            return json.loads(path.read_text())
        except Exception:
            return default
    return default


def save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    tmp.replace(path)


def tokenize(text: str) -> list[str]:
    return re.findall(r"[A-Za-z']+", text or "")


def build_query(word: str, example: str = "", theme: str = "", pos: str = "") -> str:
    """Build a stable Unsplash query.

    Ambiguous words use example-driven overrides or fixed sense hints so
    "mouse" → animal not computer. Unambiguous words use the word alone so
    the same lemma shares one cached API search across all four games.
    """
    w = (word or "").strip().lower()
    ex = (example or "").strip()

    for pat, hint in EXAMPLE_OVERRIDES.get(w, []):
        if pat.search(ex):
            return hint

    hint = SENSE_HINTS.get(w)
    if hint:
        # Avoid duplicating the word when hint already starts with it
        parts = []
        for p in ([w] + hint.split()):
            if p and p not in parts:
                parts.append(p)
        return " ".join(parts[:6])

    return w


def pick_urls(photo: dict) -> tuple[str, str]:
    urls = photo.get("urls") or {}
    # regular ~1080px; small ~400px — good for kids game cards
    image = urls.get("regular") or urls.get("small") or urls.get("thumb") or ""
    thumb = urls.get("small") or urls.get("thumb") or image
    # Prefer w=800 style if present as query param already from API
    return image, thumb


def credit_for(photo: dict) -> str:
    user = photo.get("user") or {}
    name = user.get("name") or user.get("username") or "Unknown"
    username = user.get("username") or ""
    link = ""
    links = user.get("links") or {}
    if isinstance(links, dict) and links.get("html"):
        link = links["html"]
    elif username:
        link = f"https://unsplash.com/@{username}"
    if link:
        # Keep credit plain-text for UI; include photographer + Unsplash
        return f"Photo by {name} on Unsplash ({link}?utm_source=chanplanet&utm_medium=referral)"
    return f"Photo by {name} on Unsplash"


def score_photo(photo: dict, word: str, query: str) -> int:
    desc = " ".join(
        filter(
            None,
            [
                photo.get("description") or "",
                photo.get("alt_description") or "",
                " ".join(photo.get("tags") or []) if isinstance(photo.get("tags"), list) else "",
            ],
        )
    )
    blob = desc
    if UNSAFE.search(blob):
        return -1000
    if MAP_HINT.search(blob) and word.lower() not in {"map", "maps", "atlas", "globe"}:
        return -800
    score = 10
    w = word.lower()
    bl = blob.lower()
    if w and re.search(rf"(^|[^a-z]){re.escape(w)}([^a-z]|$)", bl):
        score += 40
    for tok in query.lower().split():
        if tok != w and tok in bl:
            score += 8
    # Prefer landscape-ish / higher likes lightly
    score += min(int(photo.get("likes") or 0) // 50, 15)
    # Reject very narrow weird crops if width/height extreme
    wdt = photo.get("width") or 0
    hgt = photo.get("height") or 0
    if wdt and hgt:
        ratio = wdt / max(hgt, 1)
        if ratio < 0.4 or ratio > 3.5:
            score -= 10
    return score


class RateLimiter:
    def __init__(self, max_per_hour: int = 45, reserve: int = 3):
        self.max_per_hour = max_per_hour
        self.reserve = reserve
        self.remaining = max_per_hour
        self.reset_at = 0.0  # epoch seconds when limit resets (best-effort)
        self.last_call = 0.0

    def before_request(self) -> None:
        # Space calls evenly: 3600/45 ≈ 80s
        min_gap = 3600.0 / max(self.max_per_hour, 1)
        now = time.time()
        wait = self.last_call + min_gap - now
        if wait > 0:
            print(f"  rate-gap sleep {wait:.0f}s", flush=True)
            time.sleep(wait)
        if self.remaining is not None and self.remaining <= self.reserve:
            # Sleep until roughly next hour window
            sleep_for = max(60.0, (self.reset_at - time.time()) if self.reset_at else 3600.0)
            sleep_for = min(sleep_for, 3700.0)
            print(f"  rate-limit low (remaining={self.remaining}); sleeping {sleep_for:.0f}s", flush=True)
            time.sleep(sleep_for)
            self.remaining = self.max_per_hour

    def note_headers(self, headers) -> None:
        for name in ("X-Ratelimit-Remaining", "X-RateLimit-Remaining"):
            v = headers.get(name)
            if v is not None:
                try:
                    self.remaining = int(v)
                except ValueError:
                    pass
        for name in ("X-Ratelimit-Limit", "X-RateLimit-Limit"):
            v = headers.get(name)
            if v is not None:
                try:
                    self.max_per_hour = min(self.max_per_hour, int(v))
                except ValueError:
                    pass
        # Unsplash may not send Reset; approximate top of next hour if depleted
        if self.remaining is not None and self.remaining <= self.reserve:
            self.reset_at = time.time() + 3600.0


def unsplash_search(key: str, query: str, limiter: RateLimiter, per_page: int = 8) -> list[dict]:
    params = urllib.parse.urlencode(
        {
            "query": query,
            "per_page": str(per_page),
            "content_filter": "high",
            "orientation": "landscape",
        }
    )
    url = f"https://api.unsplash.com/search/photos?{params}"
    headers = {
        "Authorization": f"Client-ID {key}",
        "Accept-Version": "v1",
        "User-Agent": UA,
    }
    last_err = None
    for attempt in range(5):
        limiter.before_request()
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, context=ctx, timeout=45) as resp:
                limiter.last_call = time.time()
                limiter.note_headers(resp.headers)
                data = json.loads(resp.read().decode("utf-8"))
                return list(data.get("results") or [])
        except urllib.error.HTTPError as e:
            limiter.last_call = time.time()
            limiter.note_headers(e.headers or {})
            body = ""
            try:
                body = e.read().decode("utf-8", errors="replace")[:200]
            except Exception:
                pass
            last_err = e
            if e.code == 403 and "Rate Limit" in body or e.code == 429:
                print(f"  HTTP {e.code} rate limited; sleeping 3600s", flush=True)
                time.sleep(3600)
                limiter.remaining = limiter.max_per_hour
                continue
            if e.code in (500, 502, 503, 504):
                time.sleep(5 * (attempt + 1))
                continue
            print(f"  HTTP {e.code} for query={query!r}: {body}", flush=True)
            return []
        except Exception as e:
            last_err = e
            time.sleep(2 * (attempt + 1))
    print(f"  search failed for {query!r}: {last_err}", flush=True)
    return []


def select_best(photos: list[dict], word: str, query: str) -> dict | None:
    scored = []
    for p in photos:
        sc = score_photo(p, word, query)
        if sc <= -500:
            continue
        scored.append((sc, p))
    if not scored:
        return None
    scored.sort(key=lambda x: x[0], reverse=True)
    return scored[0][1]


def apply_photo(item: dict, photo: dict) -> None:
    image, thumb = pick_urls(photo)
    credit = credit_for(photo)
    # Optionally gather a couple alts from same search stored separately
    item["imageUrl"] = image
    item["thumbUrl"] = thumb
    item["imageCredit"] = credit
    item["imageUrls"] = [image] if image else []
    item["imageCredits"] = [credit] if credit else []


def clear_image(item: dict) -> None:
    item["imageUrl"] = ""
    item["thumbUrl"] = ""
    item["imageCredit"] = ""
    item["imageUrls"] = []
    item["imageCredits"] = []


def process_games(games: list[Path], replace_all: bool = True, max_searches: int | None = None) -> None:
    key = load_key()
    cache = load_json(CACHE_FILE, {})
    checkpoint = load_json(CHECKPOINT_FILE, {"done_keys": [], "stats": {}})
    done = set(checkpoint.get("done_keys") or [])
    limiter = RateLimiter(max_per_hour=48, reserve=2)
    searches = 0

    # Build work list: unique cache keys across all games
    # cache key = query string (normalized)
    work: list[tuple[str, str, str, str]] = []  # (cache_key, word, example, query)
    seen_q = set()
    for gpath in games:
        data = json.loads((gpath / "src" / "words-data.json").read_text())
        for item in data:
            word = (item.get("word") or "").strip()
            example = (item.get("example") or "").strip()
            theme = (item.get("theme") or "").strip()
            pos = (item.get("pos") or "").strip()
            query = build_query(word, example, theme, pos)
            ck = query.lower()
            if ck in seen_q:
                continue
            seen_q.add(ck)
            work.append((ck, word, example, query))

    print(f"Unique queries to resolve: {len(work)}; cached={sum(1 for k in seen_q if k in cache)}; done_ckpt={len(done)}", flush=True)

    for ck, word, example, query in work:
        if max_searches is not None and searches >= max_searches:
            print("Hit max_searches; stopping for now.", flush=True)
            break
        if ck in cache and cache[ck] is not None:
            # already have a result (including explicit null miss)
            if ck not in done:
                done.add(ck)
            continue
        if ck in done and ck in cache:
            continue

        print(f"SEARCH [{searches+1}] {word!r} ← {query!r} (ex={example[:60]!r})", flush=True)
        photos = unsplash_search(key, query, limiter)
        searches += 1
        best = select_best(photos, word, query)

        # Fallback: try just the word + sense hint once
        if not best:
            fallback = build_query(word, "", "", "")
            if fallback.lower() != query.lower():
                print(f"  fallback SEARCH {fallback!r}", flush=True)
                photos = unsplash_search(key, fallback, limiter)
                searches += 1
                best = select_best(photos, word, fallback)

        if best:
            image, thumb = pick_urls(best)
            cache[ck] = {
                "query": query,
                "word": word,
                "imageUrl": image,
                "thumbUrl": thumb,
                "imageCredit": credit_for(best),
                "unsplashId": best.get("id"),
                "alt": best.get("alt_description") or best.get("description") or "",
            }
            print(f"  OK remaining≈{limiter.remaining} id={best.get('id')}", flush=True)
        else:
            cache[ck] = None
            print(f"  MISS remaining≈{limiter.remaining}", flush=True)

        done.add(ck)
        if searches % 1 == 0:
            save_json(CACHE_FILE, cache)
            checkpoint["done_keys"] = sorted(done)
            checkpoint["stats"] = {
                "searches_this_run": searches,
                "cache_hits": sum(1 for v in cache.values() if v),
                "cache_misses": sum(1 for v in cache.values() if v is None),
                "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            }
            save_json(CHECKPOINT_FILE, checkpoint)

    save_json(CACHE_FILE, cache)
    checkpoint["done_keys"] = sorted(done)
    save_json(CHECKPOINT_FILE, checkpoint)

    # Apply cache to each game's words-data.json
    for gpath in games:
        data_path = gpath / "src" / "words-data.json"
        data = json.loads(data_path.read_text())
        updated = missing = skipped = 0
        for item in data:
            word = (item.get("word") or "").strip()
            example = (item.get("example") or "").strip()
            theme = (item.get("theme") or "").strip()
            pos = (item.get("pos") or "").strip()
            query = build_query(word, example, theme, pos)
            ck = query.lower()
            if ck not in cache:
                skipped += 1
                continue
            hit = cache[ck]
            if hit is None:
                # Explicit Unsplash miss — leave blank rather than keep a wrong map
                clear_image(item)
                missing += 1
                continue
            if not hit or not hit.get("imageUrl"):
                missing += 1
                continue
            item["imageUrl"] = hit["imageUrl"]
            item["thumbUrl"] = hit.get("thumbUrl") or hit["imageUrl"]
            item["imageCredit"] = hit.get("imageCredit") or "Photo on Unsplash"
            item["imageUrls"] = [item["imageUrl"]]
            item["imageCredits"] = [item["imageCredit"]]
            updated += 1
        data_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
        print(f"Applied {gpath.name}: updated={updated} missing={missing} pending_skip={skipped}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--games", nargs="+", default=["p2english", "p3english", "p4english", "p5english"])
    ap.add_argument("--workspace", default="/workspace")
    ap.add_argument("--max-searches", type=int, default=None)
    ap.add_argument("--apply-only", action="store_true", help="Only apply existing cache to words-data.json")
    args = ap.parse_args()
    games = [Path(args.workspace) / g for g in args.games]
    for g in games:
        if not (g / "src" / "words-data.json").is_file():
            raise SystemExit(f"Missing words-data in {g}")
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    if args.apply_only:
        # Force apply path via empty search loop
        cache = load_json(CACHE_FILE, {})
        for gpath in games:
            data_path = gpath / "src" / "words-data.json"
            data = json.loads(data_path.read_text())
            updated = missing = 0
            for item in data:
                word = (item.get("word") or "").strip()
                example = (item.get("example") or "").strip()
                theme = (item.get("theme") or "").strip()
                pos = (item.get("pos") or "").strip()
                query = build_query(word, example, theme, pos)
                hit = cache.get(query.lower())
                if not hit or not hit.get("imageUrl"):
                    # Leave existing image until Unsplash result exists (avoid blanking mid-run)
                    missing += 1
                    continue
                item["imageUrl"] = hit["imageUrl"]
                item["thumbUrl"] = hit.get("thumbUrl") or hit["imageUrl"]
                item["imageCredit"] = hit.get("imageCredit") or "Photo on Unsplash"
                item["imageUrls"] = [item["imageUrl"]]
                item["imageCredits"] = [item["imageCredit"]]
                updated += 1
            data_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
            print(f"Applied {gpath.name}: updated={updated} missing={missing}", flush=True)
        return
    process_games(games, replace_all=True, max_searches=args.max_searches)


if __name__ == "__main__":
    main()
