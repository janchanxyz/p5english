/**
 * Daily spelling challenge — deterministic 10 words for Asia/Hong_Kong calendar day.
 * Seed: p5english-daily-YYYY-MM-DD via xmur3 + mulberry32.
 */
import { WORDS, imageablePool } from './words.js';

export const DAILY_ROUNDS = 10;
export const DAILY_TZ = 'Asia/Hong_Kong';
export const SHARE_SITE = 'https://p5english.chanplanet.workers.dev';
export const MIN_BLANKS = 2;
export const MAX_BLANKS = 5;

/** YYYY-MM-DD in Hong Kong time */
export function hkDateString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DAILY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function isValidDateStr(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function next() {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

function mulberry32(a) {
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededRng(seedStr) {
  const seed = xmur3(String(seedStr))();
  return mulberry32(seed);
}

function seededShuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function dailySeed(dateStr) {
  const d = isValidDateStr(dateStr) ? dateStr : hkDateString();
  return `p5english-daily-${d}`;
}

/** Pick the same 10 words for everyone on this HK date. Prefer imageable. */
export function pickDailyWords(dateStr) {
  const d = isValidDateStr(dateStr) ? dateStr : hkDateString();
  const rng = seededRng(dailySeed(d));
  const preferred = imageablePool();
  const pool = preferred.length >= DAILY_ROUNDS ? preferred : WORDS;
  const shuffled = seededShuffle(pool, rng);
  return shuffled.slice(0, Math.min(DAILY_ROUNDS, shuffled.length));
}

/**
 * Choose 2–5 blank letter indices for a word (deterministic per day+index).
 * Always leave at least one letter visible when length allows.
 */
export function pickBlankIndices(word, dateStr, roundIndex) {
  const w = String(word || '').toLowerCase();
  const n = w.length;
  if (n < 2) return [];
  const rng = seededRng(`${dailySeed(dateStr)}-blanks-${roundIndex}-${w}`);
  let blankCount = MIN_BLANKS + Math.floor(rng() * (MAX_BLANKS - MIN_BLANKS + 1));
  blankCount = Math.max(MIN_BLANKS, Math.min(MAX_BLANKS, blankCount, n - 1, n));
  if (n <= 4) blankCount = Math.min(blankCount, Math.max(2, n - 1));
  const indices = Array.from({ length: n }, (_, i) => i);
  const shuffled = seededShuffle(indices, rng);
  return shuffled.slice(0, blankCount).sort((a, b) => a - b);
}

/** Build puzzle: { word, blanks: number[], mask: ('letter'|null)[] } */
export function buildPuzzle(entry, dateStr, roundIndex) {
  const word = String(entry?.word || '').toLowerCase();
  const blanks = pickBlankIndices(word, dateStr, roundIndex);
  const blankSet = new Set(blanks);
  const mask = word.split('').map((ch, i) => (blankSet.has(i) ? null : ch));
  return { ...entry, word, blanks, mask };
}

function progressKey(dateStr) {
  return `p5english-progress-${dateStr}`;
}

function doneKey(dateStr) {
  return `p5english-done-${dateStr}`;
}

/** @returns {{ index: number, answers: string[], results: number[], startedAt: number } | null} */
export function readProgress(dateStr) {
  try {
    const raw = localStorage.getItem(progressKey(dateStr));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj.index !== 'number') return null;
    return {
      index: Math.max(0, Math.min(DAILY_ROUNDS, Number(obj.index) || 0)),
      answers: Array.isArray(obj.answers) ? obj.answers.map((x) => String(x || '')) : [],
      results: Array.isArray(obj.results) ? obj.results.map((x) => (x ? 1 : 0)) : [],
      hearts: Math.max(0, Math.min(8, Number(obj.hearts ?? 8))),
      gameOver: Boolean(obj.gameOver),
      startedAt: Number(obj.startedAt) || Date.now(),
    };
  } catch {
    return null;
  }
}

export function saveProgress(dateStr, payload) {
  try {
    localStorage.setItem(
      progressKey(dateStr),
      JSON.stringify({
        index: payload.index,
        answers: payload.answers || [],
        results: (payload.results || []).map((x) => (x ? 1 : 0)),
        hearts: Math.max(0, Math.min(8, Number(payload.hearts ?? 8))),
        gameOver: Boolean(payload.gameOver),
        startedAt: payload.startedAt || Date.now(),
        at: Date.now(),
      }),
    );
  } catch {
    /* ignore */
  }
}

export function clearProgress(dateStr) {
  try {
    localStorage.removeItem(progressKey(dateStr));
  } catch {
    /* ignore */
  }
}

export function clearDailyDone(dateStr) {
  try {
    localStorage.removeItem(doneKey(dateStr));
  } catch {
    /* ignore */
  }
}

/** Clear today's progress + done score so the daily challenge can be replayed. */
export function resetToday(dateStr) {
  clearProgress(dateStr);
  clearDailyDone(dateStr);
}

/** @returns {{ sc: number, p: number[], n: number } | null} */
export function readDailyDone(dateStr) {
  try {
    const raw = localStorage.getItem(doneKey(dateStr));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.p)) return null;
    return {
      sc: Number(obj.sc) || 0,
      p: obj.p.map((x) => (x ? 1 : 0)),
      n: Number(obj.n) || obj.p.length,
      go: Boolean(obj.go),
    };
  } catch {
    return null;
  }
}

export function saveDailyDone(dateStr, payload) {
  try {
    localStorage.setItem(
      doneKey(dateStr),
      JSON.stringify({
        sc: payload.sc,
        p: (payload.p || []).map((x) => (x ? 1 : 0)),
        n: payload.n ?? payload.p?.length ?? DAILY_ROUNDS,
        go: Boolean(payload.go),
        at: Date.now(),
      }),
    );
  } catch {
    /* ignore */
  }
}

export function buildSharePayload(dateStr, results, score) {
  return {
    d: dateStr,
    p: results.map((x) => (x ? 1 : 0)),
    sc: score,
  };
}

export function encodeSharePayload(payload) {
  const json = JSON.stringify({ d: payload.d, p: payload.p, sc: payload.sc });
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeSharePayload(s) {
  try {
    if (!s || typeof s !== 'string') return null;
    let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const obj = JSON.parse(new TextDecoder().decode(bytes));
    if (!obj || !isValidDateStr(obj.d) || !Array.isArray(obj.p)) return null;
    return {
      d: obj.d,
      p: obj.p.map((x) => (x ? 1 : 0)).slice(0, DAILY_ROUNDS),
      sc: Number(obj.sc) || 0,
    };
  } catch {
    return null;
  }
}

export function emojiGrid(pattern) {
  return (pattern || []).map((x) => (x ? '🟩' : '🟥')).join('');
}

export function shareUrl(encoded) {
  return `${SHARE_SITE}/?s=${encoded}`;
}

export function formatShareText(payload, siteUrl) {
  const correct = (payload.p || []).filter(Boolean).length;
  const total = (payload.p || []).length || DAILY_ROUNDS;
  const sc = Number(payload.sc) || 0;
  let out = `✏️ 小五英文拼字 ${payload.d}\n${correct}/${total} · ${sc} 分\n${emojiGrid(payload.p)}`;
  if (siteUrl) out += `\n${siteUrl}`;
  return out;
}

void WORDS;
