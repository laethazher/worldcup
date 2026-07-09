import { el, openModal, toast } from './ui.js';
import { post } from './api.js';
import { flagEl } from './flags.js';
import { kickoffLabel } from './format.js';

export interface MatchView {
  id: number; round_no: number; stage: string; stage_ar: string;
  home_team: string | null; away_team: string | null;
  home_name: string; away_name: string; teams_set: boolean;
  kickoff_utc: string; multiplier: number; status: string; locked: boolean;
  home_score: number | null; away_score: number | null; advancing_team: string | null;
  my_prediction: null | { home_score: number; away_score: number; penalty_winner: string | null;
    points_total: number | null; points_base: number | null; points_qual: number | null; is_exact: number | null; is_direction: number | null; };
  stats?: { total: number; home: number; draw: number; away: number; top_scores: { s: string; c: number }[] };
}

function stepper(initial: number, onChange: (v: number) => void): { root: HTMLElement; get: () => number } {
  let v = initial;
  const num = el('div', { class: 'step-num num' }, String(v));
  const root = el('div', { class: `stepper ${initial > 0 ? 'touched' : ''}` });
  const set = (nv: number) => {
    v = Math.max(0, Math.min(15, nv));
    num.textContent = String(v);
    root.classList.add('touched');
    onChange(v);
  };
  root.append(
    num,
    el('div', { class: 'step-btns' },
      el('button', { class: 'step-btn', type: 'button', 'aria-label': 'إنقاص', onclick: () => set(v - 1) }, '−'),
      el('button', { class: 'step-btn', type: 'button', 'aria-label': 'زيادة', onclick: () => set(v + 1) }, '+')));
  return { root, get: () => v };
}

export async function openPrediction(m: MatchView, onSaved: (m: MatchView) => void): Promise<void> {
  let penWinner: string | null = m.my_prediction?.penalty_winner ?? null;
  const penWrap = el('div', { class: 'field', style: 'display:none' },
    el('label', {}, 'تعادل — من يتأهل بركلات الترجيح؟'));
  const penBtns = el('div', { class: 'pen-pick' });
  const mkPen = (code: string, name: string) => {
    const b = el('button', { type: 'button', class: `pen-btn ${penWinner === code ? 'on' : ''}` }, name);
    b.onclick = () => {
      penWinner = code;
      penBtns.querySelectorAll('.pen-btn').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
    };
    return b;
  };
  penBtns.append(mkPen(m.home_team!, m.home_name), mkPen(m.away_team!, m.away_name));
  penWrap.append(penBtns);

  const syncPen = () => {
    const draw = home.get() === away.get();
    penWrap.style.display = draw ? '' : 'none';
  };
  const home = stepper(m.my_prediction?.home_score ?? 0, syncPen);
  const away = stepper(m.my_prediction?.away_score ?? 0, syncPen);

  const save = el('button', { class: 'btn btn-primary', style: 'width:100%' }, 'تأكيد التوقع') as HTMLButtonElement;

  const content = el('div', {},
    el('div', { class: 'chip crimson' }, m.stage_ar),
    el('h2', { style: 'margin-top:12px;font-size:var(--text-lg)' }, 'ما توقعك للنتيجة؟'),
    el('p', { style: 'color:var(--muted);font-size:var(--text-sm);margin-top:2px' }, kickoffLabel(m.kickoff_utc)),
    el('div', { class: 'pm-face' },
      el('div', { class: 'pm-team' }, flagEl(m.home_team), el('b', {}, m.home_name), home.root),
      el('div', { class: 'pm-colon' }, ':'),
      el('div', { class: 'pm-team' }, flagEl(m.away_team), el('b', {}, m.away_name), away.root)),
    penWrap,
    el('div', { style: 'margin-top:18px' }, save),
    el('p', { style: 'text-align:center;color:var(--muted);font-size:var(--text-xs);margin-top:10px' },
      'تكدر تعدّل توقعك حتى صافرة البداية — بعدها يُقفل نهائياً'));

  syncPen();
  const close = openModal(content);

  save.onclick = async () => {
    if (home.get() === away.get() && !penWinner) { toast('اختر المتأهل بركلات الترجيح', 'err'); return; }
    save.classList.add('loading');
    try {
      const res = await post<{ ok: boolean; match: MatchView }>(`/api/matches/${m.id}/prediction`, {
        home_score: home.get(), away_score: away.get(),
        penalty_winner: home.get() === away.get() ? penWinner : null,
      });
      toast('تم حفظ توقعك ✓', 'ok');
      close();
      onSaved(res.match);
    } catch { save.classList.remove('loading'); }
  };
}

/** small renderer for "my prediction" line under a match card */
export function myPredictionChip(m: MatchView): HTMLElement | null {
  const p = m.my_prediction;
  if (!p) return null;
  let cls = '', note = '';
  if (m.status === 'finished') {
    if (p.is_exact) { cls = 'exact'; note = `نتيجة دقيقة! +${p.points_total}`; }
    else if ((p.points_total ?? 0) > 0) { cls = 'hit'; note = `+${p.points_total}`; }
    else { cls = 'miss'; note = 'بدون نقاط'; }
  }
  return el('div', { class: `mc-my ${cls}` },
    el('span', {}, 'توقعك'),
    el('b', { class: 'num', style: 'direction:ltr' }, `${p.home_score} - ${p.away_score}`),
    p.penalty_winner ? el('span', { class: 'chip', style: 'font-size:.7rem' }, 'ترجيح') : null,
    note ? el('span', { style: 'font-weight:700' }, note) : null);
}