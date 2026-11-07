/**
 * Cloudflare Worker: SPA assets + same-origin image proxy for canvas share cards.
 * GET /api/img?u=<encoded absolute http(s) URL>
 * GET|POST /api/speak  → 410 Gone (TTS is static Edge-TTS under /audio/)
 * POST /api/report-image  JSON { url, wordId?, word?, ... }
 * GET /api/reported-images  → { urls: string[] }
 * GET /api/img-ok?u=<url>  → { ok: boolean }  (ok=false if reported)
 *
 * Large Wikimedia originals are rewritten to ~500px Commons thumbs before proxying
 * so mobile clients never hit 413 on multi-MB JPEGs.
 */

const MAX_BYTES = 5 * 1024 * 1024;
const PREFER_THUMB_BYTES = 1.5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 12000;
const THUMB_WIDTH = 500; // Commons-allowed size (see https://w.wiki/GHai)

const BLOCKED_HOST_SUFFIXES = ['.local', '.internal', '.localhost'];

function isPrivateHostname(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.localhost')) return true;
  for (const s of BLOCKED_HOST_SUFFIXES) {
    if (h.endsWith(s)) return true;
  }
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = m.slice(1).map(Number);
    if (a.some((n) => n > 255)) return true;
    if (a[0] === 10) return true;
    if (a[0] === 127) return true;
    if (a[0] === 0) return true;
    if (a[0] === 169 && a[1] === 254) return true;
    if (a[0] === 172 && a[1] >= 16 && a[1] <= 31) return true;
    if (a[0] === 192 && a[1] === 168) return true;
  }
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('[fc') || h.startsWith('[fd')) {
    return true;
  }
  return false;
}

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    ...extra,
  };
}

function parseTargetUrl(raw) {
  let target;
  try {
    target = new URL(raw);
  } catch {
    return { error: new Response('Bad url', { status: 400, headers: corsHeaders() }) };
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return { error: new Response('Only http(s)', { status: 400, headers: corsHeaders() }) };
  }
  if (isPrivateHostname(target.hostname)) {
    return { error: new Response('Blocked host', { status: 403, headers: corsHeaders() }) };
  }
  return { target };
}

/** Rewrite Wikimedia Commons originals / oversized thumbs to a mobile-sized thumb. */
function commonsMobileThumb(absoluteUrl, width = THUMB_WIDTH) {
  if (!absoluteUrl) return '';
  let u;
  try {
    u = new URL(absoluteUrl);
  } catch {
    return '';
  }
  const host = u.hostname.toLowerCase();
  if (host !== 'upload.wikimedia.org' && host !== 'thumb.wikimedia.org') return '';
  // Drop tracking query
  u.search = '';
  u.hash = '';
  const path = u.pathname;

  const thumbMatch = path.match(
    /^\/wikipedia\/([^/]+)\/thumb\/([0-9a-f])\/([0-9a-f]{2})\/([^/]+)\/((?:lossy-page\d+-)?\d+px-.+)$/i,
  );
  if (thumbMatch) {
    const [, wiki, a, ab, fname, thumbfile] = thumbMatch;
    const resized = thumbfile.replace(/\d+px-/, `${width}px-`);
    return `https://upload.wikimedia.org/wikipedia/${wiki}/thumb/${a}/${ab}/${fname}/${resized}`;
  }

  const origMatch = path.match(
    /^\/wikipedia\/([^/]+)\/(?!thumb\/)([0-9a-f])\/([0-9a-f]{2})\/([^/]+)$/i,
  );
  if (origMatch) {
    const [, wiki, a, ab, fname] = origMatch;
    return `https://upload.wikimedia.org/wikipedia/${wiki}/thumb/${a}/${ab}/${fname}/${width}px-${fname}`;
  }
  return '';
}

async function fetchUpstream(targetUrl, signal) {
  return fetch(targetUrl, {
    method: 'GET',
    redirect: 'follow',
    signal,
    headers: {
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'User-Agent': 'p5english-chanplanet-proxy/1.0',
    },
    cf: {
      cacheTtl: 86400,
      cacheEverything: true,
    },
  });
}

