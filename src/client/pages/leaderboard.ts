import { get } from '../api.js';
import { el, emptyState, skeletonBoard } from '../ui.js';
import { initials, nf } from '../format.js';
import { initNav, Me } from '../nav.js';
import { onLive } from '../sse.js';

interface Row {
  prev_rank: number | null;
  username: string;
  direction_count: number;
  scored_count: number;
  id: number; name: string; department: string; branch: string | null; photo_url: string;
  points: number; exact_count: number; accuracy: number; rank: number; delta: number;
  streak: number; champion_bonus: number; achievements: string[];
}
interface BranchRow { branch: string; points: number; members: number; avg: number; rank: number; exact: number; }

const main = document.getElementById('app')!;
const prevTops = new Map<string, number>();
let me: Me;
let tab: 'emp' | 'branch' | 'dept' | 'admins' = 'emp';

async function load(): Promise<void> {
  main.innerHTML = '';
  main.append(el('div', { class: 'rise', style: 'display:flex;flex-wrap:wrap;gap:16px;align-items:end;justify-content:space-between;margin-bottom:22px' },
    el('div', {},
      el('p', { class: 'eyebrow' }, 'المنافسة حيّة'),
      el('h1', { style: 'font-size:var(--text-xl)' }, 'جدول الصدارة'),
      el('a', { href: '/hall.html', class: 'chip gold', style: 'text-decoration:none;margin-top:6px;display:inline-block' }, '🏛 قاعة المجد')),
    el('div', { class: 'tabs' },
      tabBtn('الموظفون', 'emp'),
      tabBtn('الفروع', 'branch'),
      tabBtn('العناوين الوظيفية', 'dept'),
      tabBtn('الإدارة', 'admins'))));

  if (tab === 'emp') await renderEmployees();
  else if (tab === 'branch') await renderBranches();
  else if (tab === 'dept') await renderDepartments();
  else await renderAdmins();
}

function tabBtn(label: string, key: typeof tab): HTMLElement {
  return el('button', { class: `tab ${tab === key ? 'on' : ''}`, onclick: () => { tab = key; load(); } }, label);
}

