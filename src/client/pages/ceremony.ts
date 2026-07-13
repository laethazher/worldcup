import { get } from '../api.js';
import { el, emptyState } from '../ui.js';
import { initials, nf } from '../format.js';
import { fireworks, confettiBurst } from '../confetti.js';
import { themeToggle } from '../theme.js';
import { mountScene, countUp } from '../ambient.js';

document.body.append(themeToggle('theme-fab'));
mountScene();   // المشهد المحيطي: طبقات نمط الهوية + الإضاءة السينمائية + الغبار الذهبي

interface CereRow { id: number; name: string; branch: string | null; department: string; photo_url: string; points: number; exact_count: number; accuracy: number; rank: number; achievements: string[]; }
interface Cere { world_champion: { code: string; name: string } | null; podium: CereRow[]; hall_of_fame: CereRow[]; preview: boolean; }

const root = document.getElementById('app')!;
const params = new URLSearchParams(location.search);

/* ─── الكأس: الصورة الفوتوغرافية الحقيقية بشفافية كاملة ───
   public/assets/brand/worldcup.png — أُزيلت خلفيتها عبر tools/remove-trophy-bg.ps1 */
const TROPHY_IMG = '/assets/brand/worldcup.png';

const CROWN_SVG = `<svg viewBox="0 0 40 27" role="img" aria-hidden="true">
  <path class="crown-body" d="M3 22 6 7l8 7 6-12 6 12 8-7 3 15Z"/>
  <rect class="crown-band" x="4" y="21" width="32" height="4.5" rx="2.2"/>
  <circle class="crown-gem" cx="20" cy="15" r="2.6"/>
</svg>`;

function spark(dur: string, delay: string, pos: string): HTMLElement {
  return el('i', { class: 'spark', 'aria-hidden': 'true', style: `--tw:${dur};--td:${delay};${pos}` }, '✦');
}

/* منصّة الكأس: عرض متحفي ثلاثي الأبعاد — منظور حقيقي، تأرجح منصّة العرض،
   بريق يجتاز السطح متزامناً مع الميل، ظل يتحرك عكسه، وطفو وتنفّس كما كانا */
function trophyStage(i: number): HTMLElement {
  const img = el('img', {
    class: 'trophy-img', src: TROPHY_IMG, alt: '', draggable: 'false',
    // إن غاب الملف: نخفي المنصّة بأناقة بدل أيقونة صورة مكسورة
    onerror: (e: Event) => (e.target as HTMLElement).closest('.trophy-stage')?.classList.add('no-trophy'),
  });
  return el('div', { class: 'trophy-stage cere-enter', 'aria-hidden': 'true', style: `--i:${i}` },
    el('div', { class: 'trophy-ring' }),
    el('div', { class: 'trophy-shadow' }),
    el('div', { class: 'trophy' },
      el('div', { class: 'trophy-turn' },
        el('div', { class: 'trophy-fit' }, img, el('i', { class: 'trophy-sheen' })))),
    el('div', { class: 'trophy-reflect' }),
    spark('6.5s', '2.1s', 'top:15%;inset-inline-start:24%'),
    spark('8s', '4.6s', 'top:32%;inset-inline-end:18%'),
    spark('7.2s', '6.3s', 'bottom:28%;inset-inline-start:31%'));
}

/* رأس الحفل: اللوغو + سطر تمهيدي مُزخرف + العنوان */
function hero(kicker: string, title: string, ...extra: (HTMLElement | null)[]): HTMLElement {
  return el('div', { class: 'cere-enter', style: '--i:0' },
    el('img', { class: 'cere-logo', src: '/assets/brand/logo.png', alt: 'الحسني هوم سنتر' }),
    el('p', { class: 'cere-kicker' }, kicker),
    el('h1', { class: 'cere-title' }, title),
    ...extra);
}

/* بطاقات الإحصاء — قيم مشتقة حصراً من حمولة ‎/api/ceremony (بلا أي نداء إضافي) */
function statsRow(d: Cere): HTMLElement {
  const champ = d.podium[0];
  const cards: Array<[string, string, number, string]> = [
    ['🏛', 'في لوحة الشرف', d.hall_of_fame.length, ''],
    ['⭐', 'نقاط البطل', champ.points, ''],
    ['🎯', 'توقع دقيق للبطل', champ.exact_count, ''],
    ['📈', 'دقة البطل', Math.round(champ.accuracy), '٪'],
  ];
  const row = el('div', { class: 'cere-stats cere-enter', style: '--i:2' });
  for (const [ico, lbl, val, suffix] of cards) {
    const v = el('b', { class: 'stat-val num' }, nf.format(0));
    row.append(el('div', { class: 'stat-card' },
      el('span', { class: 'stat-ico', 'aria-hidden': 'true' }, ico),
      v,
      el('span', { class: 'stat-lbl' }, lbl)));
    countUp(v, val, n => nf.format(n) + suffix);
  }
  return row;
}

