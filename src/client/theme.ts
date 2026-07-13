/** منظومة الثيم — فاتح/داكن.
 *  الحقيقة الواحدة: سمة data-theme على <html> (يضبطها سكربت الرأس قبل CSS فلا وميض).
 *  التفضيل محفوظ في localStorage("ahc-theme")؛ عند غيابه نتبع نظام التشغيل حيّاً.
 *  متزامن بين التبويبات عبر حدث storage. */

export type Theme = 'light' | 'dark';

const KEY = 'ahc-theme';
const LABELS: Record<Theme, string> = {
  light: 'التبديل إلى الوضع الداكن',
  dark: 'التبديل إلى الوضع الفاتح',
};

export function currentTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function storedTheme(): Theme | null {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : null;
  } catch { return null; }
}

export function applyTheme(theme: Theme, persist = true): void {
  document.documentElement.setAttribute('data-theme', theme);
  if (persist) { try { localStorage.setItem(KEY, theme); } catch { /* خصوصية صارمة */ } }
  document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]').forEach(paintButton);
  document.dispatchEvent(new CustomEvent('ahc:theme', { detail: { theme } }));
}

export function toggleTheme(): void {
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}

function paintButton(btn: HTMLButtonElement): void {
  const t = currentTheme();
  btn.textContent = t === 'dark' ? '☀️' : '🌙'; // الأيقونة = الوضع الذي سينقل إليه الزر
  btn.setAttribute('aria-label', LABELS[t]);
  btn.title = LABELS[t];
}

/** زر تبديل جاهز — للشريط العلوي أو عائماً (مرّر 'theme-fab'). */
export function themeToggle(extraClass = ''): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `btn btn-icon btn-ghost btn-sm theme-toggle ${extraClass}`.trim();
  btn.setAttribute('data-theme-toggle', '');
  btn.addEventListener('click', toggleTheme);
  paintButton(btn);
  return btn;
}

/* تغيّر تفضيل النظام — يُتَّبع فقط ما دام المستخدم لم يختر بنفسه */
const osLight = matchMedia('(prefers-color-scheme: light)');
osLight.addEventListener?.('change', (e) => {
  if (!storedTheme()) applyTheme(e.matches ? 'light' : 'dark', false);
});

/* مزامنة فورية بين التبويبات المفتوحة */
addEventListener('storage', (e) => {
  if (e.key === KEY && (e.newValue === 'light' || e.newValue === 'dark')) {
    applyTheme(e.newValue, false);
  }
});