async function renderEmployees(): Promise<void> {
  document.querySelectorAll<HTMLElement>('.rank-row[data-emp]').forEach(r =>
    prevTops.set(r.dataset.emp!, r.getBoundingClientRect().top));
  const first = !document.querySelector('.board-list');
  const holder = el('section', { class: 'rise-2' }, skeletonBoard(8));
  if (first) main.append(holder);
  const fetched = await get<Row[]>('/api/leaderboard');
  holder.remove();
  lastFullBoard = fetched;
  if (!fetched.length) {
    main.append(el('div', { class: 'card rise-2' }, emptyState({
      icon: '🏆', title: 'الترتيب ينتظر أول توقع',
      msg: 'أول ماتش يفتح السباق — سجّل توقعك وكن أول اسم بالصدارة',
      action: { label: 'سجّل توقعك', href: '/matches.html' },
    })));
    return;
  }

  renderSummary(fetched);
  const rows = applyView(fetched);
  const pristine = !view.q && !view.branch && !view.dept && view.sort === 'rank' && view.page === 1;
  const top3 = pristine ? fetched.slice(0, 3) : [];
  const medals = ['🥇', '🥈', '🥉'];
  if (top3.length === 3) {
    main.append(el('section', { class: 'podium rise-2' }, ...top3.map((r, i) =>
      el('div', { class: `pod pod-${i + 1}` },
        el('span', { class: 'pod-medal' }, medals[i]),
        avatar(r),
        el('b', { style: 'display:block' }, r.name),
        el('small', { style: 'color:var(--muted)' }, r.branch || ''),
        el('div', { class: 'pod-pts num' }, nf.format(r.points)),
        el('small', { style: 'color:var(--muted)' }, `${nf.format(r.exact_count)} دقيقة · ${nf.format(r.accuracy)}٪`)))));
  }

  main.append(boardToolbar(fetched));
  const paged = paginate(rows);
  const list = el('section', { class: 'board-list rise-3' });
  if (!paged.slice.length) {
    list.append(el('div', { class: 'card' }, emptyState({
      icon: '🔍', title: 'لا نتائج مطابقة', msg: 'عدّل البحث أو الفلاتر',
      action: { label: 'مسح الفلاتر', onclick: () => { Object.assign(view, { q: '', branch: '', dept: '', sort: 'rank', page: 1 }); load(); } } })));
  }
  for (const r of paged.slice) {
    const deltaEl = r.delta > 0 ? el('span', { class: 'delta up' }, `▲ ${nf.format(r.delta)}`)
      : r.delta < 0 ? el('span', { class: 'delta down' }, `▼ ${nf.format(-r.delta)}`)
      : el('span', { class: 'delta same' }, '—');
    list.append(el('div', { class: `rank-row ${r.id === me.id ? 'rank-me' : ''}`, dataset: { emp: String(r.id) } },
      el('span', { class: 'rank-no num', title: r.prev_rank ? `الترتيب السابق: #${nf.format(r.prev_rank)}` : 'أول ظهور' }, nf.format(r.rank)),
      avatar(r),
      el('div', { style: 'min-width:0' },
        el('b', { style: 'font-size:var(--text-sm)' }, r.name, r.id === me.id ? '  (أنت)' : ''),
        el('div', { class: 'row-meta' },
          el('span', {}, [r.branch, r.department].filter(Boolean).join(' · ') || '—'),
          el('span', { class: 'meta-chip' }, `🎯 ${nf.format(r.exact_count)} دقيقة`),
          el('span', { class: 'meta-chip' }, `✓ ${nf.format(r.direction_count)} صحيحة`),
          el('span', { class: 'meta-chip' }, `${nf.format(r.accuracy)}٪ دقة`),
          r.streak >= 2 ? el('span', { class: 'streak-fire' }, `🔥 ${nf.format(r.streak)}`) : null,
          r.champion_bonus ? el('span', { class: 'chip gold', style: 'font-size:.66rem;padding:1px 8px' }, 'عرّاف البطل') : null)),
      el('div', { style: 'text-align:end' },
        el('div', { class: 'pts num' }, nf.format(r.points)),
        el('div', { class: 't-xs t-muted num', title: 'السابق ← الحالي' },
          r.prev_rank ? `#${nf.format(r.prev_rank)} ← #${nf.format(r.rank)}` : ''),
        deltaEl)));
  }
  main.append(list, boardPager(paged));

  // FLIP: انزلاق ناعم من المركز القديم إلى الجديد عند التحديث الحي
  requestAnimationFrame(() => {
    list.querySelectorAll<HTMLElement>('.rank-row[data-emp]').forEach(r => {
      const old = prevTops.get(r.dataset.emp!);
      if (old === undefined) return;
      const dy = old - r.getBoundingClientRect().top;
      if (Math.abs(dy) < 2) return;
      r.style.transition = 'none';
      r.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => { r.style.transition = ''; r.style.transform = ''; });
    });
  });
}

