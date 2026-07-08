import { get, post } from './api.js';
import { el, toast } from './ui.js';
import { initials } from './format.js';
import { onLive } from './sse.js';
import { confettiBurst } from './confetti.js';

export interface Me { id: number; name: string; username: string; role: string; department: string; branch: string; photo_url: string; champion_team?: string | null; }

const LOGO = '/assets/brand/logo.png';
const BRAND_NAME = 'الحسني هوم سنتر';

const LINKS = [
  { href: '/index.html', label: 'الرئيسية' },
  { href: '/matches.html', label: 'المباريات' },
  { href: '/leaderboard.html', label: 'الترتيب' },
  { href: '/achievements.html', label: 'الإنجازات' },
  { href: '/profile.html', label: 'حسابي' },
];

export async function initNav(): Promise<Me> {
  const me = await get<Me>('/api/me');
  const host = document.getElementById('nav')!;
  const current = location.pathname === '/' ? '/index.html' : location.pathname;

  const links = LINKS.map(l =>
    el('a', { href: l.href, 'aria-current': current === l.href ? 'page' : null }, l.label));
  if (me.role === 'admin') {
    links.push(el('a', { href: '/admin.html', 'aria-current': current === '/admin.html' ? 'page' : null }, 'الإدارة'));
  }

  const avatar = el('div', { class: 'avatar', title: me.name },
    me.photo_url ? el('img', { src: me.photo_url, alt: me.name }) : initials(me.name));

  host.append(
    el('div', { class: 'container nav-inner' },
      el('a', { class: 'brand', href: '/index.html', 'aria-label': `${BRAND_NAME} — الرئيسية` },
        el('img', { class: 'brand-logo', src: LOGO, alt: BRAND_NAME }),
        el('span', { class: 'brand-sep', 'aria-hidden': 'true' }),
        el('span', { class: 'brand-app' }, 'تحدي كأس العالم', el('small', {}, '٢٠٢٦'))),
      el('nav', { class: 'nav-links', 'aria-label': 'التنقل الرئيسي' }, ...links),
      el('div', { class: 'nav-side' },
        bellLink(),
        el('button', { class: 'btn btn-ghost btn-sm', onclick: logout }, 'خروج'),
        el('a', { href: '/profile.html', 'aria-label': 'الملف الشخصي' }, avatar))));

  // التذييل الموقّع — يُبنى تلقائياً في كل صفحة فيها شريط علوي
  document.body.append(
    el('footer', { class: 'site-footer' },
      el('div', { class: 'container footer-inner' },
        el('img', { src: LOGO, alt: BRAND_NAME }),
        el('span', {}, `© ٢٠٢٦ شركة ${BRAND_NAME} — تحدي كأس العالم`))));

  // تنبيهات حيّة في كل الصفحات
  onLive('notification', (n: { title: string; priority?: string }) => {
    toast(`📣 ${n.title}`, n.priority === 'critical' ? 'err' : n.priority === 'high' ? 'gold' : '', 6000);
    bumpBadge(1);
    document.dispatchEvent(new CustomEvent('ahc:notifications'));
  });
  onLive('notifications_changed', () => { refreshNotifBadge(); document.dispatchEvent(new CustomEvent('ahc:notifications')); });
  onLive('tournament_finished', (w: { champion: string; points: number }) => {
    toast(`🏆 اكتملت البطولة! توّج ${w.champion} بطلاً بـ ${w.points} نقطة — قاعة المجد فُتحت 🏛`, 'gold', 10000);
    confettiBurst(); setTimeout(confettiBurst, 500); setTimeout(confettiBurst, 1100);
  });
  onLive('score_update', (p: { points: number; reason: string }) => {
    toast(`${p.points > 0 ? '🎯' : '⚽'} ${p.reason} — ${p.points > 0 ? '+' : ''}${p.points} نقطة`,
      p.points > 0 ? 'ok' : '', 6000);
  });
  refreshNotifBadge();
  onLive('achievement', (a: { name: string; rarity?: string; icon?: string }) => {
    const flair = a.rarity === 'legendary' ? ' — أسطوري! 👑' : a.rarity === 'epic' ? ' 💎' : '';
    toast(`${a.icon ?? '🏅'} إنجاز جديد: ${a.name}${flair}`, 'gold', 6500);
    confettiBurst();
    if (a.rarity === 'legendary') setTimeout(confettiBurst, 450);
  });

  return me;
}

async function logout(): Promise<void> {
  try { await post('/api/logout'); } catch { /* noop */ }
  location.href = '/login.html';
}


/* ─── جرس الإشعارات بعدّاد غير المقروء (حي عبر SSE، بلا polling) ─── */
let badgeEl: HTMLElement | null = null;
let badgeCount = 0;

function bellLink(): HTMLElement {
  badgeEl = el('span', { class: 'nav-badge', hidden: '' });
  return el('a', { class: 'nav-bell', href: '/notifications.html', 'aria-label': 'مركز الإشعارات' }, '🔔', badgeEl);
}

function renderBadge(): void {
  if (!badgeEl) return;
  if (badgeCount > 0) {
    badgeEl.textContent = badgeCount > 99 ? '+٩٩' : String(badgeCount);
    badgeEl.removeAttribute('hidden');
    badgeEl.setAttribute('aria-label', `${badgeCount} إشعاراً غير مقروء`);
  } else badgeEl.setAttribute('hidden', '');
}

function bumpBadge(n: number): void { badgeCount = Math.max(0, badgeCount + n); renderBadge(); }

export async function refreshNotifBadge(): Promise<void> {
  try {
    const r = await get<{ unread: number }>('/api/notifications/unread-count');
    badgeCount = r.unread; renderBadge();
  } catch { /* غير مسجّل */ }
}

export function setNotifBadge(n: number): void { badgeCount = Math.max(0, n); renderBadge(); }
