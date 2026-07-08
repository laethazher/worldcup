/** شاشة الانطلاق — مرة واحدة بالجلسة، ≤ ثانيتين، قابلة للتخطي بالكيبورد والنقر. */
const KEY = 'ahc-splash-shown';
const veil = document.getElementById('splash');

function dismiss(): void {
  if (!veil) return;
  try { sessionStorage.setItem(KEY, '1'); } catch { /* خصوصية صارمة — نتجاهل */ }
  veil.remove();
  document.body.removeAttribute('aria-busy');
  window.removeEventListener('keydown', onKey);
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') dismiss();
}

if (veil) {
  let shown = false;
  try { shown = !!sessionStorage.getItem(KEY); } catch { /* noop */ }
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (shown || reduced) {
    veil.remove();
  } else {
    document.body.setAttribute('aria-busy', 'true');
    const hardStop = setTimeout(dismiss, 1900); // ضمانة السقف ≤ ثانيتين
    veil.addEventListener('animationend', (e) => {
      if ((e as AnimationEvent).animationName === 'splash-out') { clearTimeout(hardStop); dismiss(); }
    });
    veil.addEventListener('click', () => { clearTimeout(hardStop); dismiss(); });
    window.addEventListener('keydown', onKey);
  }
}
export {};
