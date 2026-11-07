import { t } from './i18n.js';
import { displayImage, displayImages, proxiedImageUrl } from './words.js';
import {
  DAILY_ROUNDS,
  hkDateString,
  pickDailyWords,
  buildPuzzle,
  readProgress,
  saveProgress,
  clearProgress,
  clearDailyDone,
  resetToday,
  readDailyDone,
  saveDailyDone,
  buildSharePayload,
  encodeSharePayload,
  decodeSharePayload,
  shareUrl,
  formatShareText,
  SHARE_SITE,
} from './daily.js';
import {
  renderShareCard,
  formatShareCaption,
  canShareFiles,
  copyImageToClipboard,
  downloadBlob,
} from './share-card.js';
import { celebrateCorrect } from './celebrate.js';

const main = document.getElementById('main');
const datePill = document.getElementById('datePill');

const MAX_HEARTS = 8;

const state = {
  dateStr: hkDateString(),
  words: [],
  puzzles: [],
  index: 0,
  answers: [],
  results: [],
  hearts: MAX_HEARTS,
  gameOver: false,
  draft: [], // letters for current blanks
  activeBlank: 0,
  revealed: false,
  sharePayload: null,
  shareCard: null,
  view: 'home', // home | play | end | review | shareView | gameover
};

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}


let speakBusy = false;
let speakAudio = null;
let speakSession = 0;
/** Resolves the in-flight play-until-ended waiter when audio is stopped/superseded. */
let speakPlayWait = null;
/** Bumped to cancel in-flight auto word→example sequences. */
let autoSpeakToken = 0;
/** Last puzzle index that already started auto-speak this run. */
let autoSpokeIndex = -1;

/** Blank the target word (whole-word, case-insensitive) with underscores of same length. */
function blankExampleSentence(example, word) {
  const ex = String(example || '');
  const w = String(word || '').trim();
  if (!ex || !w) return ex;
  const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('\\b' + escaped + '\\b', 'gi');
  return ex.replace(re, (matched) => '_'.repeat(matched.length));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopSpeakAudio() {
  if (speakAudio) {
    try {
      speakAudio.onended = null;
      speakAudio.onerror = null;
      speakAudio.pause();
      const src = speakAudio.src;
      speakAudio.removeAttribute('src');
      speakAudio.load?.();
      if (src && src.startsWith('blob:')) URL.revokeObjectURL(src);
    } catch {
      /* ignore */
    }
    speakAudio = null;
  }
  if (speakPlayWait) {
    speakPlayWait({ stopped: true });
  }
}

/** Cancel auto-speak sequence and stop any current TTS. */
function cancelAutoSpeak() {
  autoSpeakToken += 1;
  speakSession += 1;
  stopSpeakAudio();
  speakBusy = false;
}

/**
 * Fetch TTS and play until ended. Resolves true on full playback, false on fail/cancel.
 * Interrupts any previous playback. Manual buttons pass a btn; auto-speak uses silent:true.
 */
async function speakTextUi(text, btn, idleHtml, opts = {}) {
  const clean = String(text || '').trim();
  if (!clean) return false;
  const silent = !!opts.silent;
  const session = ++speakSession;
  stopSpeakAudio();
  speakBusy = true;
  if (btn) {
    btn.disabled = true;
    btn.classList.add('loading');
    btn.innerHTML = `<span class="ico">⏳</span>${t('speakLoading')}`;
  }
  try {
    const res = await fetch('/api/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: clean }),
    });
    if (session !== speakSession) return false;
    if (!res.ok) throw new Error(`speak ${res.status}`);
    const blob = await res.blob();
    if (session !== speakSession) return false;
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    speakAudio = audio;
    const playResult = await new Promise((resolve) => {
      let settled = false;
      const finish = (info) => {
        if (settled) return;
        if (speakPlayWait !== finish) return;
        settled = true;
        speakPlayWait = null;
        try {
          URL.revokeObjectURL(url);
        } catch {
          /* ignore */
        }
        if (speakAudio === audio) speakAudio = null;
        resolve(info);
      };
      speakPlayWait = finish;
      audio.onended = () => finish({ ok: true });
      audio.onerror = () => finish({ ok: false, error: true });
      const p = audio.play();
      if (p && typeof p.then === 'function') {
        p.catch((err) => finish({ ok: false, error: err }));
      }
    });
    if (session !== speakSession || playResult.stopped) return false;
    if (!playResult.ok) throw playResult.error || new Error('audio error');
    return true;
  } catch (err) {
    if (!silent && session === speakSession) toast(t('speakFail'));
    return false;
  } finally {
    if (session === speakSession) speakBusy = false;
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('loading');
      btn.innerHTML = idleHtml;
    }
  }
}

