import { get, post } from '../api.js';
import { el, toast, emptyState, skeletonDashboard } from '../ui.js';
import { flagEl } from '../flags.js';
import { kickoffLabel, nf, initials } from '../format.js';
import { mountCountdown } from '../countdown.js';
import { initNav } from '../nav.js';
import { openPrediction, myPredictionChip, MatchView } from '../predict.js';
import { onLive } from '../sse.js';

interface Dash {
  user: any; next_match: MatchView | null; matches: MatchView[]; recent: MatchView[];
  my_stats: { points: number; rank: number | null; total_players: number; exact: number; accuracy: number | null; scored: number };
  achievements: { code: string; name: string; desc: string }[];
  company: { employees: number; predictions: number; exact_total: number };
  notifications: { id: number; title: string; body: string; created_at: string; read: number }[];
  champion: { picked: string | null; lock_utc: string | null; locked: boolean };
}

const main = document.getElementById('app')!;
let stopCd: (() => void) | null = null;

const AWARD_ICONS: Record<string, string> = {
  PERFECT: '🎯', SNIPER: '🔫', STREAK3: '🔥', EXPERT: '🧠', CHAMPION: '🔮', LEGEND: '👑',
};

async function load(): Promise<void> {
  if (!main.dataset.loaded) main.replaceChildren(skeletonDashboard());
  const d = await get<Dash>('/api/dashboard');
  main.dataset.loaded = '1';
  stopCd?.();
  main.innerHTML = '';

  // ─── hero: next match ───
  if (d.next_match) {
    const m = d.next_match;
    const cdHost = el('div');
    const predictBtn = el('button', { class: 'btn btn-primary', onclick: () => openPrediction(m, () => load()) },
      m.my_prediction ? 'تعديل توقعي' : 'سجّل توقعك الآن') as HTMLButtonElement;
    if (!m.teams_set) { predictBtn.disabled = true; predictBtn.textContent = 'بانتظار تحديد الفريقين'; }

    const rk = d.my_stats;
    const hero = el('section', { class: 'hero rise' },
      el('span', { class: 'eyebrow hero-brand' }, 'الحسني هوم سنتر — تحدي كأس العالم ٢٠٢٦'),
      el('span', { class: 'chip crimson stage-chip' }, `${m.stage_ar} · ×${m.multiplier}`),
      el('div', { class: 'hero-teams' },
        el('div', { class: 'hero-team' }, flagEl(m.home_team, 'lg'), el('b', {}, m.home_name)),
        el('div', { class: 'hero-vs' }, 'VS'),
        el('div', { class: 'hero-team' }, flagEl(m.away_team, 'lg'), el('b', {}, m.away_name))),
      cdHost,
      el('p', { class: 'hero-kickoff' }, kickoffLabel(m.kickoff_utc)),
      el('div', { class: 'hero-cta' },
        predictBtn,
        el('a', { class: 'btn btn-ghost', href: '/matches.html' }, 'كل المباريات')),
      m.my_prediction ? el('div', { style: 'margin-top:16px;display:flex;justify-content:center' }, myPredictionChip(m)) : null,
      rk.rank ? el('a', { class: 'chip hero-rank', href: '/leaderboard.html' },
        `ترتيبك #${nf.format(rk.rank)} من ${nf.format(rk.total_players)} — عرض الصدارة`) : null);
    main.append(hero);
    stopCd = mountCountdown(cdHost, m.kickoff_utc, { onDone: () => setTimeout(load, 1500) });
  } else {
    main.append(el('section', { class: 'hero rise' },
      el('h1', {}, 'انتهت مباريات البطولة 🏁'),
      el('p', { class: 'hero-kickoff' }, 'تابع حفل التتويج والنتائج النهائية'),
      el('div', { class: 'hero-cta' }, el('a', { class: 'btn btn-primary', href: '/ceremony.html' }, 'حفل التتويج'))));
  }

  // ─── stats strip ───
  const s = d.my_stats;
  main.append(el('section', { class: 'stats-strip rise-2', style: 'margin-top:18px' },
    statCard(s.rank ? `#${nf.format(s.rank)}` : '—', `ترتيبك من ${nf.format(s.total_players)}`),
    statCard(nf.format(s.points), 'نقاطك'),
    statCard(s.accuracy === null ? '—' : `${nf.format(s.accuracy)}٪`, 'دقة التوقع'),
    statCard(nf.format(s.exact), 'نتائج دقيقة')));

  // ─── two-column grid ───
  const left = el('div', { class: 'grid' });
  const right = el('div', { class: 'grid' });

  // champion pick
  left.append(await championCard(d));

  // recent results
  if (d.recent.length) {
    const c = el('div', { class: 'card' },
      el('div', { class: 'card-title' }, el('h3', {}, 'آخر النتائج'), el('a', { href: '/matches.html' }, 'الكل')));
    for (const m of d.recent) {
      c.append(el('div', { class: 'mini-match' },
        el('span', { class: 'mini-name e' }, m.home_name), flagEl(m.home_team, 'sm', false),
        el('b', { class: 'mini-score num' }, `${m.home_score} - ${m.away_score}`),
        flagEl(m.away_team, 'sm', false), el('span', { class: 'mini-name s' }, m.away_name),
        (m.my_prediction?.points_total ?? 0) > 0
          ? el('span', { class: 'chip ok' }, `+${m.my_prediction!.points_total}`)
          : m.my_prediction ? el('span', { class: 'chip' }, '٠') : null));
    }
    left.append(c);
  }

  // achievements
  const aw = el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h3', {}, 'إنجازاتك')));
  if (d.achievements.length) {
    aw.append(el('div', { class: 'awards' }, ...d.achievements.map(a =>
      el('div', { class: 'award' },
        el('span', { class: 'award-ico' }, AWARD_ICONS[a.code] || '🏅'),
        el('span', {}, el('b', {}, a.name), el('small', {}, a.desc))))));
  } else {
    aw.append(emptyState({
      icon: '🎯', title: 'لا إنجازات بعد',
      msg: 'أول وسام يُفتح مع أول توقع صحيح — سبعة أوسمة بانتظارك',
      action: { label: 'توقّع الآن', href: '/matches.html' },
    }));
  }
  right.append(aw);

  // company pulse
  right.append(el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h3', {}, 'نبض الشركة')),
    el('div', { class: 'grid', style: 'grid-template-columns:1fr 1fr 1fr' },
      statCard(nf.format(d.company.employees), 'مشارك', true),
      statCard(nf.format(d.company.predictions), 'توقع', true),
      statCard(nf.format(d.company.exact_total), 'نتيجة دقيقة', true))));

  // notifications
  const unread = d.notifications.filter(n => !n.read);
  const nc = el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h3', {}, 'الإشعارات'),
      unread.length ? el('span', { class: 'chip crimson' }, nf.format(unread.length)) : null));
  if (d.notifications.length) {
    for (const n of d.notifications) {
      nc.append(el('div', { style: `padding:10px 2px;border-bottom:1px solid rgba(158,141,135,.09);${n.read ? 'opacity:.65' : ''}` },
        el('b', { style: 'font-size:var(--text-sm);display:block' }, n.title),
        n.body ? el('span', { style: 'font-size:var(--text-xs);color:var(--muted)' }, n.body) : null));
    }
    if (unread.length) post('/api/notifications/read', { ids: unread.map(n => n.id) }).catch(() => {});
  } else nc.append(emptyState({
    icon: '📣', title: 'صندوقك هادئ',
    msg: 'إشعارات الإدارة تصلك هنا فور إرسالها — وتنبيه حي يظهر مباشرة',
    action: { label: 'تحديث', onclick: () => load() },
  }));
  right.append(nc);

  main.append(el('section', { class: 'dash-grid rise-3', style: 'margin-top:18px' }, left, right));
}

