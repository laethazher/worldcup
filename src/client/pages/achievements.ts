import { get } from '../api.js';
import { el, emptyState, skeletonBoard } from '../ui.js';
import { dateTimeFull, nf } from '../format.js';
import { initNav } from '../nav.js';
import { onLive } from '../sse.js';

interface Item {
  code: string; name: string; desc: string; icon: string;
  category: string; rarity: 'common' | 'rare' | 'epic' | 'legendary';
  hidden: boolean; unlocked: boolean; awarded_at: string | null;
  progress: { current: number; target: number; pct: number } | null;
}
interface State { unlocked: number; total_visible: number; hidden_locked: number; items: Item[]; }

const RARITY: Record<string, [string, string]> = {
  common: ['شائع', 'r-common'], rare: ['نادر', 'r-rare'],
  epic: ['ملحمي', 'r-epic'], legendary: ['أسطوري', 'r-legendary'],
};
const CATS: [string, string, string][] = [
  ['prediction', 'التوقعات', '🎯'], ['streak', 'السلاسل', '🔥'], ['accuracy', 'الدقة', '🦅'],
  ['participation', 'المشاركة', '⚽'], ['milestone', 'المحطات', '🎖'], ['tournament', 'البطولة', '👑'],
];

const main = document.getElementById('app')!;
let host: HTMLElement;

async function render(): Promise<void> {
  const d = await get<State>('/api/achievements');
  host.innerHTML = '';

  const pct = d.total_visible + d.hidden_locked
    ? Math.round((d.unlocked / (d.total_visible + d.hidden_locked)) * 100) : 0;
  const rc: Record<string, number> = {};
  for (const i of d.items) if (i.unlocked) rc[i.rarity] = (rc[i.rarity] || 0) + 1;

  host.append(el('section', { class: 'card card-hero rise-2' },
    el('div', { class: 'u-between u-wrap u-gap-3' },
      el('div', {},
        el('p', { class: 'eyebrow' }, 'خزانة الأوسمة'),
        el('b', { style: 'font-size:var(--text-lg)' },
          `${nf.format(d.unlocked)} `, el('span', { class: 't-sm t-muted' }, `من ${nf.format(d.total_visible + d.hidden_locked)} إنجازاً`))),
      el('div', { class: 'u-flex u-gap-2 u-wrap' },
        ...Object.entries(RARITY).filter(([k]) => rc[k]).map(([k, [l, cls]]) =>
          el('span', { class: `chip ${cls}` }, `${l} ×${nf.format(rc[k])}`)))),
    el('div', { style: 'margin-top:var(--s-3)' },
      el('div', { class: 'progress-linear', role: 'progressbar', 'aria-valuenow': String(pct),
        'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'نسبة الإنجازات المفتوحة' },
        el('b', { style: `width:${pct}%` })),
      el('div', { class: 't-xs t-muted', style: 'margin-top:6px' }, `أكملت ${nf.format(pct)}٪ من الرحلة`))));

  if (!d.items.length) {
    host.append(el('div', { class: 'card rise-2' }, emptyState({
      icon: '🏅', title: 'رحلتك تبدأ بتوقع', msg: 'سجّل توقعك الأول وافتح أول وسام',
      action: { label: 'إلى المباريات', href: '/matches.html' } })));
    return;
  }

  for (const [key, label, icon] of CATS) {
    const items = d.items.filter(i => i.category === key);
    if (!items.length) continue;
    items.sort((a, b) => Number(b.unlocked) - Number(a.unlocked));
    host.append(el('section', { class: 'rise-3', style: 'margin-top:var(--s-5)' },
      el('div', { class: 'card-title', style: 'margin-bottom:var(--s-3)' },
        el('h3', {}, `${icon} ${label}`),
        el('span', { class: 'chip' }, `${nf.format(items.filter(i => i.unlocked).length)}/${nf.format(items.length)}`)),
      el('div', { class: 'ach-grid' }, ...items.map(card))));
  }

  if (d.hidden_locked > 0) {
    host.append(el('p', { class: 't-sm t-muted rise-3', style: 'margin-top:var(--s-5);text-align:center' },
      `🔒 ${nf.format(d.hidden_locked)} ${d.hidden_locked === 1 ? 'إنجاز خفي بانتظار اكتشافه' : 'إنجازات خفية بانتظار اكتشافها'}…`));
  }
}

function card(a: Item): HTMLElement {
  const [rl, rcls] = RARITY[a.rarity] ?? RARITY.common;
  return el('article', { class: `card card-compact ach-card ${rcls} ${a.unlocked ? 'ach-open' : 'ach-locked'}` },
    el('div', { class: 'u-flex u-gap-3', style: 'align-items:flex-start' },
      el('span', { class: 'ach-icon', 'aria-hidden': 'true' }, a.icon),
      el('div', { style: 'flex:1;min-width:0' },
        el('div', { class: 'u-flex u-gap-2 u-wrap' },
          el('b', {}, a.name),
          el('span', { class: `chip ${rcls}`, style: 'font-size:.62rem' }, rl),
          a.hidden ? el('span', { class: 'chip', style: 'font-size:.62rem' }, 'كان خفياً 👁') : null),
        el('p', { class: 't-xs t-muted', style: 'margin:4px 0 0' }, a.desc),
        a.unlocked
          ? el('div', { class: 't-xs num', style: 'margin-top:8px;color:var(--gold-hi)' },
              `✓ فُتح ${a.awarded_at ? dateTimeFull(a.awarded_at) : ''}`)
          : a.progress
            ? el('div', { style: 'margin-top:8px' },
                el('div', { class: 'progress-linear', role: 'progressbar',
                  'aria-valuenow': String(a.progress.pct), 'aria-valuemin': '0', 'aria-valuemax': '100',
                  'aria-label': `تقدم ${a.name}` }, el('b', { style: `width:${a.progress.pct}%` })),
                el('div', { class: 't-xs t-muted num', style: 'margin-top:4px' },
                  `${nf.format(a.progress.current)} / ${nf.format(a.progress.target)}`))
            : el('div', { class: 't-xs t-muted', style: 'margin-top:8px' }, '🔒 لم يُفتح بعد'))));
}

initNav().then(() => {
  main.append(el('div', { class: 'rise', style: 'margin-bottom:18px' },
    el('p', { class: 'eyebrow' }, 'مسيرتك بالتحدي'),
    el('h1', { style: 'font-size:var(--text-xl)' }, 'الإنجازات')));
  host = el('div', { class: 'rise-2' }, skeletonBoard(6));
  main.append(host);
  render();
  onLive('achievement', () => render());
  onLive('leaderboard', () => render()); // التقدم يتحرك مع كل احتساب
});