async function speakWord(word) {
  // Manual speak cancels any pending auto example
  autoSpeakToken += 1;
  const btn = main.querySelector('[data-act="speak"]');
  await speakTextUi(word, btn, `<span class="ico">🔊</span>${t('speak')}`);
}

async function speakExample(sentence) {
  autoSpeakToken += 1;
  const btn = main.querySelector('[data-act="speak-example"]');
  await speakTextUi(sentence, btn, `<span class="ico">🎧</span>${t('speakExample')}`);
}

/** Auto: word → wait 1s after end → example. Aborts if token changes / leave play / reveal. */
async function autoSpeakQuestion(puzzle, index) {
  if (!puzzle || state.revealed || state.view !== 'play') return;
  if (autoSpokeIndex === index) return;
  autoSpokeIndex = index;
  const token = ++autoSpeakToken;
  const word = String(puzzle.word || '').trim();
  const example = String(puzzle.example || '').trim();
  if (!word) return;

  const played = await speakTextUi(word, null, '', { silent: true });
  if (token !== autoSpeakToken) return;
  if (!played) return; // autoplay blocked or failed — keep buttons available, no toast spam
  if (!example) return;

  await sleep(1000);
  if (token !== autoSpeakToken) return;
  if (state.revealed || state.view !== 'play' || state.index !== index) return;

  await speakTextUi(example, null, '', { silent: true });
}

function queueAutoSpeak() {
  const puzzle = currentPuzzle();
  if (!puzzle || state.revealed || state.view !== 'play') return;
  // Defer one tick so DOM/buttons from renderPlay are ready; Start/Next gesture still counts.
  setTimeout(() => {
    if (state.view === 'play' && !state.revealed) autoSpeakQuestion(puzzle, state.index);
  }, 0);
}

function ensureDaily() {
  state.dateStr = hkDateString();
  datePill.textContent = state.dateStr;
  const picked = pickDailyWords(state.dateStr);
  state.words = picked;
  state.puzzles = picked.map((w, i) => buildPuzzle(w, state.dateStr, i));
}

function loadOrResetProgress() {
  const done = readDailyDone(state.dateStr);
  if (done) {
    state.results = done.p;
    state.index = DAILY_ROUNDS;
    state.answers = [];
    state.hearts = 0;
    state.gameOver = Boolean(done.go);
    return done.go ? 'gameover' : 'done';
  }
  const prog = readProgress(state.dateStr);
  if (prog && prog.gameOver) {
    state.index = prog.index;
    state.answers = prog.answers;
    state.results = prog.results;
    state.hearts = 0;
    state.gameOver = true;
    return 'gameover';
  }
  if (prog && prog.index < DAILY_ROUNDS) {
    state.index = prog.index;
    state.answers = prog.answers;
    state.results = prog.results;
    state.hearts = Number.isFinite(prog.hearts) ? prog.hearts : MAX_HEARTS;
    state.gameOver = false;
    return 'continue';
  }
  state.index = 0;
  state.answers = [];
  state.results = [];
  state.hearts = MAX_HEARTS;
  state.gameOver = false;
  return 'fresh';
}

function persist() {
  saveProgress(state.dateStr, {
    index: state.index,
    answers: state.answers,
    results: state.results,
    hearts: state.hearts,
    gameOver: state.gameOver,
    startedAt: Date.now(),
  });
}

function renderHearts() {
  const filled = Math.max(0, Math.min(MAX_HEARTS, state.hearts));
  const hearts = Array.from({ length: MAX_HEARTS }, (_, i) =>
    i < filled ? '<span class="heart on" aria-hidden="true">❤</span>' : '<span class="heart off" aria-hidden="true">♡</span>',
  ).join('');
  return `<div class="hearts" role="img" aria-label="${t('hearts')} ${filled}/${MAX_HEARTS}"><span class="hearts-label">${t('hearts')}</span><span class="hearts-row">${hearts}</span></div>`;
}

function finalizeGameOver() {
  state.gameOver = true;
  state.hearts = 0;
  // Pad remaining unanswered rounds as misses so share/end grids stay consistent
  while (state.results.length < DAILY_ROUNDS) state.results.push(0);
  const score = state.results.filter(Boolean).length;
  saveDailyDone(state.dateStr, {
    sc: score,
    p: state.results,
    n: DAILY_ROUNDS,
    go: true,
  });
  clearProgress(state.dateStr);
  return score;
}