async function proxyImage(request, url) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders() });
  }

  const raw = url.searchParams.get('u') || '';
  const parsed = parseTargetUrl(raw);
  if (parsed.error) return parsed.error;

  // Prefer mobile thumbs up-front for Commons URLs
  const preferred = commonsMobileThumb(parsed.target.toString()) || parsed.target.toString();
  let targetStr = preferred;

  const cache = caches.default;
  // Cache key uses the URL we actually fetch (after thumb rewrite)
  const cacheUrl = new URL(url.toString());
  cacheUrl.searchParams.set('u', targetStr);
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) {
    const hit = new Response(cached.body, cached);
    hit.headers.set('X-P5-Proxy-Cache', 'HIT');
    return hit;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetchUpstream(targetStr, ctrl.signal);

    // If preferred thumb failed and we rewrote, fall back to original once
    if (!upstream.ok && targetStr !== parsed.target.toString()) {
      targetStr = parsed.target.toString();
      upstream = await fetchUpstream(targetStr, ctrl.signal);
    }

    // If original is too large per Content-Length, try Commons thumb rewrite
    const lenHeader = upstream.ok ? Number(upstream.headers.get('content-length') || 0) : 0;
    if (upstream.ok && lenHeader > PREFER_THUMB_BYTES) {
      const thumb = commonsMobileThumb(targetStr);
      if (thumb && thumb !== targetStr) {
        const alt = await fetchUpstream(thumb, ctrl.signal);
        if (alt.ok) {
          upstream = alt;
          targetStr = thumb;
        }
      }
    }
  } catch {
    clearTimeout(timer);
    return new Response('Upstream fetch failed', { status: 502, headers: corsHeaders() });
  }
  clearTimeout(timer);

  if (!upstream.ok) {
    return new Response(`Upstream ${upstream.status}`, {
      status: 502,
      headers: corsHeaders(),
    });
  }

  const ctype = (upstream.headers.get('content-type') || '').toLowerCase();
  if (ctype && !ctype.startsWith('image/') && !ctype.includes('octet-stream')) {
    return new Response('Not an image', { status: 415, headers: corsHeaders() });
  }

  const lenHeader = upstream.headers.get('content-length');
  if (lenHeader && Number(lenHeader) > MAX_BYTES) {
    // Last chance: try Commons thumb before 413
    const thumb = commonsMobileThumb(parsed.target.toString());
    if (thumb && thumb !== targetStr) {
      try {
        const altCtrl = new AbortController();
        const altTimer = setTimeout(() => altCtrl.abort(), FETCH_TIMEOUT_MS);
        const alt = await fetchUpstream(thumb, altCtrl.signal);
        clearTimeout(altTimer);
        if (alt.ok) {
          const altLen = alt.headers.get('content-length');
          if (!altLen || Number(altLen) <= MAX_BYTES) {
            const altBuf = await alt.arrayBuffer();
            if (altBuf.byteLength <= MAX_BYTES) {
              const altType = (alt.headers.get('content-type') || '').toLowerCase();
              const outType = altType.startsWith('image/') ? altType.split(';')[0] : 'image/jpeg';
              const headers = corsHeaders({
                'Content-Type': outType,
                'Cache-Control': 'public, max-age=86400, s-maxage=604800',
                'X-P5-Proxy-Cache': 'MISS',
                'X-P5-Proxy-Thumb': '1',
              });
              const response = new Response(altBuf, { status: 200, headers });
              try {
                await cache.put(cacheKey, response.clone());
              } catch {
                /* ignore */
              }
              return response;
            }
          }
        }
      } catch {
        /* fall through to 413 */
      }
    }
    return new Response('Too large', { status: 413, headers: corsHeaders() });
  }

  const buf = await upstream.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) {
    const thumb = commonsMobileThumb(parsed.target.toString());
    if (thumb && thumb !== targetStr) {
      try {
        const altCtrl = new AbortController();
        const altTimer = setTimeout(() => altCtrl.abort(), FETCH_TIMEOUT_MS);
        const alt = await fetchUpstream(thumb, altCtrl.signal);
        clearTimeout(altTimer);
        if (alt.ok) {
          const altBuf = await alt.arrayBuffer();
          if (altBuf.byteLength <= MAX_BYTES) {
            const altType = (alt.headers.get('content-type') || '').toLowerCase();
            const outType = altType.startsWith('image/') ? altType.split(';')[0] : 'image/jpeg';
            const headers = corsHeaders({
              'Content-Type': outType,
              'Cache-Control': 'public, max-age=86400, s-maxage=604800',
              'X-P5-Proxy-Cache': 'MISS',
              'X-P5-Proxy-Thumb': '1',
            });
            const response = new Response(altBuf, { status: 200, headers });
            try {
              await cache.put(cacheKey, response.clone());
            } catch {
              /* ignore */
            }
            return response;
          }
        }
      } catch {
        /* fall through */
      }
    }
    return new Response('Too large', { status: 413, headers: corsHeaders() });
  }

  const outType = ctype.startsWith('image/') ? ctype.split(';')[0] : 'image/jpeg';
  const headers = corsHeaders({
    'Content-Type': outType,
    'Cache-Control': 'public, max-age=86400, s-maxage=604800',
    'X-P5-Proxy-Cache': 'MISS',
  });
  const response = new Response(buf, { status: 200, headers });
  try {
    await cache.put(cacheKey, response.clone());
  } catch {
    /* ignore */
  }
  return response;
}