/* ─── ملخصك: ترتيبك · الفارق أمامك وخلفك · تقدمك نحو الصدارة ─── */
function renderSummary(rows: Row[]): void {
  const i = rows.findIndex(r => r.id === me.id);
  if (i < 0) return; // الإدارة أو غير مشارك بلوحة الموظفين
  const r = rows[i];
  const above = i > 0 ? rows[i - 1] : null;
  const below = i < rows.length - 1 ? rows[i + 1] : null;
  const leader = rows[0];
  const prog = leader.points > 0 ? Math.min(100, Math.round((r.points / leader.points) * 100)) : 0;

  main.append(el('section', { class: 'card card-hero rise-2 my-summary' },
    el('div', { class: 'u-between u-wrap u-gap-3' },
      el('div', {},
        el('p', { class: 'eyebrow' }, 'ملخصك'),
        el('b', { style: 'font-size:var(--text-lg)' }, `#${nf.format(r.rank)}`,
          el('span', { class: 't-sm t-muted' }, ` من ${nf.format(rows.length)}`),
          r.prev_rank && r.prev_rank !== r.rank
            ? el('span', { class: `delta ${r.delta > 0 ? 'up' : 'down'}`, style: 'margin-inline-start:8px' },
                `${r.delta > 0 ? '▲' : '▼'} كنت #${nf.format(r.prev_rank)}`) : null)),
      el('div', { class: 'stat', style: 'text-align:end' }, el('b', { class: 'num' }, nf.format(r.points)), el('span', {}, 'نقاطك'))),
    el('div', { class: 'row-meta', style: 'margin-top:var(--s-3)' },
      above
        ? el('span', { class: 'meta-chip' }, `⬆ يفصلك ${nf.format(above.points - r.points)} عن ${above.name} (#${nf.format(above.rank)})`)
        : el('span', { class: 'chip gold' }, '👑 أنت بالصدارة'),
      below ? el('span', { class: 'meta-chip' }, `⬇ تتقدم بـ ${nf.format(r.points - below.points)} على ${below.name}`) : null,
      el('span', { class: 'meta-chip' }, `المسافة للصدارة: ${nf.format(Math.max(leader.points - r.points, 0))} نقطة`)),
    el('div', { style: 'margin-top:var(--s-3)' },
      el('div', { class: 'progress-linear', role: 'progressbar',
        'aria-valuenow': String(prog), 'aria-valuemin': '0', 'aria-valuemax': '100',
        'aria-label': 'تقدمك نحو الصدارة' }, el('b', { style: `width:${prog}%` })),
      el('div', { class: 't-xs t-muted', style: 'margin-top:6px' }, `تقدمك نحو المركز الأول: ${nf.format(prog)}٪`))));
}

/* ─── بحث/فلترة/فرز/ترقيم — محلياً على اللوحة الكاملة (تصل دفعة واحدة) ─── */
const view = { q: '', branch: '', dept: '', sort: 'rank', page: 1, per: 10 };
let lastFullBoard: Row[] = [];

function applyView(rows: Row[]): Row[] {
  let out = rows;
  const q = view.q.trim().toLowerCase();
  if (q) out = out.filter(r => r.name.toLowerCase().includes(q) || r.username.toLowerCase().includes(q));
  if (view.branch) out = out.filter(r => (r.branch || '') === view.branch);
  if (view.dept) out = out.filter(r => (r.department || '') === view.dept);
  const S: Record<string, (a: Row, b: Row) => number> = {
    rank: (a, b) => a.rank - b.rank,
    points: (a, b) => b.points - a.points || a.rank - b.rank,
    exact: (a, b) => b.exact_count - a.exact_count || a.rank - b.rank,
    accuracy: (a, b) => b.accuracy - a.accuracy || a.rank - b.rank,
    name: (a, b) => a.name.localeCompare(b.name, 'ar'),
  };
  return [...out].sort(S[view.sort] ?? S.rank);
}

function paginate(rows: Row[]): { slice: Row[]; total: number; page: number; pages: number } {
  const pages = Math.max(Math.ceil(rows.length / view.per), 1);
  const page = Math.min(Math.max(view.page, 1), pages);
  view.page = page;
  return { slice: rows.slice((page - 1) * view.per, page * view.per), total: rows.length, page, pages };
}

