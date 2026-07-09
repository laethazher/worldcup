import { get } from '../api.js';
import { el, skeletonMatchGrid } from '../ui.js';
import { flagEl } from '../flags.js';
import { shortTime, nf } from '../format.js';
import { mountCountdown } from '../countdown.js';
import { initNav } from '../nav.js';
import { openPrediction, myPredictionChip, MatchView } from '../predict.js';
import { onLive } from '../sse.js';

const main = document.getElementById('app')!;
const stops: (() => void)[] = [];
const STAGES: [string, string][] = [['QF', 'ربع النهائي'], ['SF', 'نصف النهائي'], ['BRONZE', 'مباراة المركز الثالث'], ['FINAL', 'المباراة النهائية']];

async function load(): Promise<void> {
  if (!main.dataset.loaded) main.replaceChildren(skeletonMatchGrid(4));
  const matches = await get<MatchView[]>('/api/matches');
  main.dataset.loaded = '1';
  stops.forEach(s => s()); stops.length = 0;
  main.innerHTML = '';

  main.append(el('div', { class: 'rise', style: 'margin-bottom:26px' },
    el('p', { class: 'eyebrow' }, 'الطريق إلى اللقب'),
    el('h1', { style: 'font-size:var(--text-xl)' }, 'مباريات الأدوار النهائية')));

  let riseIdx = 2;
  for (const [code, label] of STAGES) {
    const group = matches.filter(m => m.stage === code);
    if (!group.length) continue;
    const gridEl = el('div', { class: 'match-grid' }, ...group.map(card));
    main.append(el('section', { class: `stage-block rise-${Math.min(riseIdx++, 4)}` },
      el('div', { class: 'stage-head' }, el('h2', {}, label), el('span', { class: 'chip mult' }, `النقاط ×${group[0].multiplier}`)),
      gridEl));
  }
}

function card(m: MatchView): HTMLElement {
  const c = el('div', { class: 'card hover match-card' });

  const status =
    m.status === 'finished' ? el('span', { class: 'chip' }, 'انتهت')
    : m.locked ? el('span', { class: 'chip crimson' }, '🔴 جارية الآن')
    : el('span', { class: 'chip ok' }, 'التوقع مفتوح');

  const badges = el('div', { class: 'mc-badges' }, status);
  if (!m.locked && m.status === 'scheduled' && m.my_prediction) {
    badges.prepend(el('span', { class: 'chip-success chip' }, '✓ توقعك مسجّل'));
  }
  c.append(el('div', { class: 'mc-top' },
    el('span', { class: 'chip' }, `مباراة ${nf.format(m.round_no)}`),
    badges));

  const mid = el('div', { class: 'mc-mid' });
  let cdBlock: HTMLElement | null = null;
  if (m.status === 'finished') {
    mid.append(el('div', { class: 'mc-score' }, `${m.home_score} - ${m.away_score}`));
    if (m.advancing_team && m.home_score === m.away_score) {
      mid.append(el('span', { class: 'chip gold' }, `تأهل بالترجيح: ${m.advancing_team === m.home_team ? m.home_name : m.away_name}`));
    }
  } else {
    // بين الفريقين تبقى «VS» مرتّبة، والعدّاد ينزل لسطر خاص به تحت الفريقين
    mid.append(el('div', { class: 'mc-score', style: 'color:var(--warm)' }, 'VS'));
    if (!m.locked) {
      cdBlock = el('div');
      stops.push(mountCountdown(cdBlock, m.kickoff_utc, { compact: true, onDone: () => setTimeout(load, 1200) }));
    }
  }

  c.append(el('div', { class: 'mc-face' },
    el('div', { class: 'mc-team' }, flagEl(m.home_team), el('b', {}, m.home_name)),
    mid,
    el('div', { class: 'mc-team' }, flagEl(m.away_team), el('b', {}, m.away_name))));
  if (cdBlock) c.append(cdBlock);

  c.append(el('div', { class: 'mc-time' }, `⏱ ${shortTime(m.kickoff_utc)} بتوقيت بغداد · ${m.stage_ar}`));
  if (!m.locked && m.status === 'scheduled') {
    c.append(el('div', { class: 'mc-deadline' }, `⏳ آخر موعد للتوقع — عند صافرة البداية (${shortTime(m.kickoff_utc)})`));
  }

  const myChip = myPredictionChip(m);
  if (myChip) c.append(myChip);

  if (!m.locked && m.status === 'scheduled') {
    const b = el('button', { class: m.my_prediction ? 'btn btn-ghost' : 'btn btn-primary', onclick: () => openPrediction(m, () => load()) },
      m.my_prediction ? 'تعديل التوقع' : 'توقّع النتيجة') as HTMLButtonElement;
    if (!m.teams_set) { b.disabled = true; b.textContent = 'بانتظار تحديد الفريقين'; }
    c.append(b);
  }

  if (m.locked && m.stats && m.stats.total > 0) {
    const s = m.stats;
    const pct = (n: number) => Math.round((n / s.total) * 100);
    c.append(el('div', {},
      el('p', { style: 'font-size:var(--text-xs);color:var(--warm);margin-bottom:8px;font-weight:600' }, `توقعات الزملاء (${nf.format(s.total)})`),
      el('div', { class: 'dist' },
        distRow(m.home_name, pct(s.home)),
        distRow('تعادل', pct(s.draw), true),
        distRow(m.away_name, pct(s.away)))));
  }
  return c;
}

function distRow(label: string, pct: number, neutral = false): HTMLElement {
  const fill = el('div', { class: `dist-fill ${neutral ? 'neutral' : ''}` });
  requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = pct + '%'; }));
  return el('div', { class: 'dist-row' },
    el('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, label),
    el('div', { class: 'dist-track' }, fill),
    el('b', { class: 'num' }, `${nf.format(pct)}٪`));
}

initNav().then(() => load());
onLive('match_result', () => load());
onLive('matches_changed', () => load());