/**
 * Client helpers for user-reported problematic spelling-game photos.
 * Fetches the reported-URL set and skips those URLs in the carousel.
 */

const CACHE_TTL_MS = 60_000;
let cachedUrls = null;
let cachedAt = 0;
let inflight = null;

/** @returns {Promise<Set<string>>} */
export async function getReportedUrls() {
  const now = Date.now();
  if (cachedUrls && now - cachedAt < CACHE_TTL_MS) {
    return cachedUrls;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch('/api/reported-images', {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      const list = Array.isArray(data?.urls) ? data.urls.filter(Boolean) : [];
      cachedUrls = new Set(list);
      cachedAt = Date.now();
      return cachedUrls;
    } catch {
      // Fail-open: treat as empty so gameplay continues
      if (!cachedUrls) cachedUrls = new Set();
      cachedAt = Date.now();
      return cachedUrls;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Locally mark a URL reported (optimistic; also after successful POST). */
export function markReportedLocally(url) {
  if (!url) return;
  if (!cachedUrls) cachedUrls = new Set();
  cachedUrls.add(url);
  cachedAt = Date.now();
}

/** Sync filter using the in-memory cache (empty = fail-open, show all). */
export function filterUnreportedUrls(urls) {
  const list = Array.isArray(urls) ? urls.filter(Boolean) : [];
  if (!list.length) return [];
  if (!cachedUrls || cachedUrls.size === 0) return list.slice();
  const kept = list.filter((u) => !cachedUrls.has(u));
  return kept;
}

/**
 * @returns {Promise<{ ok: boolean, rateLimited?: boolean }>}
 */
export async function reportImage(payload) {
  const url = payload?.url;
  if (!url) return { ok: false };
  try {
    const res = await fetch('/api/report-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);
    if (res.status === 429 || data?.error === 'rate_limited') {
      return { ok: false, rateLimited: true };
    }
    if (res.ok && data?.ok) {
      markReportedLocally(data.url || url);
      return { ok: true };
    }
    // Still mark locally so this session skips it
    markReportedLocally(url);
    return { ok: false };
  } catch {
    markReportedLocally(url);
    return { ok: false };
  }
}

export async function isUrlReported(url) {
  if (!url) return false;
  const set = await getReportedUrls();
  return set.has(url);
}