function boardToolbar(all: Row[]): HTMLElement {
  let deb = 0;
  const search = el('input', { class: 'input users-search', placeholder: '🔍 بحث بالاسم', value: view.q }) as HTMLInputElement;
  search.oninput = () => { clearTimeout(deb); deb = setTimeout(() => { view.q = search.value; view.page = 1; load(); }, 300) as unknown as number; };
  const sel = (opts: [string, string][], val: string, on: (v: string) => void) => {
    const x = el('select', { class: 'input users-sel' },
      ...opts.map(([v, l]) => el('option', { value: v, selected: val === v ? '' : null }, l))) as HTMLSelectElement;
    x.onchange = () => { on(x.value); view.page = 1; load(); };
    return x;
  };
  const branches = [...new Set(all.map(r => r.branch).filter(Boolean))] as string[];
  const depts = [...new Set(all.map(r => r.department).filter(Boolean))] as string[];
  return el('div', { class: 'card card-compact users-toolbar rise-3', style: 'margin-bottom:var(--s-3)' },
    search,
    sel([['', 'كل الفروع'], ...branches.map(b => [b, b] as [string, string])], view.branch, v => view.branch = v),
    sel([['', 'كل العناوين الوظيفية'], ...depts.map(d => [d, d] as [string, string])], view.dept, v => view.dept = v),
    sel([['rank', 'فرز: الترتيب'], ['points', 'فرز: النقاط'], ['exact', 'فرز: الدقيقة'], ['accuracy', 'فرز: الدقة'], ['name', 'فرز: الاسم']], view.sort, v => view.sort = v));
}

function boardPager(p: { total: number; page: number; pages: number }): HTMLElement {
  const per = el('select', { class: 'input users-sel' },
    ...[10, 25, 50].map(n => el('option', { value: String(n), selected: view.per === n ? '' : null }, `${n} / صفحة`))) as HTMLSelectElement;
  per.onchange = () => { view.per = Number(per.value); view.page = 1; load(); };
  return el('div', { class: 'pager rise-3', style: 'margin-top:var(--s-3)' },
    el('span', { class: 'num' }, `${nf.format(p.total)} مشاركاً`),
    el('div', { class: 'u-flex u-gap-2' }, per,
      el('button', { class: 'btn btn-ghost btn-sm', disabled: p.page <= 1 ? '' : null, onclick: () => { view.page--; load(); } }, '‹ السابق'),
      el('span', { class: 'num' }, `${nf.format(p.page)} / ${nf.format(p.pages)}`),
      el('button', { class: 'btn btn-ghost btn-sm', disabled: p.page >= p.pages ? '' : null, onclick: () => { view.page++; load(); } }, 'التالي ›')));
}

/* ─── لوحة الأقسام ─── */
interface DeptRow { rank: number; label: string; points: number; members: number; exact: number; avg: number; }
async function renderDepartments(): Promise<void> {
  const holder = el('section', { class: 'rise-2' }, skeletonBoard(5));
  main.append(holder);
  const rows = await get<DeptRow[]>('/api/leaderboard/departments');
  holder.remove();
  if (!rows.length) {
    main.append(el('div', { class: 'card rise-2' }, emptyState({
      icon: '🗂', title: 'منافسة الأقسام لم تبدأ',
      msg: 'حين تُسجَّل التوقعات تُحتسب معدلات الأقسام داخل فروعها',
      action: { label: 'سجّل توقعك', href: '/matches.html' } })));
    return;
  }
  const max = Math.max(...rows.map(r => r.avg), 1);
  main.append(el('section', { class: 'card rise-2' },
    el('div', { class: 'card-title' }, el('h3', {}, '🗂 ترتيب الأقسام'), el('span', { class: 'chip' }, 'بمعدل نقاط العضو')),
    el('div', { class: 'bars' }, ...rows.map((r, i) => el('div', { class: 'bar-row' },
      el('span', {}, `${i === 0 ? '👑 ' : ''}${r.label}`,
        el('span', { class: 't-xs t-muted' }, ` · ${nf.format(r.members)} عضو · ${nf.format(r.exact)} دقيقة`)),
      el('div', { class: 'bar-track' }, el('div', { class: `bar-fill ${i === 0 ? 'gold' : ''}`, style: `width:${(r.avg / max) * 100}%` })),
      el('b', { class: 'num' }, nf.format(r.avg)))))));
}