function currentPuzzle() {
  return state.puzzles[state.index] || null;
}

function displayChar(ch, index) {
  const c = String(ch || '').toLowerCase();
  if (!c) return '';
  return index === 0 ? c.toUpperCase() : c;
}

function titleWord(word) {
  const w = String(word || '').toLowerCase();
  return w ? w[0].toUpperCase() + w.slice(1) : '';
}

function blankLetters(puzzle) {
  return (puzzle?.blanks || []).map((bi) => puzzle.word[bi]);
}

function initDraft(puzzle) {
  state.draft = (puzzle?.blanks || []).map(() => '');
  state.activeBlank = 0;
  state.revealed = false;
}

function assembledAnswer(puzzle) {
  if (!puzzle) return '';
  const chars = puzzle.word.split('');
  puzzle.blanks.forEach((bi, di) => {
    chars[bi] = (state.draft[di] || '').toLowerCase();
  });
  return chars.join('');
}

function confirmResetToday() {
  return window.confirm(t('resetConfirm'));
}

function resetTodayRun(andPlay) {
  if (!confirmResetToday()) return false;
  resetToday(state.dateStr);
  state.index = 0;
  state.answers = [];
  state.results = [];
  state.hearts = MAX_HEARTS;
  state.gameOver = false;
  state.revealed = false;
  state.draft = [];
  state.activeBlank = 0;
  state.sharePayload = null;
  state.shareCard = null;
  toast(t('resetDone'));
  if (andPlay) {
    startPlay(true);
  } else {
    state.view = 'home';
    renderHome();
  }
  return true;
}

function renderHome() {
  cancelAutoSpeak();
  const status = loadOrResetProgress();
  const done = status === 'done';
  const gone = status === 'gameover';
  const cont = status === 'continue';
  main.innerHTML = `
    <section class="card home">
      <h2 class="hero-title">✏️ ${t('title')}</h2>
      <p class="hero-sub">${t('subtitle')}<br/>${t('today')}：<strong>${state.dateStr}</strong></p>
      <div class="btn-row">
        ${
          done || gone
            ? `<button class="btn btn-primary" data-act="${gone ? 'gameover' : 'end'}">${gone ? t('seeGameOver') : t('finish') + '（已完成）'}</button>
               <button class="btn btn-secondary" data-act="review">${t('review')}</button>
               <button class="btn btn-ghost" data-act="reset">${t('resetToday')}</button>
               <button class="btn btn-ghost" data-act="replay">${t('replayPractice')}</button>`
            : cont
              ? `<button class="btn btn-primary" data-act="play">${t('continue')}（${state.index + 1}/${DAILY_ROUNDS} · ❤${state.hearts}）</button>
                 <button class="btn btn-ghost" data-act="reset">${t('resetToday')}</button>`
              : `<button class="btn btn-primary" data-act="play">${t('start')}</button>`
        }
      </div>
      <div class="howto">
        <strong>${t('howTo')}</strong><br/>
        ${t('howToBody')}
        <br/><br/><span class="muted">${t('attribution')}</span>
      </div>
    </section>
  `;
  main.querySelector('[data-act="play"]')?.addEventListener('click', () => startPlay(false));
  main.querySelector('[data-act="reset"]')?.addEventListener('click', () => resetTodayRun(true));
  main.querySelector('[data-act="replay"]')?.addEventListener('click', () => {
    // Practice only — does not clear today's official score/done record
    state.index = 0;
    state.answers = [];
    state.results = [];
    state.hearts = MAX_HEARTS;
    state.gameOver = false;
    startPlay(true);
  });
  main.querySelector('[data-act="end"]')?.addEventListener('click', () => showEnd(false));
  main.querySelector('[data-act="gameover"]')?.addEventListener('click', () => showGameOver(false));
  main.querySelector('[data-act="review"]')?.addEventListener('click', showReview);
}

function startPlay(fresh) {
  if (fresh || state.puzzles.length === 0) ensureDaily();
  if (fresh) {
    state.hearts = MAX_HEARTS;
    state.gameOver = false;
  }
  if (state.gameOver || state.hearts <= 0) {
    showGameOver(false);
    return;
  }
  if (state.index >= DAILY_ROUNDS) {
    showEnd(true);
    return;
  }
  initDraft(currentPuzzle());
  state.view = 'play';
  autoSpokeIndex = -1;
  renderPlay();
  queueAutoSpeak();
}

