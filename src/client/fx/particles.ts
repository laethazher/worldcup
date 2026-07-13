/** محرّك الحبيبات — Particle Engine: غبار ذهبي عائم بأعماق وسرعات عشوائية.
 *  الأنماط في css/scene.css؛ هنا التوليد العشوائي فقط. */

/* توزيع أنواع الحبيبات (نِسَب): غبار خافت، ذهبي، أبيض، متوهج نادر */
const KINDS: ReadonlyArray<[kind: string, weight: number]> =
  [['dust', 9], ['gold', 7], ['white', 4], ['glow', 2]];

const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);

export function buildDust(host: HTMLElement, count: number): void {
  const bag: string[] = [];
  for (const [kind, weight] of KINDS) for (let n = 0; n < weight; n++) bag.push(kind);
  for (let i = 0; i < count; i++) {
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
