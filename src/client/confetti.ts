interface P { x: number; y: number; vx: number; vy: number; size: number; color: string; life: number; max: number; shape: 0 | 1; rot: number; vr: number; }

/* لوحتا قصاصات من عائلات الهوية — الفاتحة تستبدل الفاتح-الكريمي (غير المرئي
   على خلفية فاتحة) بدرجات أعمق من نفس العائلات */
const PALETTES = {
  dark: ['#C82A3E', '#E3C766', '#F5F1EE', '#9E8D87', '#C9A227'],
  light: ['#A51E2F', '#6E1220', '#9C7B14', '#75655C', '#C9A227'],
};
const COLORS = (): readonly string[] =>
  PALETTES[document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'];
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let parts: P[] = [];
let raf = 0;

function ensure(): void {
  if (canvas) return;
  canvas = document.getElementById('fx') as HTMLCanvasElement | null;
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'fx';
    canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:80';
    document.body.append(canvas);
  }
  ctx = canvas.getContext('2d');
  const fit = () => { canvas!.width = innerWidth * devicePixelRatio; canvas!.height = innerHeight * devicePixelRatio; ctx!.scale(devicePixelRatio, devicePixelRatio); };
  fit();
  addEventListener('resize', fit);
}

function loop(): void {
  if (!ctx || !canvas) return;
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  parts = parts.filter(p => p.life < p.max);
  for (const p of parts) {
    p.life++; p.x += p.vx; p.y += p.vy; p.vy += 0.12; p.vx *= 0.99; p.rot += p.vr;
    const alpha = 1 - p.life / p.max;
    ctx.save();
    ctx.globalAlpha = Math.max(alpha, 0);
    ctx.translate(p.x, p.y); ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    if (p.shape === 0) ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size / 1.5);
    else { ctx.beginPath(); ctx.arc(0, 0, p.size / 2, 0, 7); ctx.fill(); }
    ctx.restore();
  }
  if (parts.length) raf = requestAnimationFrame(loop);
  else { ctx.clearRect(0, 0, innerWidth, innerHeight); raf = 0; }
}

function spawn(n: number, x: number, y: number, spread: number, power: number): void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  ensure();
  const palette = COLORS();
  for (let i = 0; i < n; i++) {
    const ang = (Math.random() - 0.5) * spread - Math.PI / 2;
    const v = power * (0.5 + Math.random());
    parts.push({
      x, y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v,
      size: 5 + Math.random() * 6, color: palette[Math.floor(Math.random() * palette.length)],
      life: 0, max: 70 + Math.random() * 50, shape: Math.random() > 0.5 ? 0 : 1,
      rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3,
    });
  }
  if (!raf) raf = requestAnimationFrame(loop);
}

export function confettiBurst(): void {
  spawn(120, innerWidth / 2, innerHeight * 0.35, 2.4, 8);
}

export function fireworks(durationMs = 5200): void {
  ensure();
  const t0 = Date.now();
  const shoot = () => {
    if (Date.now() - t0 > durationMs) return;
    spawn(70, innerWidth * (0.15 + Math.random() * 0.7), innerHeight * (0.15 + Math.random() * 0.4), Math.PI * 2, 6);
    setTimeout(shoot, 380 + Math.random() * 420);
  };
  shoot();
}