function statCard(value: string, label: string, flat = false): HTMLElement {
  return el('div', { class: flat ? 'stat' : 'card stat hover' }, el('b', { class: 'num' }, value), el('span', {}, label));
}

async function championCard(d: Dash): Promise<HTMLElement> {
  const c = el('div', { class: 'card' },
    el('div', { class: 'card-title' },
      el('h3', {}, '🔮 توقع بطل كأس العالم'),
      el('span', { class: 'chip gold' }, '+١٠ نقاط')));
  const picked = d.champion.picked;
  if (d.champion.locked) {
    c.append(picked
      ? el('div', { class: 'mc-my', style: 'justify-content:flex-start' }, 'اخترت:', el('b', {}, teamName(picked)))
      : el('div', { class: 'empty' }, 'أُغلق توقع البطل'));
    return c;
  }
  const teams = await get<{ code: string; name_ar: string }[]>('/api/teams');
  const row = el('div', { style: 'display:flex;flex-wrap:wrap;gap:8px' });
  for (const t of teams) {
    const b = el('button', { class: `pen-btn ${picked === t.code ? 'on' : ''}`, style: 'flex:1 1 110px;display:flex;align-items:center;gap:8px;justify-content:center' },
      flagEl(t.code, 'sm', false), t.name_ar);
    b.onclick = async () => {
      await post('/api/champion', { team: t.code });
      toast(`اخترت ${t.name_ar} بطلاً 🔮`, 'ok');
      row.querySelectorAll('.pen-btn').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
    };
    row.append(b);
  }
  c.append(row);
  if (d.champion.lock_utc) {
    c.append(el('p', { style: 'margin-top:12px;font-size:var(--text-xs);color:var(--muted)' },
      'يُقفل الاختيار عند انطلاق أول مباراة بربع النهائي'));
  }
  return c;
}

const TEAM_NAMES: Record<string, string> = { FRA: 'فرنسا', MAR: 'المغرب', ESP: 'إسبانيا', BEL: 'بلجيكا', NOR: 'النرويج', ENG: 'إنكلترا', ARG: 'الأرجنتين', SUI: 'سويسرا' };
const teamName = (c: string) => TEAM_NAMES[c] || c;

initNav().then(() => load()).then(() => {
  try {
    const name = sessionStorage.getItem('ahc-welcome');
    if (name) {
      sessionStorage.removeItem('ahc-welcome');
      toast(`أهلاً بك ${name} 👋 هذا أول دخول لك — سجّل توقعك الأول واصعد لوحة الصدارة`, 'ok', 7000);
    }
  } catch { /* noop */ }
});
onLive('match_result', () => load());
onLive('matches_changed', () => load());
