/** محرّك الباراللاكس — Parallax Engine: يتبع المؤشر الدقيق فقط،
 *  بحلقة rAF تتوقف ذاتياً عند السكون (صفر إطارات مهدورة). */

import { reducedMotion } from './animate.js';

const finePointer = (): boolean => matchMedia('(hover: hover) and (pointer: fine)').matches;

/** يربط الباراللاكس بجذر المشهد؛ يعيد دالة فصل كاملة. */
export function attachParallax(scene: HTMLElement): () => void {
  if (!finePointer() || reducedMotion()) return () => { /* معطّل على اللمس/تقليل الحركة */ };

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
  const onVisibility = (): void => { if (document.hidden && raf) { cancelAnimationFrame(raf); raf = 0; } };

  addEventListener('pointermove', onMove, { passive: true });
  addEventListener('resize', onResize, { passive: true });
  document.addEventListener('visibilitychange', onVisibility);

  return (): void => {
    if (raf) cancelAnimationFrame(raf);
    removeEventListener('pointermove', onMove);
    removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
