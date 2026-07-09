import { get, post, patch } from '../api.js';
import { el, toast, openModal, emptyState, skeletonTable } from '../ui.js';
import { flagEl } from '../flags.js';
import { dateTimeFull, nf } from '../format.js';
import { initNav } from '../nav.js';
import { MatchView } from '../predict.js';
import { usersTab } from './admin-users.js';
import { orgsTab } from './admin-orgs.js';
import { auditTab } from './admin-audit.js';
import { notifyTab } from './admin-notify.js';

const main = document.getElementById('app')!;
type Tab = 'results' | 'people' | 'notify' | 'analytics' | 'audit' | 'settings' | 'orgs';
let tab: Tab = 'results';

const TABS: [Tab, string][] = [
  ['results', 'النتائج والمباريات'], ['people', 'الموظفون'], ['notify', 'الإشعارات'],
  ['analytics', 'التحليلات'], ['audit', 'سجل التدقيق'], ['settings', 'الإعدادات'],
];

async function load(): Promise<void> {
  main.innerHTML = '';
  main.append(el('div', { class: 'rise', style: 'display:grid;gap:16px;margin-bottom:22px' },
    el('div', { style: 'display:flex;flex-wrap:wrap;gap:14px;align-items:end;justify-content:space-between' },
      el('div', {},
        el('p', { class: 'eyebrow' }, 'لوحة الإدارة'),
        el('h1', { style: 'font-size:var(--text-xl)' }, 'إدارة تحدي كأس العالم')),
      el('a', { class: 'btn btn-ghost btn-sm', href: '/ceremony.html?preview=1' }, '🏆 معاينة حفل التتويج')),
    el('div', { class: 'tabs' }, ...TABS.map(([k, l]) =>
      el('button', { class: `tab ${tab === k ? 'on' : ''}`, onclick: () => { tab = k; load(); } }, l)))));

  const body = el('div', { class: 'admin-grid rise-2' });
  main.append(body);
  const sk = skeletonTable(6);
  if (tab !== 'notify') body.append(sk);
  if (tab === 'results') await tabResults(body);
  if (tab === 'people') await tabPeople(body);
  if (tab === 'orgs') await orgsTab(body);
  if (tab === 'notify') await tabNotify(body);
  if (tab === 'analytics') await tabAnalytics(body);
  if (tab === 'audit') await tabAudit(body);
  if (tab === 'settings') await tabSettings(body);
  sk.remove();
}

/* ═══ results & matches ═══ */
async function tabResults(body: HTMLElement): Promise<void> {
  const matches = await get<MatchView[]>('/api/matches');
  const teams = await get<{ code: string; name_ar: string }[]>('/api/teams');

  body.append(el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' },
    el('button', { class: 'btn btn-ghost btn-sm', onclick: async () => { const r = await post<{ players: number }>('/api/admin/recalculate'); toast(`أُعيد الاحتساب لـ ${nf.format(r.players)} مشارك ✓`, 'ok'); } }, '↻ إعادة احتساب النقاط'),
    el('a', { class: 'btn btn-ghost btn-sm', href: '/api/admin/export/leaderboard.csv' }, '⬇ تصدير الترتيب (Excel)'),
    el('a', { class: 'btn btn-ghost btn-sm', href: '/api/admin/export/predictions.csv' }, '⬇ تصدير التوقعات (Excel)')));

  for (const m of matches) body.append(resultCard(m, teams));
}

