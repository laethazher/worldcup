/** المشهد المحيطي لحفل التتويج — طبقات نمط الهوية + إضاءة سينمائية + غبار ذهبي.
 *  المبادئ: transform/opacity فقط (تركيب GPU، صفر إعادة تخطيط)، حركة شبه محسوسة،
 *  باراللاكس للمؤشر الدقيق فقط، إيقاف كامل عند إخفاء التبويب، واحترام تقليل الحركة. */

export interface SceneHandle { destroy(): void; }

/* عمق الباراللاكس بالبكسل لكل طبقة: الخلفية 1 · الوسط 2 · الغبار 4 */
const DEPTHS = { pattern: 1, glow: 2, dust: 4 } as const;

const DUST_COUNT = 22;
/* توزيع أنواع الحبيبات: غبار خافت، ذهبي، أبيض، متوهج نادر */
const DUST_KINDS: ReadonlyArray<[kind: string, weight: number]> =
  [['dust', 9], ['gold', 7], ['white', 4], ['glow', 2]];

const reducedMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = (): boolean => matchMedia('(hover: hover) and (pointer: fine)').matches;
const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);

function div(className: string, depth?: number): HTMLDivElement {
  const n = document.createElement('div');
  n.className = className;
  if (depth !== undefined) n.style.setProperty('--d', String(depth));
  return n;
}

function buildDust(host: HTMLElement): void {
  const bag: string[] = [];
  for (const [kind, weight] of DUST_KINDS) for (let n = 0; n < weight; n++) bag.push(kind);
  for (let i = 0; i < DUST_COUNT; i++) {
    const p = document.createElement('i');
    p.className = `mote mote-${bag[i % bag.length]}`;
    // عشوائية المسار والعمق: مدة/تأخير/انجراف/حجم/ضبابية/شفافية لكل حبيبة
    p.style.cssText =
      `left:${rand(2, 98).toFixed(1)}%;` +
      `--pdur:${rand(16, 42).toFixed(1)}s;` +
      `--pdelay:${rand(-40, 0).toFixed(1)}s;` +      // سالب: السماء مأهولة منذ اللحظة الأولى
      `--psway:${rand(-70, 70).toFixed(0)}px;` +
      `--psize:${rand(2, 5.5).toFixed(1)}px;` +
      `--pblur:${rand(0, 2.2).toFixed(1)}px;` +
      `--pop:${rand(0.2, 0.65).toFixed(2)}`;
    host.append(p);
  }
}

export function mountScene(): SceneHandle {
  const scene = div('scene');
  scene.setAttribute('aria-hidden', 'true');

  /* كل طبقة: غلاف باراللاكس (transform من JS) يحوي عنصر الحركة البطيئة (keyframes)
     — فصلٌ يمنع تعارض الـtransform بين النظامين. */
  const wrap = (depth: number, ...inner: HTMLElement[]): HTMLElement => {
    const w = div('scene-plx', depth);
    w.append(...inner);
    return w;
  };

  const dustHost = div('scene-dust');
  buildDust(dustHost);

  scene.append(
    wrap(DEPTHS.pattern, div('scene-pattern sp-1'), div('scene-pattern sp-2'), div('scene-pattern sp-3')),
    div('scene-pattern sp-4'),                  // تنفّس الشفافية — بلا باراللاكس عمداً
    div('scene-pattern sp-5'),                  // التمدد البالغ النعومة
    wrap(DEPTHS.glow, div('scene-glow')),
    wrap(DEPTHS.dust, dustHost),
  );
  document.body.prepend(scene);

  /* ─── الباراللاكس: lerp نحو الهدف بحلقة rAF تتوقف ذاتياً عند السكون ─── */
  let raf = 0, tx = 0, ty = 0, cx = 0, cy = 0;
  let vw = innerWidth, vh = innerHeight;

  const tick = (): void => {
    cx += (tx - cx) * 0.06;
    cy += (ty - cy) * 0.06;
    scene.style.setProperty('--plx-x', cx.toFixed(3));
    scene.style.setProperty('--plx-y', cy.toFixed(3));
    raf = Math.abs(tx - cx) + Math.abs(ty - cy) > 0.002 ? requestAnimationFrame(tick) : 0;
  };
  const onMove = (e: PointerEvent): void => {
    tx = (e.clientX / vw) * 2 - 1;               // ‎-1..1
    ty = (e.clientY / vh) * 2 - 1;
    if (!raf && !document.hidden) raf = requestAnimationFrame(tick);
  };
  const onResize = (): void => { vw = innerWidth; vh = innerHeight; };

  const parallaxOn = finePointer() && !reducedMotion();
  if (parallaxOn) {
    addEventListener('pointermove', onMove, { passive: true });
    addEventListener('resize', onResize, { passive: true });
  }

  /* ─── دورة الحياة: تجميد كل الحركة عند إخفاء التبويب ─── */
  const onVisibility = (): void => {
    scene.classList.toggle('fx-paused', document.hidden);
    if (document.hidden && raf) { cancelAnimationFrame(raf); raf = 0; }
  };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    destroy(): void {
      if (raf) cancelAnimationFrame(raf);
      if (parallaxOn) { removeEventListener('pointermove', onMove); removeEventListener('resize', onResize); }
      document.removeEventListener('visibilitychange', onVisibility);
      scene.remove();
    },
  };
}

/* ─── عدّاد تصاعدي فاخر للإحصاءات — يقفز للقيمة مباشرة مع تقليل الحركة ─── */
export function countUp(node: HTMLElement, value: number, format: (n: number) => string, ms = 950): void {
  if (reducedMotion() || value <= 0) { node.textContent = format(value); return; }
  const t0 = performance.now();
  const frame = (t: number): void => {
    const k = Math.min(1, (t - t0) / ms);
    const eased = 1 - Math.pow(1 - k, 3);        // easeOutCubic
    node.textContent = format(Math.round(value * eased));
    if (k < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