function renderSlots(puzzle, mode) {
  // mode: input | reveal
  const blankPos = new Map(puzzle.blanks.map((bi, di) => [bi, di]));
  return puzzle.word
    .split('')
    .map((ch, i) => {
      if (!blankPos.has(i)) {
        return `<div class="slot">${displayChar(ch, i)}</div>`;
      }
      const di = blankPos.get(i);
      if (mode === 'reveal') {
        const ok = (state.draft[di] || '').toLowerCase() === ch.toLowerCase();
        return `<div class="slot blank ${ok ? 'reveal-ok' : 'reveal-bad'}">${displayChar(ch, i)}</div>`;
      }
      const filled = state.draft[di] || '';
      const active = state.activeBlank === di ? 'active' : '';
      const has = filled ? 'filled' : '';
      return `<div class="slot blank ${active} ${has}" data-di="${di}">${filled ? displayChar(filled, i) : ''}</div>`;
    })
    .join('');
}

function renderKeyboard() {
  const rows = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
  const rowHtml = rows
    .map((row, ri) => {
      const keys = row
        .split('')
        .map((l) => `<button type="button" class="kbd-key" data-key="${l}">${l}</button>`)
        .join('');
      const extras =
        ri === 2
          ? `<button type="button" class="kbd-key wide" data-key="back">${t('backspace')}</button>
      <button type="button" class="kbd-key wide accent" data-key="clear">${t('clear')}</button>`
          : '';
      return `<div class="kbd-row">${keys}${extras}</div>`;
    })
    .join('');
  return `
    <div class="kbd" role="group" aria-label="${t('letters')}">
      ${rowHtml}
    </div>
  `;
}


function renderCarousel(entry) {
  const imgs = displayImages(entry);
  const urls = (imgs.urls || []).map((u) => proxiedImageUrl(u) || u).filter(Boolean);
  if (!urls.length) {
    return `<div class="pic-wrap pic-empty"><div class="pic-fallback">📚</div></div>`;
  }
  const credit = imgs.credits?.[0] || imgs.credit || '';
  const slides = urls
    .map(
      (src, i) =>
        `<div class="pic-slide${i === 0 ? ' active' : ''}" data-i="${i}">
          <img src="${src}" alt="" loading="${i === 0 ? 'eager' : 'lazy'}" decoding="async" data-fallbacks="${escapeHtml(
            urls.slice(i + 1).join('|'),
          )}" />
        </div>`,
    )
    .join('');
  const dots =
    urls.length > 1
      ? `<div class="pic-dots" role="tablist">${urls
          .map(
            (_, i) =>
              `<button type="button" class="pic-dot${i === 0 ? ' active' : ''}" data-i="${i}" aria-label="圖片 ${i + 1}"></button>`,
          )
          .join('')}</div>`
      : '';
  const nav =
    urls.length > 1
      ? `<button type="button" class="pic-nav prev" data-dir="-1" aria-label="上一張">‹</button>
         <button type="button" class="pic-nav next" data-dir="1" aria-label="下一張">›</button>`
      : '';
  return `
    <div class="pic-wrap" data-count="${urls.length}" data-idx="0">
      <div class="pic-track">${slides}</div>
      ${nav}
      ${dots}
      ${credit ? `<div class="pic-credit">${escapeHtml(t('imageCredit'))}: ${escapeHtml(credit)}</div>` : ''}
    </div>
  `;
}

function bindCarousel(root) {
  const wrap = root.querySelector('.pic-wrap');
  if (!wrap) return;
  const count = Number(wrap.dataset.count || 1);
  if (count <= 1) {
    wrap.querySelectorAll('img').forEach((img) => {
      img.addEventListener('error', onImgError);
    });
    return;
  }

  let idx = 0;
  const slides = [...wrap.querySelectorAll('.pic-slide')];
  const dots = [...wrap.querySelectorAll('.pic-dot')];

  function show(i) {
    idx = (i + count) % count;
    wrap.dataset.idx = String(idx);
    slides.forEach((s, n) => s.classList.toggle('active', n === idx));
    dots.forEach((d, n) => d.classList.toggle('active', n === idx));
    const creditEl = wrap.querySelector('.pic-credit');
    // keep first credit; fine for now
  }

  wrap.querySelectorAll('.pic-nav').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      show(idx + Number(btn.dataset.dir));
    });
  });
  dots.forEach((d) => {
    d.addEventListener('click', () => show(Number(d.dataset.i)));
  });

  // touch swipe
  let startX = 0;
  let dx = 0;
  wrap.addEventListener(
    'touchstart',
    (e) => {
      startX = e.changedTouches[0].clientX;
      dx = 0;
    },
    { passive: true },
  );
  wrap.addEventListener(
    'touchmove',
    (e) => {
      dx = e.changedTouches[0].clientX - startX;
    },
    { passive: true },
  );
  wrap.addEventListener(
    'touchend',
    () => {
      if (Math.abs(dx) > 40) show(idx + (dx < 0 ? 1 : -1));
    },
    { passive: true },
  );

  wrap.querySelectorAll('img').forEach((img) => {
    img.addEventListener('error', onImgError);
  });
}

