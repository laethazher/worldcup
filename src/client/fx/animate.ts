/** أدوات الحركة المشتركة — Animation Utilities. */

export const reducedMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** عدّاد تصاعدي فاخر للإحصاءات — يقفز للقيمة مباشرة مع تقليل الحركة. */
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
