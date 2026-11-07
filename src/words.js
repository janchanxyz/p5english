import data from './words-data.json';

export const WORDS = Array.isArray(data) ? data : [];

const byId = new Map();
for (const w of WORDS) {
  if (w?.id || w?.word) byId.set(w.id || w.word, w);
}

/** Commons-allowed mobile thumb width (see https://w.wiki/GHai). */
const THUMB_WIDTH = 500;

export function getWord(id) {
  return byId.get(id) || null;
}

/**
 * Rewrite Wikimedia Commons originals / large thumbs to a mobile-sized thumb URL.
 * Leaves non-Commons URLs unchanged.
 */
export function toMobileThumb(absoluteUrl, width = THUMB_WIDTH) {
  if (!absoluteUrl) return '';
  let u;
  try {
    u = new URL(absoluteUrl);
  } catch {
    return absoluteUrl;
  }
  const host = u.hostname.toLowerCase();
  if (host !== 'upload.wikimedia.org' && host !== 'thumb.wikimedia.org') {
    return absoluteUrl;
  }
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
  return absoluteUrl;
}

function collectRawUrls(entry) {
  if (!entry) return [];
  const list = [];
  if (Array.isArray(entry.imageUrls) && entry.imageUrls.length) {
    list.push(...entry.imageUrls);
  }
  if (entry.thumbUrl) list.unshift(entry.thumbUrl);
  if (entry.imageUrl) list.unshift(entry.imageUrl);
  return list.filter(Boolean);
}

/** Prefer entries with images for daily pool. */
export function imageablePool() {
  const withImg = WORDS.filter((w) => w?.imageUrl || (Array.isArray(w?.imageUrls) && w.imageUrls.length));
  return withImg.length >= 10 ? withImg : WORDS;
}

/**
 * All displayable image URLs for a word (2–4 preferred), normalized to mobile thumbs.
 */
export function displayImages(entry) {
  if (!entry) return { urls: [], credits: [], imageUrl: '', thumbUrl: '', credit: '' };
  const raw = collectRawUrls(entry);
  const seen = new Set();
  const urls = [];
  for (const u of raw) {
    const n = toMobileThumb(u);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    urls.push(n);
    if (urls.length >= 4) break;
  }
  const creditsRaw = Array.isArray(entry.imageCredits) && entry.imageCredits.length
    ? entry.imageCredits
    : entry.imageCredit
      ? [entry.imageCredit]
      : [];
  const credits = urls.map((_, i) => creditsRaw[i] || creditsRaw[0] || '');
  return {
    urls,
    credits,
    imageUrl: urls[0] || '',
    thumbUrl: urls[0] || '',
    credit: credits[0] || '',
  };
}

export function displayImage(entry) {
  return displayImages(entry);
}

/** Same-origin proxy URL for display / canvas. */
export function proxiedImageUrl(absoluteUrl) {
  if (!absoluteUrl) return '';
  try {
    const normalized = toMobileThumb(absoluteUrl);
    const u = new URL(
      normalized,
      typeof window !== 'undefined' ? window.location.origin : 'https://p5english.chanplanet.workers.dev',
    );
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return `/api/img?u=${encodeURIComponent(u.toString())}`;
  } catch {
    return '';
  }
}