function onImgError(ev) {
  const img = ev.currentTarget;
  const fallbacks = (img.dataset.fallbacks || '').split('|').filter(Boolean);
  if (fallbacks.length) {
    const next = fallbacks.shift();
    img.dataset.fallbacks = fallbacks.join('|');
    img.src = next;
    return;
  }
  img.style.display = 'none';
  const slide = img.closest('.pic-slide');
  if (slide && !slide.querySelector('.pic-fallback')) {
    const fb = document.createElement('div');
    fb.className = 'pic-fallback';
    fb.textContent = '📚';
    slide.appendChild(fb);
  }
}

function renderExampleBlock(puzzle, revealed) {
  const example = String(puzzle?.example || '').trim();
  if (!example) return '';
  const word = String(puzzle?.word || '').trim();
  const shown = revealed ? example : blankExampleSentence(example, word);
  const zh = String(puzzle?.exampleZh || '').trim();
  return `
    <div class="example-block">
      <p class="example-line">
        <span class="example-label">${t('exampleLabel')}</span>
        <span class="example-en">${escapeHtml(shown)}</span>
      </p>
      ${
        zh
          ? `<p class="example-zh-line"><span class="example-zh-label">${t('exampleZhLabel')}</span> ${escapeHtml(zh)}</p>`
          : ''
      }
      <div class="example-actions">
        <button type="button" class="speak-btn speak-example" data-act="speak-example" aria-label="${t('speakExample')}">
          <span class="ico">🎧</span>${t('speakExample')}
        </button>
      </div>
    </div>
  `;
}

function renderPlay() {
  const puzzle = currentPuzzle();
  if (!puzzle) {
    showEnd(true);
    return;
  }
  const pct = Math.round((state.index / DAILY_ROUNDS) * 100);
  const feedback = state.revealed
    ? assembledAnswer(puzzle) === puzzle.word
      ? `<p class="feedback ok">${t('correct')}</p>`
      : `<p class="feedback bad">${t('wrong')}<br/><span class="answer-reveal">${titleWord(puzzle.word)}</span></p>`
    : `<p class="feedback"></p>`;

  const outOfHearts = state.revealed && state.hearts <= 0;
  const nextLabel = outOfHearts
    ? t('seeGameOver')
    : state.index + 1 >= DAILY_ROUNDS
      ? t('finish')
      : t('next');
  main.innerHTML = `
    <section class="card play">
      <div class="meta-row">
        <span>${t('progress')} ${state.index + 1}${t('of')}${DAILY_ROUNDS}</span>
        <span>主題：${puzzle.theme || '—'}</span>
      </div>
      ${renderHearts()}
      <div class="progress-bar"><span style="width:${pct}%"></span></div>
      ${renderCarousel(puzzle)}
      <div class="gloss-row">
        <p class="zh-gloss">${escapeHtml(puzzle.zh || '')}</p>
        <button type="button" class="speak-btn" data-act="speak" aria-label="${t('speak')}">
          <span class="ico">🔊</span>${t('speak')}
        </button>
      </div>
      ${renderExampleBlock(puzzle, state.revealed)}
      <p class="zh-label">${t('hint')}</p>
      <div class="slots" id="slots">${renderSlots(puzzle, state.revealed ? 'reveal' : 'input')}</div>
      ${feedback}
      ${
        state.revealed
          ? `<div class="actions">
              <button class="btn btn-primary" data-act="next">${nextLabel}</button>
            </div>`
          : `${renderKeyboard()}
            <div class="actions">
              <button class="btn btn-primary" data-act="check">${t('check')}</button>
            </div>`
      }
    </section>
  `;

  bindCarousel(main);

  main.querySelector('[data-act="speak"]')?.addEventListener('click', () => {
    const w = currentPuzzle()?.word;
    if (w) speakWord(w);
  });
  main.querySelector('[data-act="speak-example"]')?.addEventListener('click', () => {
    const ex = currentPuzzle()?.example;
    if (ex) speakExample(ex);
  });

  if (!state.revealed) {
    bindSlotClicks();
    main.querySelectorAll('.kbd-key').forEach((btn) => {
      btn.addEventListener('click', () => onKey(btn.dataset.key));
    });
    main.querySelector('[data-act="check"]')?.addEventListener('click', onCheck);
  } else {
    main.querySelector('[data-act="next"]')?.addEventListener('click', () => {
      if (state.hearts <= 0) {
        cancelAutoSpeak();
        finalizeGameOver();
        showGameOver(true);
        return;
      }
      onNext();
    });
  }
}