function b64ToBytes(b64) {
  const cleaned = String(b64 || '').replace(/^data:audio\/[^;]+;base64,/, '').replace(/\s+/g, '');
  const bin = atob(cleaned);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function sanitizeSpeakText(raw) {
  // Single words (~40) or short example sentences (~200). Letters + common EN punct.
  const text = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!text || text.length > 200) return null;
  if (!/^[A-Za-z][A-Za-z0-9\s\-',.?!]*[.?!]?$/.test(text)) return null;
  // Block obvious injection / control chars (already stripped by the regex)
  if (/[<>{}\[\]\\|;`]/.test(text)) return null;
  return text;
}

const AURA_MODEL = '@cf/deepgram/aura-2-en';
const AURA_SPEAKERS = ['asteria', 'luna']; // asteria = clear female EN; luna = fallback
const TTS_CACHE_VERSION = 'v1';

async function sha256Hex(input) {
  const data = new TextEncoder().encode(String(input));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Stable object key: hash(normalized text + voice + model). */
async function ttsCacheKey(text, speaker, model = AURA_MODEL) {
  const material = `${TTS_CACHE_VERSION}|${model}|${speaker}|${text}`;
  const hash = await sha256Hex(material);
  return `tts/${TTS_CACHE_VERSION}/${hash}.mp3`;
}

function detectAudioMime(bytes) {
  let mime = 'audio/mpeg';
  if (bytes && bytes.length >= 4) {
    const isRiff =
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
    const isId3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
    const isMp3Frame = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
    if (isId3 || isMp3Frame) mime = 'audio/mpeg';
    else if (isRiff) mime = 'audio/wav';
  }
  return mime;
}

function speakAudioHeaders(mime, cacheStatus, speaker) {
  return corsHeaders({
    'Content-Type': mime || 'audio/mpeg',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-P5-Speak': '1',
    'X-P5-TTS': 'aura-2-en',
    'X-TTS-Cache': cacheStatus,
    ...(speaker ? { 'X-TTS-Speaker': speaker } : {}),
  });
}

async function ttsResultToBytes(result) {
  if (result == null) return null;
  if (typeof ReadableStream !== 'undefined' && result instanceof ReadableStream) {
    const buf = await new Response(result).arrayBuffer();
    return new Uint8Array(buf);
  }
  if (typeof Response !== 'undefined' && result instanceof Response) {
    const buf = await result.arrayBuffer();
    return new Uint8Array(buf);
  }
  if (result instanceof ArrayBuffer) return new Uint8Array(result);
  if (result instanceof Uint8Array) return result;
  if (result && typeof result === 'object') {
    if (typeof result.audio === 'string') return b64ToBytes(result.audio);
    if (result.audio instanceof ArrayBuffer) return new Uint8Array(result.audio);
    if (result.audio instanceof Uint8Array) return result.audio;
    if (typeof result.getReader === 'function') {
      const buf = await new Response(result).arrayBuffer();
      return new Uint8Array(buf);
    }
  }
  if (typeof result === 'string') return b64ToBytes(result);
  return null;
}

async function readTtsCache(env, key) {
  if (!env.TTS_CACHE || !key) return null;
  try {
    const obj = await env.TTS_CACHE.get(key, { type: 'arrayBuffer' });
    if (!obj || !obj.byteLength) return null;
    return new Uint8Array(obj);
  } catch {
    return null;
  }
}

async function writeTtsCache(env, key, bytes, mime) {
  if (!env.TTS_CACHE || !key || !bytes || !bytes.byteLength) return;
  try {
    await env.TTS_CACHE.put(key, bytes, {
      metadata: {
        mime: mime || 'audio/mpeg',
        storedAt: new Date().toISOString(),
      },
    });
  } catch {
    /* ignore store failures — still serve audio */
  }
}

async function speakText(request, env, url) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== 'POST' && request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders() });
  }

  let raw = url.searchParams.get('t') || '';
  let voiceParam = (url.searchParams.get('voice') || url.searchParams.get('speaker') || '').trim().toLowerCase();
  if (request.method === 'POST') {
    try {
      const body = await request.json();
      if (body && typeof body.text === 'string') raw = body.text;
      if (body && typeof body.voice === 'string') voiceParam = body.voice.trim().toLowerCase();
      else if (body && typeof body.speaker === 'string') voiceParam = body.speaker.trim().toLowerCase();
    } catch {
      /* keep query fallback */
    }
  }
  const text = sanitizeSpeakText(raw);
  if (!text) {
    return new Response('Bad text', { status: 400, headers: corsHeaders() });
  }

  // Prefer requested voice when valid; otherwise asteria → luna.
  const speakers = AURA_SPEAKERS.includes(voiceParam)
    ? [voiceParam, ...AURA_SPEAKERS.filter((s) => s !== voiceParam)]
    : [...AURA_SPEAKERS];

  // 1) Cache lookup (KV) — same text+voice → same object forever.
  for (const speaker of speakers) {
    const key = await ttsCacheKey(text, speaker);
    const cached = await readTtsCache(env, key);
    if (cached && cached.byteLength) {
      const mime = detectAudioMime(cached);
      return new Response(cached, {
        status: 200,
        headers: speakAudioHeaders(mime, 'HIT', speaker),
      });
    }
  }

  if (!env.AI) {
    return new Response('AI binding missing', { status: 500, headers: corsHeaders() });
  }

  // 2) Cache miss → call Aura once, store MP3, return.
  let result;
  let usedSpeaker = null;
  let lastErr = null;
  for (const speaker of speakers) {
    try {
      result = await env.AI.run(AURA_MODEL, {
        text,
        speaker,
        encoding: 'mp3',
      });
      usedSpeaker = speaker;
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      result = undefined;
    }
  }
  if (result === undefined && lastErr) {
    // Final attempt: omit speaker (Aura-2 defaults to luna)
    try {
      result = await env.AI.run(AURA_MODEL, {
        text,
        encoding: 'mp3',
      });
      usedSpeaker = 'luna';
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      const exhausted = /neuron|allocation|429|rate/i.test(msg);
      return new Response(exhausted ? 'TTS unavailable (AI quota)' : 'TTS failed', {
        status: exhausted ? 503 : 502,
        headers: corsHeaders({ 'X-TTS-Cache': 'MISS', 'X-TTS-Error': exhausted ? 'ai_quota' : 'ai_failed' }),
      });
    }
  }
  if (result === undefined) {
    return new Response('TTS failed', {
      status: 502,
      headers: corsHeaders({ 'X-TTS-Cache': 'MISS', 'X-TTS-Error': 'ai_failed' }),
    });
  }

  const bytes = await ttsResultToBytes(result);
  if (!bytes || !bytes.byteLength) {
    return new Response('Empty audio', { status: 502, headers: corsHeaders() });
  }

  const mime = detectAudioMime(bytes);
  const storeSpeaker = usedSpeaker || speakers[0] || 'asteria';
  const key = await ttsCacheKey(text, storeSpeaker);
  await writeTtsCache(env, key, bytes, mime);

  return new Response(bytes, {
    status: 200,
    headers: speakAudioHeaders(mime, 'MISS', storeSpeaker),
  });
}



/* ---------- User-reported images (KV REPORTS) ---------- */
const REPORTED_SET_KEY = 'reported:urls';
const MAX_REPORTED_URLS = 5000;
const MAX_DAY_REPORTS = 500;
const MAX_REPORTS_PER_IP_PER_DAY = 3;

function jsonResponse(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      ...extra,
    }),
  });
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function clientIp(request) {
  const cf = (request.headers.get('CF-Connecting-IP') || '').trim();
  if (cf) return cf;
  const xff = (request.headers.get('X-Forwarded-For') || '').trim();
  if (xff) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  return '';
}

function reportCountKey(ip, day) {
  return `report-count:ip:${ip}:${day}`;
}

async function readReportedSet(env) {
  if (!env.REPORTS) return [];
  try {
    const raw = await env.REPORTS.get(REPORTED_SET_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((u) => typeof u === 'string' && u) : [];
  } catch {
    return [];
  }
}

async function writeReportedSet(env, urls) {
  if (!env.REPORTS) return;
  const trimmed = urls.slice(0, MAX_REPORTED_URLS);
  await env.REPORTS.put(REPORTED_SET_KEY, JSON.stringify(trimmed));
}

async function readIpDayReportCount(env, ip, day) {
  if (!env.REPORTS || !ip) return 0;
  try {
    const raw = await env.REPORTS.get(reportCountKey(ip, day));
    if (!raw) return 0;
    if (raw.startsWith('{')) {
      const obj = JSON.parse(raw);
      return Number(obj.count) || 0;
    }
    return Number(raw) || 0;
  } catch {
    return 0;
  }
}

async function incrementIpDayReportCount(env, ip, day, prevCount) {
  if (!env.REPORTS || !ip) return;
  const now = new Date().toISOString();
  const count = (prevCount || 0) + 1;
  const expirationTtl = 60 * 60 * 48; // 48h
  await env.REPORTS.put(
    reportCountKey(ip, day),
    JSON.stringify({ count, day, lastAt: now }),
    { expirationTtl },
  );
}

async function handleReportedImages(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders() });
  }
  const urls = await readReportedSet(env);
  return jsonResponse({ urls }, 200, { 'Cache-Control': 'public, max-age=60' });
}

async function handleImgOk(request, url, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders() });
  }
  const raw = url.searchParams.get('u') || '';
  if (!raw) return jsonResponse({ ok: true });
  const urls = await readReportedSet(env);
  const ok = !urls.includes(raw);
  return jsonResponse({ ok }, 200, { 'Cache-Control': 'public, max-age=30' });
}

async function handleReportImage(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders() });
  }
  if (!env.REPORTS) {
    return jsonResponse({ ok: false, error: 'reports store unavailable' }, 503);
  }

  const ip = clientIp(request);
  const day = todayUtc();
  const ipDayCount = await readIpDayReportCount(env, ip, day);
  if (ip && ipDayCount >= MAX_REPORTS_PER_IP_PER_DAY) {
    return jsonResponse({ ok: false, error: 'rate_limited' }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'invalid json' }, 400);
  }
  const imageUrl = typeof body?.url === 'string' ? body.url.trim() : '';
  if (!imageUrl) {
    return jsonResponse({ ok: false, error: 'url required' }, 400);
  }
  const parsed = parseTargetUrl(imageUrl);
  if (parsed.error) {
    return jsonResponse({ ok: false, error: 'bad url' }, 400);
  }

  const entry = {
    url: parsed.target.toString(),
    wordId: body.wordId != null ? String(body.wordId).slice(0, 64) : undefined,
    word: body.word != null ? String(body.word).slice(0, 64) : undefined,
    reason: body.reason != null ? String(body.reason).slice(0, 200) : 'inappropriate',
    date: body.date != null ? String(body.date).slice(0, 32) : undefined,
    roundIndex:
      typeof body.roundIndex === 'number' && Number.isFinite(body.roundIndex)
        ? body.roundIndex
        : undefined,
    at: new Date().toISOString(),
  };

  const dayKey = `reports:${day}`;
  let dayList = [];
  try {
    const raw = await env.REPORTS.get(dayKey);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) dayList = arr;
    }
  } catch {
    dayList = [];
  }
  dayList.push(entry);
  if (dayList.length > MAX_DAY_REPORTS) dayList = dayList.slice(-MAX_DAY_REPORTS);
  await env.REPORTS.put(dayKey, JSON.stringify(dayList));

  const set = await readReportedSet(env);
  if (!set.includes(entry.url)) {
    set.unshift(entry.url);
    await writeReportedSet(env, set);
  }

  await incrementIpDayReportCount(env, ip, day, ipDayCount);

  return jsonResponse({ ok: true, url: entry.url });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/img') {
      return proxyImage(request, url);
    }
    if (url.pathname === '/api/speak') {
      return new Response(
        JSON.stringify({
          error: 'gone',
          message: 'TTS is served as static Edge-TTS MP3s under /audio/w/ and /audio/e/. Cloudflare Workers AI is not used.',
        }),
        { status: 410, headers: { ...corsHeaders(), 'Content-Type': 'application/json' } },
      );
    }
    if (url.pathname === '/api/report-image') {
      return handleReportImage(request, env);
    }
    if (url.pathname === '/api/reported-images') {
      return handleReportedImages(request, env);
    }
    if (url.pathname === '/api/img-ok') {
      return handleImgOk(request, url, env);
    }
    if (url.pathname.startsWith('/api/')) {
      return new Response('Not found', { status: 404, headers: corsHeaders() });
    }
    return env.ASSETS.fetch(request);
  },
};
