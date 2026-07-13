import { get } from '../api.js';
import { el, emptyState } from '../ui.js';
import { initials, nf } from '../format.js';
import { fireworks, confettiBurst } from '../confetti.js';
import { themeToggle } from '../theme.js';

document.body.append(themeToggle('theme-fab'));

interface CereRow { id: number; name: string; branch: string | null; department: string; photo_url: string; points: number; exact_count: number; accuracy: number; rank: number; achievements: string[]; }
interface Cere { world_champion: { code: string; name: string } | null; podium: CereRow[]; hall_of_fame: CereRow[]; preview: boolean; }

const root = document.getElementById('app')!;
const params = new URLSearchParams(location.search);

async function load(): Promise<void> {
  let d: Cere;
  try {
    d = await get<Cere>(`/api/ceremony${params.get('preview') === '1' ? '?preview=1' : ''}`);
  } catch {
    root.append(el('div', { class: 'ceremony' },
      el('p', { class: 'cere-sub' }, 'الحسني هوم سنتر'),
      el('h1', { class: 'cere-title' }, 'الحفل يُفتح بعد المباراة النهائية'),
      el('a', { class: 'btn btn-ghost', href: '/index.html', style: 'justify-self:center' }, 'عودة للرئيسية')));
    return;
  }

  const medals = ['🥇', '🥈', '🥉'];
  const pods = d.podium.map((r, i) =>
    el('div', { class: `pod pod-${i + 1} cere-pod` },
      el('span', { class: 'pod-medal' }, medals[i]),
      el('div', { class: 'avatar', style: 'margin:0 auto 10px' },
        r.photo_url ? el('img', { src: r.photo_url, alt: r.name }) : initials(r.name)),
      el('b', { style: 'display:block;font-size:var(--text-md)' }, r.name),
      el('small', { style: 'color:var(--muted)' }, r.branch || ''),
      el('div', { class: 'pod-pts num' }, nf.format(r.points)),
      el('small', { style: 'color:var(--muted)' }, `${nf.format(r.exact_count)} نتيجة دقيقة`),
      el('div', { class: 'pod-block' })));

  root.append(el('div', { class: 'ceremony' },
    el('div', {},
      el('img', { class: 'cere-logo', src: '/assets/brand/logo.png', alt: 'الحسني هوم سنتر' }),
      el('p', { class: 'cere-sub' }, 'تحدي كأس العالم ٢٠٢٦'),
      el('h1', { class: 'cere-title', style: 'margin-top:10px' }, d.preview ? 'معاينة حفل التتويج' : 'حفل تتويج الأبطال'),
      d.world_champion ? el('p', { style: 'margin-top:14px;color:var(--muted)' }, 'بطل العالم: ', el('b', { class: 'champ-name', style: 'font-size:var(--text-lg)' }, d.world_champion.name)) : null),
    d.podium.length ? el('div', { class: 'cere-podium' }, ...pods) : emptyState({
      icon: '🎖', title: 'المنصّة بانتظار أبطالها',
      msg: 'حين تكتمل النتائج تُتوَّج المراكز الثلاثة الأولى هنا',
      action: { label: 'عرض الترتيب', href: '/leaderboard.html' },
    }),
    d.podium[0] ? el('div', {},
      el('p', { class: 'cere-sub' }, 'بطل التحدي'),
      el('div', { class: 'champ-name' }, d.podium[0].name)) : null,
    el('div', { style: 'display:flex;gap:12px;justify-content:center;flex-wrap:wrap' },
      el('button', { class: 'btn btn-primary', onclick: () => { document.documentElement.requestFullscreen?.(); fireworks(6000); } }, '🎬 وضع العرض للإدارة'),
      el('a', { class: 'btn btn-ghost', href: '/leaderboard.html' }, 'الترتيب الكامل')),
    hallOfFame(d.hall_of_fame)));

  // staged reveal: 3rd → 2nd → 1st
  const order = [2, 1, 0];
  order.forEach((podIdx, step) => {
    const node = pods[podIdx];
    if (!node) return;
    setTimeout(() => {
      node.classList.add('show');
      if (podIdx === 0) { fireworks(5200); confettiBurst(); }
    }, 900 + step * 1400);
  });
}

function hallOfFame(rows: CereRow[]): HTMLElement {
  if (!rows.length) return el('div');
  return el('div', { style: 'margin-top:20px' },
    el('p', { class: 'cere-sub', style: 'margin-bottom:16px' }, 'لوحة الشرف'),
    el('div', { class: 'fof' }, ...rows.map(r =>
      el('div', { class: 'card', style: 'display:flex;gap:12px;align-items:center;padding:14px' },
        el('b', { class: 'rank-no num' }, nf.format(r.rank)),
        el('div', { class: 'avatar' }, r.photo_url ? el('img', { src: r.photo_url, alt: r.name }) : initials(r.name)),
        el('div', { style: 'flex:1;min-width:0' },
          el('b', { style: 'display:block;font-size:var(--text-sm);overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, r.name),
          el('small', { style: 'color:var(--muted)' }, r.branch || '')),
        el('b', { class: 'num', style: 'color:var(--gold-hi)' }, nf.format(r.points))))));
}

load();