/** Patch only the letter slots — avoids rebuilding images/keyboard (no full-screen blink). */
function updateSlotsDom() {
  const puzzle = currentPuzzle();
  if (!puzzle || state.revealed) return;
  const slots = main.querySelector('#slots') || main.querySelector('.slots');
  if (!slots) return;
  slots.innerHTML = renderSlots(puzzle, 'input');
  bindSlotClicks();
}

function bindSlotClicks() {
  main.querySelectorAll('.slot.blank').forEach((el) => {
    el.addEventListener('click', () => {
      const di = Number(el.dataset.di);
      if (Number.isNaN(di) || state.revealed) return;
      state.activeBlank = di;
      updateSlotsDom();
    });
  });
}

function onKey(key) {
  const puzzle = currentPuzzle();
  if (!puzzle || state.revealed) return;
  if (key === 'clear') {
    state.draft = puzzle.blanks.map(() => '');
    state.activeBlank = 0;
    updateSlotsDom();
    return;
  }
  if (key === 'back') {
    if (state.draft[state.activeBlank]) {
      state.draft[state.activeBlank] = '';
    } else if (state.activeBlank > 0) {
      state.activeBlank -= 1;
      state.draft[state.activeBlank] = '';
    }
    updateSlotsDom();
    return;
  }
  if (/^[a-z]$/.test(key)) {
    state.draft[state.activeBlank] = key;
    if (state.activeBlank < puzzle.blanks.length - 1) state.activeBlank += 1;
    updateSlotsDom();
  }
}

function onCheck() {
  const puzzle = currentPuzzle();
  if (!puzzle) return;
  if (state.draft.some((x) => !x)) {
    toast('請填晒所有空格先～');
    return;
  }
  cancelAutoSpeak();
  const ans = assembledAnswer(puzzle);
  const ok = ans === puzzle.word;
  state.answers[state.index] = ans;
  state.results[state.index] = ok ? 1 : 0;
  if (!ok) {
    state.hearts = Math.max(0, state.hearts - 1);
  }
  state.revealed = true;
  persist();
  renderPlay();
  if (ok) {
    const lastWord = state.index >= DAILY_ROUNDS - 1;
    celebrateCorrect({ big: lastWord });
  }
}

function onNext() {
  cancelAutoSpeak();
  state.index += 1;
  persist();
  if (state.index >= DAILY_ROUNDS) {
    const score = state.results.filter(Boolean).length;
    saveDailyDone(state.dateStr, {
      sc: score,
      p: state.results,
      n: DAILY_ROUNDS,
    });
    clearProgress(state.dateStr);
    showEnd(true);
    return;
  }
  initDraft(currentPuzzle());
  renderPlay();
  queueAutoSpeak();
}



/** Words for a given date (same seed as play). Syncs state.words to that day. */
function wordsForDate(dateStr) {
  const d = dateStr || state.dateStr || hkDateString();
  if (state.dateStr !== d || !state.words.length) {
    state.dateStr = d;
    state.words = pickDailyWords(d);
  }
  return state.words;
}

/**
 * Result grid with question thumbnails + green/red ring + ✓/✗ badge.
 * @param {number[]} pattern
 * @param {object[]} [words]
 */
function renderEndGrid(pattern, words) {
  const list = words && words.length ? words : wordsForDate(state.dateStr);
  const cells = (pattern || [])
    .map((x, i) => {
      const ok = !!x;
      const entry = list[i];
      const img = displayImage(entry);
      const raw = img.imageUrl || img.thumbUrl || (img.urls && img.urls[0]) || '';
      const src = proxiedImageUrl(raw) || '';
      const media = src
        ? `<img src="${src}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`
        : `<span class="end-ph" aria-hidden="true">📚</span>`;
      return `<div class="end-cell ${ok ? 'ok' : 'bad'}" title="#${i + 1}">${media}<span class="end-badge">${ok ? '✓' : '✗'}</span></div>`;
    })
    .join('');
  return `<div class="end-grid">${cells}</div>`;
}

