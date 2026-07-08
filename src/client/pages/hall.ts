import { get } from '../api.js';
import { el, emptyState, skeletonBoard } from '../ui.js';
import { dateTimeFull, nf, initials } from '../format.js';
import { initNav } from '../nav.js';
import { onLive } from '../sse.js';
import { fireworks, confettiBurst } from '../confetti.js';

interface Hall {
  completed_at: string;
  champion_id: number | null; champion_name: string; champion_branch: string | null; champion_department: string | null;
  champion_points: number; champion_accuracy: number; champion_exact: number; champion_achievements: string[];
  runner_name: string | null; runner_branch: string | null; runner_department: string | null;
  runner_points: number | null; runner_accuracy: number | null; runner_exact: number | null; runner_achievements: string[];
  third_name: string | null; third_branch: string | null; third_department: string | null;
  third_points: number | null; third_accuracy: number | null; third_exact: number | null; third_achievements: string[];
  winning_branch: string | null; winning_department: string | null;
}
interface Res { tournament: string; completed_at: string | null; reopened: boolean; hall: Hall | null;
  award_meta: Record<string, { name: string; icon: string; rarity: string }>; }

const main = document.getElementById('app')!;
let host: HTMLElement;

async function render(): Promise<void> {
  const d = await get<Res>('/api/hall');
  host.innerHTML = '';

  if (!d.hall) {
    host.append(el('div', { class: 'card rise-2' }, emptyState({
      icon: '🏛', title: 'القاعة تنتظر أبطالها',
      msg: 'حين تُدخل الإدارة نتيجة النهائي، تُنقش هنا أسماء الفائزين للأبد',
      action: { label: 'تابع الترتيب الحي', href: '/leaderboard.html' } })));
    return;
  }
  const h = d.hall;

  host.append(el('section', { class: 'card card-hero rise-2', style: 'text-align:center' },
    el('p', { class: 'eyebrow' }, d.tournament),
    el('h2', { style: 'font-size:var(--text-xl);margin:4px 0' }, '🏛 قاعة المجد'),
    d.reopened
      ? el('span', { class: 'chip chip-danger' }, '⚠ أُعيد فتح البطولة — السجل قيد المراجعة')
      : el('span', { class: 'chip gold num' }, `تُوّج ${dateTimeFull(h.completed_at)}`),
    el('div', { class: 'u-center u-gap-3 u-wrap', style: 'margin-top:var(--s-3)' },
      h.winning_branch ? el('span', { class: 'chip crimson' }, `🏬 الفرع الفائز: ${h.winning_branch}`) : null,
      h.winning_department ? el('span', { class: 'chip crimson' }, `🗂 القسم الفائز: ${h.winning_department}`) : null)));

  const winners: [string, string, string | null, string | null, string | null, number | null, number | null, number | null, string[]][] = [
    ['🏆', 'بطل التحدي', h.champion_name, h.champion_branch, h.champion_department, h.champion_points, h.champion_accuracy, h.champion_exact, h.champion_achievements],
    ['🥈', 'الوصيف', h.runner_name, h.runner_branch, h.runner_department, h.runner_points, h.runner_accuracy, h.runner_exact, h.runner_achievements],
    ['🥉', 'المركز الثالث', h.third_name, h.third_branch, h.third_department, h.third_points, h.third_accuracy, h.third_exact, h.third_achievements],
  ];

  host.append(el('div', { class: 'hall-grid rise-3' },
    ...winners.filter(w => w[2]).map(([medal, title, name, branch, dept, pts, acc, exact, achs], i) =>
      el('article', { class: `card champ-card ${i === 0 ? 'champ-gold' : ''}` },
        el('div', { class: 'champ-medal' }, medal),
        el('div', { class: 'avatar', style: 'width:56px;height:56px;font-size:1.1rem;margin:0 auto' }, initials(name!)),
        el('p', { class: 'eyebrow', style: 'margin-top:10px' }, title),
        el('b', { style: 'font-size:var(--text-md);display:block' }, name!),
        el('div', { class: 't-xs t-muted' }, [branch, dept].filter(Boolean).join(' · ') || '—'),
        el('div', { class: 'u-center u-gap-3', style: 'margin:var(--s-3) 0' },
          el('div', { class: 'stat' }, el('b', { class: 'num' }, nf.format(pts ?? 0)), el('span', {}, 'نقطة')),
          el('div', { class: 'stat' }, el('b', { class: 'num' }, nf.format(exact ?? 0)), el('span', {}, 'دقيقة')),
          el('div', { class: 'stat' }, el('b', { class: 'num' }, `${nf.format(acc ?? 0)}٪`), el('span', {}, 'دقة'))),
        el('div', { class: 'u-center u-gap-2 u-wrap' },
          ...achs.slice(0, 8).map(c => {
            const m = d.award_meta[c];
            return m ? el('span', { class: 'chip', style: 'font-size:.66rem', title: m.name }, `${m.icon} ${m.name}`) : null;
          }),
          achs.length > 8 ? el('span', { class: 'chip' }, `+${nf.format(achs.length - 8)}`) : null)))));

  host.append(el('div', { class: 'u-center rise-3', style: 'margin-top:var(--s-5)' },
    el('a', { class: 'btn btn-primary', href: '/ceremony.html' }, '🎬 الاحتفال الختامي'),
    el('a', { class: 'btn btn-ghost', href: '/leaderboard.html', style: 'margin-inline-start:10px' }, 'الترتيب الكامل')));
}

initNav().then(() => {
  main.append(el('div', { class: 'rise', style: 'margin-bottom:18px;text-align:center' }));
  host = el('div', { class: 'rise-2' }, skeletonBoard(3));
  main.append(host);
  render().then(() => {
    if (new URLSearchParams(location.search).get('celebrate') === '1') { fireworks(4500); confettiBurst(); }
  });
  onLive('hall_updated', () => render());
  onLive('tournament_finished', () => { render(); fireworks(5200); confettiBurst(); });
});