/* ─── لوحة الإدارة (حيث ينطبق — منفصلة عن سباق الموظفين) ─── */
async function renderAdmins(): Promise<void> {
  const rows = await get<Row[]>('/api/leaderboard/admins');
  if (!rows.length || rows.every(r => !r.scored_count && !r.points)) {
    main.append(el('div', { class: 'card rise-2' }, emptyState({
      icon: '🛡', title: 'الإدارة خارج السباق حالياً',
      msg: 'تظهر هذه اللوحة حين يشارك أعضاء الإدارة بتوقعاتهم — منفصلة حفاظاً على عدالة سباق الموظفين' })));
    return;
  }
  main.append(el('p', { class: 't-xs t-muted rise-2', style: 'margin-bottom:var(--s-2)' }, 'لوحة منفصلة — لا تُحتسب ضمن سباق الموظفين'));
  const list = el('section', { class: 'board-list rise-2' });
  for (const r of rows) {
    list.append(el('div', { class: 'rank-row' },
      el('span', { class: 'rank-no num' }, nf.format(r.rank)),
      avatar(r),
      el('div', {}, el('b', { style: 'font-size:var(--text-sm)' }, r.name),
        el('div', { class: 'row-meta' },
          el('span', { class: 'meta-chip' }, `🎯 ${nf.format(r.exact_count)} دقيقة`),
          el('span', { class: 'meta-chip' }, `✓ ${nf.format(r.direction_count)} صحيحة`),
          el('span', { class: 'meta-chip' }, `${nf.format(r.accuracy)}٪ دقة`))),
      el('div', { style: 'text-align:end' }, el('div', { class: 'pts num' }, nf.format(r.points)))));
  }
  main.append(list);
}

async function renderBranches(): Promise<void> {
  const first = !document.querySelector('.bars');
  const holder = el('section', { class: 'rise-2' }, skeletonBoard(5));
  if (first) main.append(holder);
  const rows = await get<BranchRow[]>('/api/leaderboard/branches');
  holder.remove();
  if (!rows.length) {
    main.append(el('div', { class: 'card rise-2' }, emptyState({
      icon: '🏬', title: 'منافسة الفروع لم تبدأ',
      msg: 'حين يتوقع موظفو الفروع تُحتسب المعدلات ويشتعل السباق بين المعارض',
      action: { label: 'سجّل توقعك', href: '/matches.html' },
    })));
    return;
  }
  const max = Math.max(...rows.map(r => r.avg), 1);
  const c = el('section', { class: 'card rise-2' },
    el('div', { class: 'card-title' },
      el('h3', {}, 'منافسة الفروع'),
      el('span', { class: 'chip' }, 'حسب معدل نقاط الموظف')),
    el('div', { class: 'bars' }, ...rows.map((r, i) => {
      const fill = el('div', { class: `bar-fill ${i === 0 ? 'gold' : ''}` });
      requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = (r.avg / max * 100) + '%'; }));
      return el('div', { class: 'bar-row' },
        el('span', {}, `${i === 0 ? '👑 ' : ''}${r.branch}`),
        el('div', { class: 'bar-track' }, fill),
        el('b', { class: 'num' }, nf.format(r.avg)));
    })));
  c.append(el('div', { class: 'hr' }),
    el('div', { class: 'table-wrap' },
      el('table', {},
        el('thead', {}, el('tr', {},
          ...['المركز', 'الفرع', 'المعدل', 'مجموع النقاط', 'المشاركون', 'نتائج دقيقة'].map(h => el('th', {}, h)))),
        el('tbody', {}, ...rows.map(r => el('tr', {},
          el('td', { class: 'num' }, nf.format(r.rank)),
          el('td', {}, el('b', {}, r.branch)),
          el('td', { class: 'num' }, nf.format(r.avg)),
          el('td', { class: 'num' }, nf.format(r.points)),
          el('td', { class: 'num' }, nf.format(r.members)),
          el('td', { class: 'num' }, nf.format(r.exact))))))));
  main.append(c);
}

function avatar(r: { name: string; photo_url?: string }): HTMLElement {
  return el('div', { class: 'avatar' },
    r.photo_url ? el('img', { src: r.photo_url, alt: r.name }) : initials(r.name));
}

initNav().then(u => { me = u; load(); });
onLive('leaderboard', () => load()); // كل اللوحات مشتقة من النقاط — تتحدث حياً معاً
onLive('match_result', () => load());