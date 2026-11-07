/**
 * Cloudflare Worker: SPA assets + same-origin image proxy for canvas share cards.
 * GET /api/img?u=<encoded absolute http(s) URL>
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

async function speakText(request, env, url) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== 'POST' && request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders() });
  }
  if (!env.AI) {
    return new Response('AI binding missing', { status: 500, headers: corsHeaders() });
  }

  let raw = url.searchParams.get('t') || '';
  if (request.method === 'POST') {
    try {
      const body = await request.json();
      if (body && typeof body.text === 'string') raw = body.text;
    } catch {
      /* keep query fallback */
    }
  }
  const text = sanitizeSpeakText(raw);
  if (!text) {
    return new Response('Bad text', { status: 400, headers: corsHeaders() });
  }

  // MeloTTS (@cf/myshell-ai/melotts) replaced by Deepgram Aura-2 (official CF TTS upgrade).
  // Aura-2 often returns a ReadableStream of MPEG/mp3 audio directly.
  const AURA_MODEL = '@cf/deepgram/aura-2-en';
  const speakers = ['asteria', 'luna']; // asteria = clear female EN; luna = default fallback
  let result;
  let lastErr = null;
  for (const speaker of speakers) {
    try {
      result = await env.AI.run(AURA_MODEL, {
        text,
        speaker,
        encoding: 'mp3',
      });
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
    } catch {
      return new Response('TTS failed', { status: 502, headers: corsHeaders() });
    }
  }
  if (result === undefined) {
    return new Response('TTS failed', { status: 502, headers: corsHeaders() });
  }

  const audioHeaders = (mime) =>
    corsHeaders({
      'Content-Type': mime,
      'Cache-Control': 'public, max-age=300',
      'X-P5-Speak': '1',
      'X-P5-TTS': 'aura-2-en',
    });

  // ReadableStream (typical Aura-2 binding return) — stream mp3 through
  if (typeof ReadableStream !== 'undefined' && result instanceof ReadableStream) {
    return new Response(result, { status: 200, headers: audioHeaders('audio/mpeg') });
  }
  // Response body / already a Response
  if (typeof Response !== 'undefined' && result instanceof Response) {
    const mime =
      (result.headers.get('content-type') || '').split(';')[0].trim() || 'audio/mpeg';
    return new Response(result.body, { status: 200, headers: audioHeaders(mime) });
  }

  let bytes;
  if (result instanceof ArrayBuffer) {
    bytes = new Uint8Array(result);
  } else if (result instanceof Uint8Array) {
    bytes = result;
  } else if (result && typeof result === 'object') {
    if (typeof result.audio === 'string') {
      bytes = b64ToBytes(result.audio);
    } else if (result.audio instanceof ArrayBuffer) {
      bytes = new Uint8Array(result.audio);
    } else if (result.audio instanceof Uint8Array) {
      bytes = result.audio;
    } else if (typeof result.getReader === 'function') {
      // Duck-typed stream
      return new Response(result, { status: 200, headers: audioHeaders('audio/mpeg') });
    }
  } else if (typeof result === 'string') {
    bytes = b64ToBytes(result);
  }

  if (!bytes || !bytes.byteLength) {
    return new Response('Empty audio', { status: 502, headers: corsHeaders() });
  }

  // Detect mime from magic bytes; Aura-2 with encoding:mp3 defaults to audio/mpeg
  let mime = 'audio/mpeg';
  if (bytes.length >= 4) {
    const isRiff =
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
    const isId3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
    const isMp3Frame = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
    if (isId3 || isMp3Frame) mime = 'audio/mpeg';
    else if (isRiff) mime = 'audio/wav';
  }

  return new Response(bytes, {
    status: 200,
    headers: audioHeaders(mime),
  });
}


export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/img') {
      return proxyImage(request, url);
    }
    if (url.pathname === '/api/speak') {
      return speakText(request, env, url);
    }
    return env.ASSETS.fetch(request);
  },
};