function resultCard(m: MatchView, teams: { code: string; name_ar: string }[]): HTMLElement {
  const c = el('div', { class: 'card' });
  const head = el('div', { class: 'mc-top', style: 'margin-bottom:14px' },
    el('span', { class: 'chip' }, `مباراة ${nf.format(m.round_no)} · ${m.stage_ar} · ×${m.multiplier}`),
    m.status === 'finished' ? el('span', { class: 'chip ok' }, '✓ سُجّلت النتيجة')
      : m.locked ? el('span', { class: 'chip crimson' }, 'جارية — التوقع مقفل')
      : el('span', { class: 'chip' }, dateTimeFull(m.kickoff_utc)));
  c.append(head);

  if (!m.teams_set) {
    // team assignment for TBD matches
    const selH = teamSelect(teams, m.home_team);
    const selA = teamSelect(teams, m.away_team);
    c.append(el('div', { style: 'display:grid;grid-template-columns:1fr 1fr auto;gap:10px;align-items:end' },
      el('div', { class: 'field' }, el('label', {}, m.home_name || 'المضيف'), selH),
      el('div', { class: 'field' }, el('label', {}, m.away_name || 'الضيف'), selA),
      el('button', { class: 'btn btn-primary btn-sm', onclick: async () => {
        if (!selH.value || !selA.value || selH.value === selA.value) { toast('اختر فريقين مختلفين', 'err'); return; }
        await patch(`/api/admin/matches/${m.id}`, { home_team: selH.value, away_team: selA.value });
        toast('حُدّد الفريقان ✓', 'ok'); load();
      } }, 'حفظ')));
    return c;
  }

  const face = el('div', { style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap' },
    flagEl(m.home_team, 'sm', false), el('b', {}, m.home_name),
    el('span', { style: 'color:var(--warm)' }, '—'),
    el('b', {}, m.away_name), flagEl(m.away_team, 'sm', false));

  const h = el('input', { class: 'input', type: 'number', min: '0', max: '20', value: m.home_score ?? '' }) as HTMLInputElement;
  const a = el('input', { class: 'input', type: 'number', min: '0', max: '20', value: m.away_score ?? '' }) as HTMLInputElement;
  const adv = teamSelect([{ code: m.home_team!, name_ar: m.home_name }, { code: m.away_team!, name_ar: m.away_name }], m.advancing_team, 'المتأهل بالترجيح');
  adv.style.display = 'none';
  const syncAdv = () => { adv.style.display = h.value !== '' && h.value === a.value ? '' : 'none'; };
  h.oninput = syncAdv; a.oninput = syncAdv; syncAdv();

  const saveBtn = el('button', { class: 'btn btn-primary btn-sm', onclick: async () => {
    const payload: any = { home_score: Number(h.value), away_score: Number(a.value) };
    if (h.value === a.value) payload.advancing_team = adv.value || null;
    await post(`/api/admin/matches/${m.id}/result`, payload);
    toast('سُجّلت النتيجة واحتُسبت النقاط ✓', 'ok');
    load();
  } }, m.status === 'finished' ? 'تعديل النتيجة' : 'اعتماد النتيجة');

  c.append(el('div', { class: 'result-row' },
    face,
    el('div', { class: 'score-inline' }, h, el('b', {}, ':'), a, adv, saveBtn)));
  return c;
}

function teamSelect(teams: { code: string; name_ar: string }[], val: string | null, placeholder = 'اختر المنتخب'): HTMLSelectElement {
  const s = el('select', { class: 'input' }) as HTMLSelectElement;
  s.append(el('option', { value: '' }, placeholder));
  for (const t of teams) s.append(el('option', { value: t.code, selected: val === t.code ? '' : null }, t.name_ar));
  return s;
}

/* ═══ employees → admin-users.ts ═══ */
async function tabPeople(body: HTMLElement): Promise<void> {
  await usersTab(body);
}

/* ═══ notifications → admin-notify.ts ═══ */
async function tabNotify(body: HTMLElement): Promise<void> {
  await notifyTab(body);
}

/* ═══ analytics ═══ */
async function tabAnalytics(body: HTMLElement): Promise<void> {
  const a = await get<any>('/api/admin/analytics');

  body.append(el('div', { class: 'stats-strip' },
    el('div', { class: 'card stat' }, el('b', { class: 'num' }, nf.format(a.totals.employees)), el('span', {}, 'مشارك')),
    el('div', { class: 'card stat' }, el('b', { class: 'num' }, nf.format(a.totals.predictions)), el('span', {}, 'توقع مسجّل')),
    el('div', { class: 'card stat' }, el('b', { class: 'num' }, nf.format(a.totals.exact)), el('span', {}, 'نتيجة دقيقة')),
    el('div', { class: 'card stat' }, el('b', { class: 'num' }, nf.format(a.totals.avg_points)), el('span', {}, 'معدل النقاط'))));

  // participation per match
  const part = el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h3', {}, 'نسبة المشاركة في كل مباراة')),
    el('div', { class: 'bars' }, ...a.per_match.map((m: any) => {
      const fill = el('div', { class: 'bar-fill' });
      requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = m.participation + '%'; }));
      return el('div', { class: 'bar-row' },
        el('span', { style: 'font-size:var(--text-xs)' }, `${nf.format(m.round_no)} · ${m.home} × ${m.away}`),
        el('div', { class: 'bar-track' }, fill),
        el('b', { class: 'num' }, `${nf.format(m.participation)}٪`));
    })));

  // most predicted + champion votes
  const mkBarCard = (title: string, rows: { name: string; c: number }[], gold = false) => {
    const max = Math.max(...rows.map((r: any) => r.c), 1);
    return el('div', { class: 'card' },
      el('div', { class: 'card-title' }, el('h3', {}, title)),
      rows.length ? el('div', { class: 'bars' }, ...rows.map((r: any) => {
        const fill = el('div', { class: `bar-fill ${gold ? 'gold' : 'warm'}` });
        requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = (r.c / max * 100) + '%'; }));
        return el('div', { class: 'bar-row' }, el('span', {}, r.name), el('div', { class: 'bar-track' }, fill), el('b', { class: 'num' }, nf.format(r.c)));
      })) : emptyState({
        icon: '📊', title: 'لا بيانات بعد',
        msg: 'تظهر المخططات فور تسجيل التوقعات والنتائج الأولى',
        action: { label: 'إدخال النتائج', onclick: () => { tab = 'results'; load(); } },
      }));
  };

  body.append(el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px' },
    part,
    mkBarCard('أكثر المنتخبات ثقةً', a.most_predicted),
    mkBarCard('من يتوقعه الموظفون بطلاً؟', a.champion_votes, true)));
}

