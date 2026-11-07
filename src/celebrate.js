/**
 * Kid-friendly confetti + fireworks celebration (no npm deps).
 * Overlay is pointer-events:none so Next stays tappable.
 */

const COLORS = [
  '#ff6bab', '#5aa9ff', '#ffd166', '#22c55e', '#a78bfa',
  '#fb7185', '#38bdf8', '#fbbf24', '#34d399', '#f472b6',
  '#60a5fa', '#fcd34d', '#c084fc', '#4ade80',
];

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function rand(a, b) {
  return a + Math.random() * (b - a);
}

function pick(arr) {
  return arr[(Math.random() * arr.length) | 0];
}

function softPulse() {
  const el = document.createElement('div');
  el.className = 'celebrate-pulse';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<span>🌟</span><span>✨</span><span>🎉</span>';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1400);
}

/**
 * @param {{ big?: boolean }} [opts]
 */
export function celebrateCorrect(opts = {}) {
  const big = !!opts.big;
  if (prefersReducedMotion()) {
    softPulse();
    return;
  }

  // Remove any leftover overlay so rapid corrects don't stack forever
  document.querySelectorAll('.celebrate-overlay').forEach((n) => n.remove());

  const canvas = document.createElement('canvas');
  canvas.className = 'celebrate-overlay';
  canvas.setAttribute('aria-hidden', 'true');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  document.body.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    canvas.remove();
    softPulse();
    return;
  }
  ctx.scale(dpr, dpr);

  const particles = [];
  const bursts = [];
  const duration = big ? 2000 : 1600;
  const start = performance.now();

  function addConfetti(n) {
    for (let i = 0; i < n; i++) {
      const fromTop = Math.random() < 0.7;
      particles.push({
        kind: Math.random() < 0.25 ? 'star' : Math.random() < 0.5 ? 'rect' : 'circle',
        x: rand(0, w),
        y: fromTop ? rand(-40, h * 0.15) : rand(h * 0.2, h * 0.55),
        vx: rand(-2.2, 2.2),
        vy: fromTop ? rand(1.5, 4.5) : rand(-6, -2),
        g: rand(0.04, 0.12),
        size: rand(4, big ? 12 : 9),
        rot: rand(0, Math.PI * 2),
        vr: rand(-0.2, 0.2),
        color: pick(COLORS),
        life: rand(0.75, 1),
        sparkle: Math.random() < 0.35,
      });
    }
  }

  function addFirework(cx, cy, power) {
    const count = big ? 36 + ((Math.random() * 18) | 0) : 22 + ((Math.random() * 12) | 0);
    const color = pick(COLORS);
    const color2 = pick(COLORS);
    for (let i = 0; i < count; i++) {
      const ang = (Math.PI * 2 * i) / count + rand(-0.1, 0.1);
      const spd = rand(power * 0.45, power);
      particles.push({
        kind: Math.random() < 0.3 ? 'star' : 'spark',
        x: cx,
        y: cy,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        g: 0.06,
        size: rand(2.5, big ? 6 : 4.5),
        rot: 0,
        vr: 0,
        color: Math.random() < 0.5 ? color : color2,
        life: rand(0.65, 1),
        sparkle: true,
        fade: true,
      });
    }
    // soft bloom flash
    bursts.push({ x: cx, y: cy, r: 8, max: big ? 90 : 60, a: 0.55, color });
  }

  addConfetti(big ? 70 : 42);
  // staggered firework launches
  const centers = big
    ? [
        [w * 0.25, h * 0.35],
        [w * 0.5, h * 0.28],
        [w * 0.75, h * 0.35],
        [w * 0.4, h * 0.5],
        [w * 0.6, h * 0.48],
      ]
    : [
        [w * 0.3, h * 0.32],
        [w * 0.7, h * 0.3],
        [w * 0.5, h * 0.42],
      ];
  centers.forEach(([cx, cy], i) => {
    setTimeout(() => {
      if (!canvas.isConnected) return;
      addFirework(cx + rand(-20, 20), cy + rand(-15, 15), big ? rand(5, 8) : rand(3.5, 6));
      if (big && i === 1) addConfetti(24);
    }, i * (big ? 180 : 140));
  });

  function drawStar(x, y, r, rot) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = (i * Math.PI * 2) / 5 - Math.PI / 2;
      const a2 = a + Math.PI / 5;
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      ctx.lineTo(Math.cos(a2) * r * 0.45, Math.sin(a2) * r * 0.45);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function frame(now) {
    const t = (now - start) / duration;
    if (t >= 1 || !canvas.isConnected) {
      canvas.remove();
      return;
    }
    ctx.clearRect(0, 0, w, h);

    // fade out near the end
    const fade = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;

    for (let i = bursts.length - 1; i >= 0; i--) {
      const b = bursts[i];
      b.r += (b.max - b.r) * 0.12;
      b.a *= 0.92;
      if (b.a < 0.02) {
        bursts.splice(i, 1);
        continue;
      }
      const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
      g.addColorStop(0, b.color + '99');
      g.addColorStop(1, b.color + '00');
      ctx.globalAlpha = b.a * fade;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
    }

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.vy += p.g;
      p.vx *= 0.995;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      if (p.fade) p.life -= 0.018;
      else p.life -= 0.004;
      if (p.life <= 0 || p.y > h + 40) {
        particles.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = Math.max(0, p.life) * fade;
      ctx.fillStyle = p.color;
      if (p.kind === 'star') {
        drawStar(p.x, p.y, p.size, p.rot);
      } else if (p.kind === 'rect') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillRect(-p.size * 0.35, -p.size * 0.7, p.size * 0.7, p.size * 1.4);
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (p.kind === 'spark' ? 0.7 : 0.55), 0, Math.PI * 2);
        ctx.fill();
        if (p.sparkle && (now / 80 | 0) % 2 === 0) {
          ctx.globalAlpha = Math.max(0, p.life) * fade * 0.85;
          ctx.fillStyle = '#fff';
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(1, p.size * 0.25), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
  // Safety remove
  setTimeout(() => {
    if (canvas.isConnected) canvas.remove();
  }, duration + 400);
}
