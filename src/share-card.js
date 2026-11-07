/**
 * Cute portrait share card PNG for daily spelling (1080×1440).
 * Images via same-origin /api/img proxy → blob → createImageBitmap.
 */
import { DAILY_ROUNDS, emojiGrid, SHARE_SITE } from './daily.js';
import { proxiedImageUrl } from './words.js';

export const CARD_W = 1080;
export const CARD_H = 1440;
const FETCH_TIMEOUT_MS = 12000;

function proxyUrl(absoluteUrl) {
  return proxiedImageUrl(absoluteUrl);
}

async function loadBitmapViaProxy(absoluteUrl) {
  const via = proxyUrl(absoluteUrl);
  if (!via) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(via, {
      method: 'GET',
      credentials: 'same-origin',
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob || blob.size < 32) return null;
    if (typeof createImageBitmap === 'function') {
      const bmp = await createImageBitmap(blob);
      if (bmp && (bmp.width || 0) > 0) return bmp;
    }
    const objUrl = URL.createObjectURL(blob);
    try {
      return await new Promise((resolve) => {
        const el = new Image();
        el.onload = () => resolve((el.naturalWidth || el.width) > 0 ? el : null);
        el.onerror = () => resolve(null);
        el.src = objUrl;
      });
    } finally {
      URL.revokeObjectURL(objUrl);
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawPlaceholder(ctx, x, y, size, index) {
  const hues = [340, 200, 45, 160, 280, 20];
  const hue = hues[index % hues.length];
  const g = ctx.createLinearGradient(x, y, x + size, y + size);
  g.addColorStop(0, `hsla(${hue}, 70%, 78%, 1)`);
  g.addColorStop(1, `hsla(${hue + 30}, 65%, 62%, 1)`);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, size, size);
  ctx.font = '700 48px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('✏️', x + size / 2, y + size / 2);
}

function drawCover(ctx, img, x, y, size) {
  const iw = img.naturalWidth || img.width || 1;
  const ih = img.naturalHeight || img.height || 1;
  const scale = Math.max(size / iw, size / ih);
  const sw = size / scale;
  const sh = size / scale;
  const sx = (iw - sw) / 2;
  const sy = (ih - sh) / 2;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, sw, sh, x, y, size, size);
}

/**
 * @param {object} opts
 * @param {string} opts.dateStr
 * @param {number[]} opts.pattern
 * @param {number} opts.score
 * @param {Array<{ imageUrl?: string }|null>} [opts.photos]
 */
export async function renderShareCard(opts) {
  const dateStr = opts.dateStr;
  const pattern = (opts.pattern || []).map((x) => (x ? 1 : 0));
  const score = Number(opts.score) || 0;
  const photos = opts.photos || [];
  const correct = pattern.filter(Boolean).length;
  const total = pattern.length || DAILY_ROUNDS;

  const canvas = document.createElement('canvas');
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, CARD_W, CARD_H);
  bg.addColorStop(0, '#fff1f7');
  bg.addColorStop(0.45, '#e8f4ff');
  bg.addColorStop(1, '#fff8e7');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // soft orbs
  function orb(x, y, r, color) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  orb(180, 200, 280, 'rgba(255, 145, 200, 0.35)');
  orb(900, 360, 320, 'rgba(120, 190, 255, 0.35)');
  orb(540, 1200, 400, 'rgba(255, 210, 100, 0.28)');

  const pad = 48;
  roundRect(ctx, pad, 56, CARD_W - pad * 2, CARD_H - 112, 44);
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 140, 180, 0.35)';
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '800 52px system-ui, -apple-system, "PingFang HK", "Noto Sans TC", sans-serif';
  ctx.fillStyle = '#d63384';
  ctx.fillText('✏️ 小五英文拼字', CARD_W / 2, 140);

  ctx.font = '600 32px system-ui, -apple-system, "PingFang HK", "Noto Sans TC", sans-serif';
  ctx.fillStyle = '#5b6b8c';
  ctx.fillText(`今日挑戰 · ${dateStr}`, CARD_W / 2, 196);

  ctx.font = '800 120px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = '#2d3a5c';
  ctx.fillText(`${correct}/${total}`, CARD_W / 2, 340);

  ctx.font = '700 44px system-ui, -apple-system, "PingFang HK", "Noto Sans TC", sans-serif';
  ctx.fillStyle = '#f59e0b';
  ctx.fillText(`${score} 分`, CARD_W / 2, 404);

  const loaded = await Promise.all(
    Array.from({ length: Math.min(total, 15) }, (_, i) => {
      const p = photos[i];
      const url =
        (typeof p === 'string' && p) ||
        p?.imageUrl ||
        p?.thumbUrl ||
        (Array.isArray(p?.urls) && p.urls[0]) ||
        '';
      return loadBitmapViaProxy(url);
    }),
  );

  const cols = 5;
  const rows = 3;
  const gap = 18;
  const cell = 160;
  const gridW = cols * cell + (cols - 1) * gap;
  const gridH = rows * cell + (rows - 1) * gap;
  const gridX = (CARD_W - gridW) / 2;
  const gridY = 460;

  for (let i = 0; i < total; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = gridX + col * (cell + gap);
    const y = gridY + row * (cell + gap);
    const ok = !!pattern[i];
    const ring = ok ? '#22c55e' : '#f87171';
    const img = loaded[i];

    ctx.save();
    roundRect(ctx, x - 4, y - 4, cell + 8, cell + 8, 28);
    ctx.fillStyle = ok ? 'rgba(34,197,94,0.18)' : 'rgba(248,113,113,0.16)';
    ctx.fill();
    ctx.restore();

    ctx.save();
    roundRect(ctx, x, y, cell, cell, 22);
    ctx.clip();
    if (img) {
      try {
        drawCover(ctx, img, x, y, cell);
      } catch {
        drawPlaceholder(ctx, x, y, cell, i);
      }
    } else {
      drawPlaceholder(ctx, x, y, cell, i);
    }
    ctx.restore();

    ctx.save();
    roundRect(ctx, x, y, cell, cell, 22);
    ctx.strokeStyle = ring;
    ctx.lineWidth = 7;
    ctx.stroke();
    ctx.restore();

    const bx = x + cell - 28;
    const by = y + cell - 28;
    ctx.beginPath();
    ctx.arc(bx, by, 22, 0, Math.PI * 2);
    ctx.fillStyle = ok ? '#16a34a' : '#dc2626';
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '700 22px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ok ? '✓' : '✗', bx, by + 1);
  }

  ctx.font = '36px "Apple Color Emoji","Segoe UI Emoji",sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#2d3a5c';
  // wrap emoji grid into 3 lines of 5
  const em = (pattern || []).map((x) => (x ? '🟩' : '🟥'));
  for (let r = 0; r < 3; r++) {
    ctx.fillText(em.slice(r * 5, r * 5 + 5).join(''), CARD_W / 2, gridY + gridH + 56 + r * 44);
  }

  ctx.font = '500 24px system-ui, -apple-system, "PingFang HK", "Noto Sans TC", sans-serif';
  ctx.fillStyle = 'rgba(91,107,140,0.9)';
  ctx.fillText('成績圖唔會劇透正確拼法', CARD_W / 2, CARD_H - 100);

  ctx.font = '600 26px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(91,107,140,0.75)';
  ctx.fillText(SHARE_SITE.replace(/^https?:\/\//, ''), CARD_W / 2, CARD_H - 56);

  const dataUrl = canvas.toDataURL('image/png');
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png', 1);
  });
  const fileName = `p5english-${dateStr}.png`;
  const file = new File([blob], fileName, { type: 'image/png' });
  return { canvas, blob, file, dataUrl };
}

export function formatShareCaption(payload) {
  const correct = (payload.p || []).filter(Boolean).length;
  const total = (payload.p || []).length || DAILY_ROUNDS;
  const sc = Number(payload.sc) || 0;
  return `✏️ 小五英文拼字 ${payload.d}\n${correct}/${total} · ${sc} 分\n${emojiGrid(payload.p)}`;
}

export function canShareFiles() {
  try {
    if (!navigator.share || !navigator.canShare) return false;
    const probe = new File([new Blob(['x'], { type: 'image/png' })], 't.png', { type: 'image/png' });
    return navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

export async function copyImageToClipboard(blob) {
  if (!navigator.clipboard || !window.ClipboardItem) {
    throw new Error('clipboard image unsupported');
  }
  await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
}

export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
