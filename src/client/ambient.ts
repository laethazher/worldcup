/** محرّك الخلفية المشترك — Background Engine (المنسّق).
 *  يبني طبقات نمط الهوية + الإضاءة + الفينييت + الغبار، ويربط الباراللاكس
 *  ودورة الحياة (تجميد عند إخفاء التبويب). الأنماط في css/scene.css.
 *  كل صفحة تستهلك النسخة ذاتها وتضبط الشدّات فقط عبر PRESETS. */

import { buildDust } from './fx/particles.js';
import { attachParallax } from './fx/parallax.js';
export { countUp, reducedMotion } from './fx/animate.js';

export interface ScenePreset {
  particles: number;   // كثافة الغبار (عدد الحبيبات)
  light: number;       // شدة الإضاءة السينمائية (مضاعِف)
  vignette: number;    // شدة الفينييت (مضاعِف)
  pattern: number;     // شدة نمط المعيّنات (مضاعِف)
}
export interface SceneHandle { destroy(): void; }

/* عمق الباراللاكس بالبكسل لكل طبقة: الخلفية 1 · الوسط 2 · الغبار 4 */
const DEPTHS = { pattern: 1, glow: 2, dust: 4 } as const;

/* ─── هوية كل صفحة: الحفل احتفالي أقصى إشراقاً، الصدارة تنافسية متوسطة،
       الرئيسية متوازنة، الملف/الإشعارات هادئة، الإدارة رزينة بلا غبار ─── */
export const PRESETS: Record<string, ScenePreset> = {
  '/ceremony.html':      { particles: 22, light: 1.15, vignette: 1,   pattern: 1 },
  '/leaderboard.html':   { particles: 14, light: .85,  vignette: .85, pattern: .9 },
  '/hall.html':          { particles: 16, light: .95,  vignette: .9,  pattern: .95 },
  '/index.html':         { particles: 12, light: .8,   vignette: .7,  pattern: .85 },
  '/achievements.html':  { particles: 12, light: .8,   vignette: .7,  pattern: .85 },
  '/matches.html':       { particles: 10, light: .7,   vignette: .6,  pattern: .8 },
  '/profile.html':       { particles: 6,  light: .6,   vignette: .5,  pattern: .7 },
  '/notifications.html': { particles: 6,  light: .55,  vignette: .5,  pattern: .7 },
  '/admin.html':         { particles: 0,  light: .45,  vignette: .4,  pattern: .6 },
};
const DEFAULT_PRESET: ScenePreset = { particles: 6, light: .6, vignette: .5, pattern: .7 };

function div(className: string, depth?: number): HTMLDivElement {
  const n = document.createElement('div');
  n.className = className;
  if (depth !== undefined) n.style.setProperty('--d', String(depth));
  return n;
}

export function mountScene(preset: ScenePreset = DEFAULT_PRESET): SceneHandle {
  const scene = div('scene');
  scene.setAttribute('aria-hidden', 'true');
  scene.style.setProperty('--scene-light', String(preset.light));
  scene.style.setProperty('--scene-vignette', String(preset.vignette));
  scene.style.setProperty('--scene-pattern', String(preset.pattern));

  /* غلاف الباراللاكس يحوي عناصر الحركة البطيئة — فصلٌ يمنع تعارض الـtransform */
  const wrap = (depth: number, ...inner: HTMLElement[]): HTMLElement => {
    const w = div('scene-plx', depth);
    w.append(...inner);
    return w;
  };

  const dustHost = div('scene-dust');
  if (preset.particles > 0) buildDust(dustHost, preset.particles);

  scene.append(
    wrap(DEPTHS.pattern, div('scene-pattern sp-1'), div('scene-pattern sp-2'), div('scene-pattern sp-3')),
    div('scene-pattern sp-4'),                  // تنفّس الشفافية — بلا باراللاكس عمداً
    div('scene-pattern sp-5'),                  // التمدد البالغ النعومة
    wrap(DEPTHS.glow, div('scene-glow')),
    div('scene-vignette'),
    wrap(DEPTHS.dust, dustHost),
  );
  document.body.prepend(scene);

  const detachParallax = attachParallax(scene);

  /* دورة الحياة: تجميد كل الحركة عند إخفاء التبويب */
  const onVisibility = (): void => { scene.classList.toggle('fx-paused', document.hidden); };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    destroy(): void {
      detachParallax();
      document.removeEventListener('visibilitychange', onVisibility);
      scene.remove();
    },
  };
}

/** نقطة الاستهلاك الموحّدة: تختار إعداد الصفحة الحالية وتركّب المشهد. */
export function mountPageScene(): SceneHandle {
  const path = location.pathname === '/' ? '/index.html' : location.pathname;
  return mountScene(PRESETS[path] ?? DEFAULT_PRESET);
}