/* ═══ audit → admin-audit.ts ═══ */
async function tabAudit(body: HTMLElement): Promise<void> {
  await auditTab(body);
}

/* ═══ settings ═══ */
async function tabSettings(body: HTMLElement): Promise<void> {
  const s = await get<any>('/api/admin/settings');
  const c = await get<any>('/api/admin/scoring-config');
  const t = await get<any>('/api/admin/tournament');

  const done = !!t.completed_at;
  const tCard = el('div', { class: 'card', style: 'max-width:680px;margin-bottom:var(--s-4)' },
    el('div', { class: 'card-title' }, el('h3', {}, '🏁 حالة البطولة'),
      done ? el('span', { class: 'chip gold' }, 'مكتملة ومُقفلة') : el('span', { class: 'chip ok' }, 'جارية')),
    done ? el('div', { class: 'grid' },
      el('p', { class: 't-sm t-muted num' }, `اكتملت: ${dateTimeFull(t.completed_at)}`),
      t.hall ? el('p', { class: 't-sm' }, `🥇 ${t.hall.champion_name} (${nf.format(t.hall.champion_points)}) · 🥈 ${t.hall.runner_name ?? '—'} · 🥉 ${t.hall.third_name ?? '—'}`) : null,
      el('div', { class: 'u-flex u-gap-2 u-wrap' },
        el('a', { class: 'btn btn-ghost btn-sm', href: '/hall.html' }, '🏛 قاعة المجد'),
        el('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
          const r = await post<any>('/api/admin/tournament/regenerate-winners', {});
          toast(`أُعيد توليد الفائزين: ${r.winners.map((w: any) => w.name).join(' · ')} ✓`, 'ok');
          load();
        } }, '♻ إعادة توليد الفائزين'),
        el('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
          await post('/api/admin/recalculate', { force: true });
          toast('فُرض إعادة الاحتساب ✓', 'ok');
        } }, '⚡ فرض إعادة الاحتساب'),
        el('button', { class: 'btn btn-danger btn-sm', onclick: () => {
          const inp = el('input', { class: 'input', placeholder: 'إعادة فتح', dir: 'rtl' }) as HTMLInputElement;
          const go = el('button', { class: 'btn btn-danger' }, 'إعادة فتح البطولة') as HTMLButtonElement;
          const close = openModal(el('div', { class: 'grid' },
            el('h2', { style: 'font-size:var(--text-lg)' }, 'إعادة فتح البطولة؟'),
            el('p', { class: 't-sm t-muted' }, 'يُرفع القفل وتصبح النتائج قابلة للتعديل، ويُعاد توليد الفائزين والكؤوس عند الإكمال التالي. اكتب «إعادة فتح» للتأكيد.'),
            el('div', { class: 'field' }, el('label', {}, 'التأكيد'), inp), go));
          go.onclick = async () => {
            go.classList.add('loading');
            try { await post('/api/admin/tournament/reopen', { confirm: inp.value }); toast('أُعيد فتح البطولة', 'ok'); close(); load(); }
            catch { go.classList.remove('loading'); }
          };
        } }, '🔓 إعادة فتح')))
      : el('p', { class: 't-sm t-muted' }, 'تُقفل البطولة تلقائياً لحظة إدخال نتيجة النهائي: فائزون وكؤوس وقاعة مجد واحتفال — بلا أي تدخل يدوي.'));
  body.append(tCard);

  const num = (v: number, min = 0, max = 99) =>
    el('input', { class: 'input', type: 'number', value: String(v), min: String(min), max: String(max), dir: 'ltr', style: 'max-width:110px' }) as HTMLInputElement;
  const F = {
    exact: num(c.exact), winner: num(c.winner), draw: num(c.draw), wrong: num(c.wrong),
    qualification: num(c.qualification), champion_bonus: num(c.champion_bonus),
  };
  const STAGES: [string, string][] = [['R16', 'دور الـ16'], ['QF', 'ربع النهائي'], ['SF', 'نصف النهائي'], ['THIRD', 'البرونزية'], ['FINAL', 'النهائي']];
  const M: Record<string, HTMLInputElement> = {};
  for (const [k] of STAGES) M[k] = num(c.stage_multipliers[k], 1, 10);

  const fld = (label: string, i: HTMLInputElement, hint = '') =>
    el('div', { class: 'field' }, el('label', {}, label), i, hint ? el('span', { class: 'helper-text' }, hint) : null);
  const save = el('button', { class: 'btn btn-primary' }, '💾 حفظ وإعادة الاحتساب') as HTMLButtonElement;

  body.append(el('div', { class: 'card', style: 'max-width:680px' },
    el('div', { class: 'card-title' }, el('h3', {}, '⚙️ محرك الاحتساب'),
      el('span', { class: 'chip' }, 'أي تعديل يعيد احتساب كل النقاط فوراً')),
    el('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(150px,1fr))' },
      fld('النتيجة الدقيقة', F.exact), fld('الفائز الصحيح', F.winner),
      fld('التعادل الصحيح', F.draw), fld('التوقع الخاطئ', F.wrong),
      fld('توقع المتأهل', F.qualification), fld('مكافأة البطل', F.champion_bonus)),
    el('div', { class: 'hr' }),
    el('h4', { class: 't-sm', style: 'margin-bottom:var(--s-3)' }, 'مضاعفات المراحل'),
    el('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(120px,1fr))' },
      ...STAGES.map(([k, l]) => fld(l, M[k]))),
    el('div', { class: 'hr' }),
    save,
    el('p', { class: 'helper-text', style: 'margin-top:var(--s-3)' },
      `قفل توقع البطل: ${s.champion_lock_utc ? dateTimeFull(s.champion_lock_utc) : 'غير محدد'}`)));

  save.onclick = async () => {
    save.classList.add('loading');
    try {
      const payload: any = { stage_multipliers: {} };
      for (const [k, i] of Object.entries(F)) payload[k] = Number(i.value);
      for (const [k] of STAGES) payload.stage_multipliers[k] = Number(M[k].value);
      const r = await post<{ players: number; changed: number }>('/api/admin/scoring-config', payload);
      toast(r.changed ? `حُفظت التهيئة وأُعيد الاحتساب لـ ${nf.format(r.players)} مشاركاً ✓` : 'بلا تغييرات', 'ok');
    } finally { save.classList.remove('loading'); }
  };
}

function settingRow(k: string, v: string): HTMLElement {
  return el('div', { class: 'stat' }, el('b', { style: 'font-size:var(--text-lg)' }, v), el('span', {}, k));
}

initNav().then(me => {
  if (me.role !== 'admin') { location.href = '/index.html'; return; }
  load();
});