async function showGameOver(justFinished) {
  cancelAutoSpeak();
  state.view = 'gameover';
  wordsForDate(state.dateStr);
  if (!state.gameOver) finalizeGameOver();
  const pattern = (state.results.length ? state.results : readDailyDone(state.dateStr)?.p) || [];
  const score = pattern.filter(Boolean).length;
  const attempted = Math.min(DAILY_ROUNDS, Math.max(state.index + 1, pattern.filter((x, i) => i <= state.index || x).length || score));
  const doneCount = Math.min(DAILY_ROUNDS, state.index + 1);
  const payload = buildSharePayload(state.dateStr, pattern, score);
  state.sharePayload = payload;

  main.innerHTML = `
    <section class="card end gameover">
      <h2 class="hero-title">${t('gameOverTitle')}</h2>
      <p class="hero-sub">${t('gameOverSub')}</p>
      ${renderHearts()}
      <div class="end-score">${score}/${DAILY_ROUNDS}</div>
      <p style="text-align:center;font-weight:800;color:#f59e0b">${t('gameOverScore')}：${score}</p>
      <p style="text-align:center;font-weight:700;color:var(--muted)">${t('gameOverWords')}：${doneCount}/${DAILY_ROUNDS}</p>
      ${renderEndGrid(pattern)}
      <div id="shareBox" class="btn-row">
        <button class="btn btn-primary" data-act="share">${t('share')}</button>
        <button class="btn btn-secondary" data-act="review">${t('review')}</button>
        <button class="btn btn-ghost" data-act="reset">${t('resetToday')}</button>
        <button class="btn btn-ghost" data-act="home">${t('home')}</button>
      </div>
    </section>
  `;

  main.querySelector('[data-act="home"]')?.addEventListener('click', () => {
    state.view = 'home';
    renderHome();
  });
  main.querySelector('[data-act="review"]')?.addEventListener('click', showReview);
  main.querySelector('[data-act="share"]')?.addEventListener('click', () => doShare(pattern, score));
  main.querySelector('[data-act="reset"]')?.addEventListener('click', () => resetTodayRun(true));

  if (justFinished) {
    try {
      await buildCard(pattern, score);
    } catch {
      /* ignore */
    }
  }
}

async function showEnd(justFinished) {
  cancelAutoSpeak();
  state.view = 'end';
  wordsForDate(state.dateStr);
  const pattern = (state.results.length ? state.results : readDailyDone(state.dateStr)?.p) || [];
  const score = pattern.filter(Boolean).length;
  const payload = buildSharePayload(state.dateStr, pattern, score);
  state.sharePayload = payload;
  const enc = encodeSharePayload(payload);
  const url = shareUrl(enc);

  main.innerHTML = `
    <section class="card end">
      <h2 class="hero-title">${t('doneTitle')}</h2>
      <p class="hero-sub">${t('doneSub')}</p>
      <div class="end-score">${score}/${DAILY_ROUNDS}</div>
      <p style="text-align:center;font-weight:800;color:#f59e0b">${score} 分</p>
      ${renderEndGrid(pattern)}
      <div id="shareBox" class="btn-row">
        <button class="btn btn-primary" data-act="share">${t('share')}</button>
        <button class="btn btn-secondary" data-act="review">${t('review')}</button>
        <button class="btn btn-ghost" data-act="reset">${t('resetToday')}</button>
        <button class="btn btn-ghost" data-act="home">${t('home')}</button>
      </div>
      <p class="muted" style="text-align:center;margin-top:12px;font-size:0.8rem;word-break:break-all">${url}</p>
    </section>
  `;

  main.querySelector('[data-act="home"]')?.addEventListener('click', () => {
    state.view = 'home';
    renderHome();
  });
  main.querySelector('[data-act="review"]')?.addEventListener('click', showReview);
  main.querySelector('[data-act="share"]')?.addEventListener('click', () => doShare(pattern, score));
  main.querySelector('[data-act="reset"]')?.addEventListener('click', () => resetTodayRun(true));

  if (justFinished) {
    // pre-render card quietly
    try {
      await buildCard(pattern, score);
    } catch {
      /* ignore */
    }
  }
}

async function buildCard(pattern, score) {
  const words = wordsForDate(state.dateStr);
  const photos = words.map((w) => displayImage(w));
  state.shareCard = await renderShareCard({
    dateStr: state.dateStr,
    pattern,
    score,
    photos,
  });
  return state.shareCard;
}