async function load(): Promise<void> {
  let d: Cere;
  try {
    d = await get<Cere>(`/api/ceremony${params.get('preview') === '1' ? '?preview=1' : ''}`);
  } catch {
    // الحالة المقفلة (قبل النهائي): نفس المشهد الفاخر مع رسالة الانتظار
    root.append(el('div', { class: 'ceremony' },
      hero('الحسني هوم سنتر', 'الحفل يُفتح بعد المباراة النهائية'),
      trophyStage(1),
      el('p', { class: 'cere-note cere-enter', style: '--i:2' },
        'حين تُسدَّد آخر صافرة في المونديال تُفتح هذه الأبواب، ويُتوَّج أبطال التوقعات على المنصّة الذهبية'),
      el('div', { class: 'cere-actions cere-enter', style: '--i:3' },
        el('a', { class: 'btn btn-ghost', href: '/index.html' }, 'عودة للرئيسية'))));
    return;
  }

  const medals = ['🥇', '🥈', '🥉'];
  const medalNames = ['المركز الأول', 'المركز الثاني', 'المركز الثالث'];
  const pods = d.podium.map((r, i) =>
    el('div', { class: `pod pod-${i + 1} cere-pod`, role: 'group', 'aria-label': `${medalNames[i]} — ${r.name}` },
      el('span', { class: 'pod-medal', 'aria-hidden': 'true' }, medals[i]),
      i === 0 ? el('span', { class: 'pod-crown', html: CROWN_SVG }) : null,
      el('div', { class: 'avatar', style: 'margin:0 auto 10px' },
        r.photo_url ? el('img', { src: r.photo_url, alt: r.name }) : initials(r.name)),
      el('b', { style: 'display:block;font-size:var(--text-md)' }, r.name),
      el('small', { style: 'color:var(--muted)' }, r.branch || ''),
      el('div', { class: 'pod-pts num' }, nf.format(r.points)),
      el('small', { style: 'color:var(--muted)' }, `${nf.format(r.exact_count)} نتيجة دقيقة`),
      el('div', { class: 'pod-block' })));

  root.append(el('div', { class: 'ceremony' },
    hero('تحدي كأس العالم ٢٠٢٦', d.preview ? 'معاينة حفل التتويج' : 'حفل تتويج الأبطال',
      d.world_champion ? el('p', { class: 'cere-note', style: 'margin-top:14px' }, 'بطل العالم: ',
        el('b', { class: 'champ-name', style: 'font-size:var(--text-lg)' }, d.world_champion.name)) : null),
    trophyStage(1),
    d.podium.length ? statsRow(d) : null,
    d.podium.length ? el('div', { class: 'cere-podium cere-enter', style: '--i:3' }, ...pods) : emptyState({
      icon: '🎖', title: 'المنصّة بانتظار أبطالها',
      msg: 'حين تكتمل النتائج تُتوَّج المراكز الثلاثة الأولى هنا',
      action: { label: 'عرض الترتيب', href: '/leaderboard.html' },
    }),
    d.podium[0] ? el('div', { class: 'cere-enter', style: '--i:4' },
      el('p', { class: 'cere-sub' }, 'بطل التحدي'),
      el('div', { class: 'champ-name' }, d.podium[0].name)) : null,
    el('div', { class: 'cere-actions cere-enter', style: '--i:5' },
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
  return el('div', { style: 'margin-top:20px;width:100%' },
    el('p', { class: 'cere-sub', style: 'margin-bottom:16px' }, 'لوحة الشرف'),
    el('div', { class: 'fof', role: 'list' }, ...rows.map((r, i) =>
      el('div', { class: 'card fof-card', role: 'listitem', style: `--i:${i}` },
        el('b', { class: 'rank-no num' }, nf.format(r.rank)),
        el('div', { class: 'avatar' }, r.photo_url ? el('img', { src: r.photo_url, alt: r.name }) : initials(r.name)),
        el('div', { class: 'fof-meta' },
          el('b', { class: 'fof-name' }, r.name),
          el('small', { style: 'color:var(--muted)' }, r.branch || '')),
        el('b', { class: 'num fof-pts' }, nf.format(r.points))))));
}

load();
