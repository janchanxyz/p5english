# 小五英文拼字 · p5english

Cute, colourful **Primary 5 English spelling game** for Hong Kong kids — mobile & iPad friendly.

**Live:** https://p5english.chanplanet.workers.dev/

## Features

- **每日 10 個字** — same words for everyone on the same Hong Kong calendar day (`Asia/Hong_Kong`)
- Each word hides **2–5 letters**; fill the blanks with an on-screen keyboard
- **繁體中文（香港）** gloss for every item
- Illustrations from **Wikimedia Commons / Openverse** (CC-friendly), shown via same-origin `/api/img` proxy
- **Shareable PNG result card** (Web Share API + download / clipboard fallback), spoiler-free like bird/fish
- Progress saved in `localStorage` for the same day
- **8 hearts** — wrong answers cost a life; hearts gone ends the day’s remaining rounds

## Vocabulary source (EDB honesty)

Hong Kong’s Education Bureau does **not** publish a separate Primary 5–only English wordlist. Official indicative targets are about **1,000 words by end of KS1** and **2,000 by end of primary (KS2)**. The interactive Wordlists package (*Enhancing English Vocabulary Learning and Teaching at Primary Level*, formerly at `cd1.edb.hkedcity.net/cd/eng/vocab09`) is thematic/alphabetical and not a stable machine-readable download. The 2025 Primary English Language Curriculum Guide also advises introducing vocabulary **in context**, not via rote grade lists.

This app uses a **curated P5-appropriate pool** (~600 spelling words, length 5–14 letters) aligned with EDB KS2 / upper-primary themes from PEER modules and Open English P5 units — **Changes**, **Food and Drink**, **Relationships**, **The Magic of Nature**, **We Love Hong Kong**, **Happy Days**, plus environment, health, computers, festivals, and personality adjectives. Slightly harder / longer than the sibling P4 pool; prefer imageable items where possible. **Not an official EDB dump** — for classroom practice / home fun.

References:

- [EDB primary vocabulary resources](https://www.edb.gov.hk/en/curriculum-development/kla/eng-edu/references-resources/resource%20pri_vocab.html)
- [Enhancing English Vocabulary Learning and Teaching at Primary Level](https://www.edb.gov.hk/en/curriculum-development/kla/eng-edu/references-resources/Enhancing%20Eng%20Vocab%20at%20Pri%20Level.html)
- [Wordlists preamble](https://www.edb.gov.hk/en/curriculum-development/kla/eng-edu/references-resources/Wordlists_preamble.html)
- [PEER upper-primary e-learning modules (archive)](https://www.edb.gov.hk/en/curriculum-development/kla/eng-edu/references-resources/peer.html)
- [Primary English Language Curriculum Guide (2025) — vocabulary in context](https://www.edb.gov.hk/attachment/en/curriculum-development/kla/eng-edu/Curriculum%20Document/Pri_ELCG_Primary_1-6_2025.pdf)

## Develop

```bash
npm install
python3 scripts/build_words.py      # rebuild base src/words-data.json
python3 scripts/add_examples.py     # examples + zh + reuse P4 images on overlap
python3 scripts/enrich_images.py    # Wikimedia / Openverse images for remaining words
npm run dev
```

## Deploy (Cloudflare Workers)

```bash
npm run build
npx wrangler deploy
```

- Worker name: **`p5english`**
- Assets SPA from `dist/`
- Expected URL: **https://p5english.chanplanet.workers.dev/**

## Tech

Vite + vanilla JS, `wrangler.jsonc` SPA + `run_worker_first: ["/api/*"]`, Worker image proxy for canvas CORS.

### TTS (`/api/speak`)

Spoken words and example sentences are served as cached MP3s from the `TTS_CACHE` KV binding (R2 was not enabled on this account). Cache key: `sha256(v1|@cf/deepgram/aura-2-en|{speaker}|{normalized text})` → `tts/v1/{hash}.mp3`. On HIT the Worker returns audio with `X-TTS-Cache: HIT` and does **not** call Workers AI. On miss it may call Aura once and store (safety net). Prefill catalog:

```bash
python3 -m venv .venv && .venv/bin/pip install edge-tts
.venv/bin/python scripts/backfill_tts.py --speakers asteria
```

Daily seed key: `p5english-daily-YYYY-MM-DD`.