async function doShare(pattern, score) {
  const btn = main.querySelector('[data-act="share"]');
  if (btn) {
    btn.disabled = true;
    btn.textContent = t('loading');
  }
  try {
    const card = state.shareCard || (await buildCard(pattern, score));
    const caption = formatShareCaption(state.sharePayload);
    const box = main.querySelector('#shareBox');
    if (box && !main.querySelector('.share-preview')) {
      const img = document.createElement('img');
      img.className = 'share-preview';
      img.alt = 'share card';
      img.src = card.dataUrl;
      box.prepend(img);
      const row = document.createElement('div');
      row.className = 'btn-row';
      row.innerHTML = `
        <button class="btn btn-secondary" data-act="dl">${t('download')}</button>
        <button class="btn btn-ghost" data-act="copy">${t('copy')}</button>
      `;
      box.appendChild(row);
      row.querySelector('[data-act="dl"]')?.addEventListener('click', () => {
        downloadBlob(card.blob, card.file.name);
        toast('已下載成績圖');
      });
      row.querySelector('[data-act="copy"]')?.addEventListener('click', async () => {
        try {
          await copyImageToClipboard(card.blob);
          toast('已複製圖片');
        } catch {
          toast('複製失敗，試吓下載');
        }
      });
    }
    if (canShareFiles()) {
      try {
        await navigator.share({
          files: [card.file],
          title: t('title'),
          text: caption,
        });
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return;
      }
    }
    // fallback: copy text
    try {
      await navigator.clipboard.writeText(formatShareText(state.sharePayload, SHARE_SITE));
      toast('已複製分享文字');
    } catch {
      toast('請長按成績圖分享或下載');
    }
  } catch (e) {
    console.error(e);
    toast('產生成績圖失敗');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = t('share');
    }
  }
}

function showReview() {
  state.view = 'review';
  if (!state.words.length) ensureDaily();
  const pattern = state.results.length ? state.results : readDailyDone(state.dateStr)?.p || [];
  main.innerHTML = `
    <section class="card">
      <h2 class="hero-title">${t('review')}</h2>
      <p class="hero-sub">${state.dateStr}</p>
      <ul class="review-list">
        ${state.words
          .map((w, i) => {
            const img = displayImages(w);
            const src = proxiedImageUrl(img.thumbUrl || img.imageUrl) || img.imageUrl;
            const ok = pattern[i];
            return `<li>
              ${src ? `<img src="${src}" alt="" loading="lazy" />` : '<div style="width:56px;height:56px;border-radius:12px;background:#eee;display:flex;align-items:center;justify-content:center">📚</div>'}
              <div>
                <div class="w">${escapeHtml(titleWord(w.word))}</div>
                <div class="z">${escapeHtml(w.zh || '')}</div>
                ${w.example ? `<div class="ex">${escapeHtml(w.example)}</div>` : ''}
                ${w.exampleZh ? `<div class="ex-zh">${escapeHtml(w.exampleZh)}</div>` : ''}
              </div>
              <span class="badge">${ok === 1 ? '✅' : ok === 0 ? '❌' : '·'}</span>
            </li>`;
          })
          .join('')}
      </ul>
      <div class="btn-row" style="margin-top:16px">
        <button class="btn btn-primary" data-act="home">${t('home')}</button>
      </div>
    </section>
  `;
  main.querySelector('[data-act="home"]')?.addEventListener('click', () => {
    state.view = 'home';
    renderHome();
  });
}

function renderShareView(payload) {
  state.view = 'shareView';
  wordsForDate(payload.d || state.dateStr);
  const correct = payload.p.filter(Boolean).length;
  const total = payload.p.length || DAILY_ROUNDS;
  main.innerHTML = `
    <section class="card">
      <h2 class="hero-title">${t('shareView')}</h2>
      <p class="hero-sub">${payload.d}</p>
      <div class="end-score">${correct}/${total}</div>
      <p style="text-align:center;font-weight:800;color:#f59e0b">${payload.sc} 分</p>
      ${renderEndGrid(payload.p, wordsForDate(payload.d))}
      <div class="btn-row">
        <button class="btn btn-primary" data-act="playtoday">${t('playToday')}</button>
      </div>
    </section>
  `;
  main.querySelector('[data-act="playtoday"]')?.addEventListener('click', () => {
    history.replaceState({}, '', '/');
    ensureDaily();
    renderHome();
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function boot() {
  ensureDaily();
  const params = new URLSearchParams(location.search);
  const shared = params.get('s');
  if (shared) {
    const payload = decodeSharePayload(shared);
    if (payload) {
      renderShareView(payload);
      return;
    }
  }
  renderHome();
}

boot();
