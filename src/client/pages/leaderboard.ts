import { get } from '../api.js';
import { el, emptyState, skeletonBoard } from '../ui.js';
import { initials, nf } from '../format.js';
import { initNav, Me } from '../nav.js';
import { onLive } from '../sse.js';
import { countUp, reducedMotion } from '../ambient.js';

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
let tab: 'emp' | 'branch' | 'dept' | 'admins' | 'winners' = 'emp';

/* عدّاد أجيال: الخادم يبثّ 'match_result' و'leaderboard' لنفس الحدث —
   بدون هذا الحارس يتسابق تحميلان ويُبنى المحتوى مرتين. الأحدث وحده يرسم. */
let gen = 0;
/* بعد أول رسم كامل: الأرقام تُكتب مباشرة (بلا عدّ) والدخول المسرحي لا يُعاد */
let boardRevealed = false;
function animNum(node: HTMLElement, val: number, fmt: (n: number) => string): void {
  if (boardRevealed) node.textContent = fmt(val);
  else countUp(node, val, fmt);
}

async function load(): Promise<void> {
  const g = ++gen;
  main.innerHTML = '';
  // رأس بطولي — لغة الحفل البصرية بنبرة تنافسية (الوظيفة كما هي: تبويبات + قاعة المجد)
  main.append(el('header', { class: `lb-hero${boardRevealed ? '' : ' fx-enter'}` },
    el('p', { class: 'hero-kicker' }, 'المنافسة حيّة'),
    el('h1', { class: 'lb-title' }, 'جدول الصدارة'),
    el('p', { class: 'lb-sub' }, 'سباق توقعات المونديال — الدقة وحدها تصنع المجد'),
    el('div', { class: 'lb-controls' },
      el('div', { class: 'tabs' },
        tabBtn('الموظفون', 'emp'),
        tabBtn('الفائزين', 'winners'),
        tabBtn('الفروع', 'branch'),
        tabBtn('العناوين الوظيفية', 'dept'),
        tabBtn('الإدارة', 'admins')),
      el('a', { href: '/hall.html', class: 'chip gold', style: 'text-decoration:none' }, '🏛 قاعة المجد'))));

  if (tab === 'emp') await renderEmployees(g);
  else if (tab === 'winners') await renderWinners(g);
  else if (tab === 'branch') await renderBranches(g);
  else if (tab === 'dept') await renderDepartments(g);
  else await renderAdmins(g);
  boardRevealed = true;
}

function tabBtn(label: string, key: typeof tab): HTMLElement {
  return el('button', { class: `tab ${tab === key ? 'on' : ''}`, onclick: () => { tab = key; load(); } }, label);
}

async function renderEmployees(g: number): Promise<void> {
  document.querySelectorAll<HTMLElement>('.rank-row[data-emp]').forEach(r =>
    prevTops.set(r.dataset.emp!, r.getBoundingClientRect().top));
  const first = !document.querySelector('.board-list');
  const holder = el('section', { class: 'rise-2' }, skeletonBoard(8));
  if (first) main.append(holder);
  const fetched = await get<Row[]>('/api/leaderboard');
  if (g !== gen) return;   // تحميل أحدث سبقنا — لا نرسم فوقه
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

  statsBand(fetched);
  renderSummary(fetched);
  const rows = applyView(fetched);
  const pristine = !view.q && !view.branch && !view.dept && view.sort === 'rank' && view.page === 1;
  const top3 = pristine ? fetched.slice(0, 3) : [];
  const medals = ['🥇', '🥈', '🥉'];
  const medalNames = ['المركز الأول', 'المركز الثاني', 'المركز الثالث'];
  if (top3.length === 3) {
    main.append(el('section', { class: `podium lb-podium${boardRevealed ? ' settled' : ''}` }, ...top3.map((r, i) => {
      const pts = el('div', { class: 'pod-pts num' }, nf.format(0));
      animNum(pts, r.points, n => nf.format(n));
      return el('div', { class: `pod pod-${i + 1}`, role: 'group', 'aria-label': `${medalNames[i]} — ${r.name}` },
        el('span', { class: 'pod-medal', 'aria-hidden': 'true' }, medals[i]),
        avatar(r),
        el('b', { style: 'display:block' }, r.name),
        el('small', { style: 'color:var(--muted)' }, r.branch || ''),
        pts,
        el('small', { style: 'color:var(--muted)' }, `${nf.format(r.exact_count)} دقيقة · ${nf.format(r.accuracy)}٪`));
    })));
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
    const ds: Record<string, string> = { emp: String(r.id) };
    if (r.rank <= 3) ds.top = String(r.rank);   // شارة لونية للمراكز الثلاثة (بيانات حقيقية)
    list.append(el('div', { class: `rank-row ${r.id === me.id ? 'rank-me' : ''}`, dataset: ds },
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

  // تمرير تلقائي أنيق إلى صفّك — يُستهلك فقط حين يظهر صفّك فعلاً
  // (قد يكون بصفحة لاحقة من الترقيم؛ نبقي الفرصة حتى يُعرض)
  if (!scrolledToMe) {
    const mine = list.querySelector<HTMLElement>('.rank-me');
    if (mine) {
      scrolledToMe = true;
      const box = mine.getBoundingClientRect();
      if (box.top > innerHeight * .92 || box.bottom < 0) {
        mine.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
      }
    }
  }

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

let scrolledToMe = false;

/* ─── عقد الإحصاء التنافسي — أرقام مشتقة حصراً من لوحة ‎/api/leaderboard كما وصلت ─── */
function statsBand(rows: Row[]): void {
  const totalExact = rows.reduce((s, r) => s + r.exact_count, 0);
  const avgAcc = Math.round(rows.reduce((s, r) => s + r.accuracy, 0) / rows.length);
  const cards: Array<[string, string, number, string]> = [
    ['👥', 'مشاركاً في السباق', rows.length, ''],
    ['⭐', 'نقاط المتصدر', rows[0].points, ''],
    ['🎯', 'توقعاً دقيقاً', totalExact, ''],
    ['📈', 'متوسط الدقة', avgAcc, '٪'],
  ];
  const band = el('section', { class: `lb-stats${boardRevealed ? '' : ' fx-enter'}`, style: '--i:1' });
  for (const [ico, lbl, val, suffix] of cards) {
    const v = el('b', { class: 'stat-val num' }, nf.format(0));
    band.append(el('div', { class: 'stat-card' },
      el('span', { class: 'stat-ico', 'aria-hidden': 'true' }, ico),
      v,
      el('span', { class: 'stat-lbl' }, lbl)));
    animNum(v, val, n => nf.format(n) + suffix);
  }
  main.append(band);
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
  const myPts = el('b', { class: 'num' }, nf.format(0));
  animNum(myPts, r.points, n => nf.format(n));

  main.append(el('section', { class: 'card card-hero rise-2 my-summary' },
    el('div', { class: 'u-between u-wrap u-gap-3' },
      el('div', {},
        el('p', { class: 'eyebrow' }, 'ملخصك'),
        el('b', { style: 'font-size:var(--text-lg)' }, `#${nf.format(r.rank)}`,
          el('span', { class: 't-sm t-muted' }, ` من ${nf.format(rows.length)}`),
          r.prev_rank && r.prev_rank !== r.rank
            ? el('span', { class: `delta ${r.delta > 0 ? 'up' : 'down'}`, style: 'margin-inline-start:8px' },
                `${r.delta > 0 ? '▲' : '▼'} كنت #${nf.format(r.prev_rank)}`) : null)),
      el('div', { class: 'stat', style: 'text-align:end' }, myPts, el('span', {}, 'نقاطك'))),
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
  const search = el('input', { class: 'input users-search', placeholder: '🔍 بحث بالاسم',
    'aria-label': 'بحث بالاسم', value: view.q }) as HTMLInputElement;
  search.oninput = () => { clearTimeout(deb); deb = setTimeout(() => { view.q = search.value; view.page = 1; load(); }, 300) as unknown as number; };
  const sel = (label: string, opts: [string, string][], val: string, on: (v: string) => void) => {
    const x = el('select', { class: 'input users-sel', 'aria-label': label },
      ...opts.map(([v, l]) => el('option', { value: v, selected: val === v ? '' : null }, l))) as HTMLSelectElement;
    x.onchange = () => { on(x.value); view.page = 1; load(); };
    return x;
  };
  const branches = [...new Set(all.map(r => r.branch).filter(Boolean))] as string[];
  const depts = [...new Set(all.map(r => r.department).filter(Boolean))] as string[];
  return el('div', { class: 'card card-compact users-toolbar rise-3', style: 'margin-bottom:var(--s-3)' },
    search,
    sel('تصفية حسب الفرع', [['', 'كل الفروع'], ...branches.map(b => [b, b] as [string, string])], view.branch, v => view.branch = v),
    sel('تصفية حسب العنوان الوظيفي', [['', 'كل العناوين الوظيفية'], ...depts.map(d => [d, d] as [string, string])], view.dept, v => view.dept = v),
    sel('فرز اللوحة', [['rank', 'فرز: الترتيب'], ['points', 'فرز: النقاط'], ['exact', 'فرز: الدقيقة'], ['accuracy', 'فرز: الدقة'], ['name', 'فرز: الاسم']], view.sort, v => view.sort = v));
}

function boardPager(p: { total: number; page: number; pages: number }): HTMLElement {
  const per = el('select', { class: 'input users-sel', 'aria-label': 'عدد الصفوف بالصفحة' },
    ...[10, 25, 50].map(n => el('option', { value: String(n), selected: view.per === n ? '' : null }, `${n} / صفحة`))) as HTMLSelectElement;
  per.onchange = () => { view.per = Number(per.value); view.page = 1; load(); };
  return el('div', { class: 'pager rise-3', style: 'margin-top:var(--s-3)' },
    el('span', { class: 'num' }, `${nf.format(p.total)} مشاركاً`),
    el('div', { class: 'u-flex u-gap-2' }, per,
      el('button', { class: 'btn btn-ghost btn-sm', disabled: p.page <= 1 ? '' : null, onclick: () => { view.page--; load(); } }, '‹ السابق'),
      el('span', { class: 'num' }, `${nf.format(p.page)} / ${nf.format(p.pages)}`),
      el('button', { class: 'btn btn-ghost btn-sm', disabled: p.page >= p.pages ? '' : null, onclick: () => { view.page++; load(); } }, 'التالي ›')));
}

async function renderWinners(g: number): Promise<void> {
  const holder = el('section', { class: 'rise-2' }, skeletonBoard(5));
  main.append(holder);
  const fetched = await get<Row[]>('/api/leaderboard');
  if (g !== gen) return;
  holder.remove();

  const rows = fetched.slice(0, 20);
  if (!rows.length) {
    main.append(el('div', { class: 'card rise-2' }, emptyState({
      icon: '🏆', title: 'الترتيب ينتظر أول توقع',
      msg: 'حين تبدأ المشاركات أول 20 اسمًا من الفائزين ستظهر هنا في تنسيق فاخر',
      action: { label: 'سجّل توقعك', href: '/matches.html' },
    })));
    return;
  }

  const tops = rows.slice(0, 3);
  const top3 = el('section', { class: 'winners-podium rise-2' },
    ...tops.map((r, i) => {
      const medals = ['🥇', '🥈', '🥉'];
      const slug = ['winner-1', 'winner-2', 'winner-3'][i];
      return el('article', { class: `winner-card ${slug}` },
        el('span', { class: 'winner-medal' }, medals[i]),
        el('div', { class: 'winner-rank' }, `#${nf.format(r.rank)}`),
        avatar(r),
        el('div', { class: 'winner-meta' },
          el('b', {}, r.name),
          el('small', {}, r.branch || '—')),
        el('div', { class: 'winner-points num' }, nf.format(r.points)));
    }));

  main.append(el('section', { class: 'card card-hero rise-2 winners-intro' },
    el('div', { class: 'winners-head' },
      el('div', {},
        el('p', { class: 'eyebrow' }, 'الفائزون الأقرب إلى الكأس'),
        el('h3', {}, 'أفضل 20 مشاركة في سباق التوقعات')),
      el('span', { class: 'chip gold' }, `${nf.format(rows.length)} اسمًا فاخرًا`))));
  main.append(top3);

  const grid = el('section', { class: 'winners-grid rise-3 winners-list' });
  rows.slice(3).forEach((r, idx) => {
    const medal = r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : `#${nf.format(r.rank)}`;
    grid.append(el('article', { class: 'winner-tile' },
      el('div', { class: 'winner-tile-head' },
        el('span', { class: 'winner-medal' }, medal),
        el('span', { class: 'winner-rank num' }, `#${nf.format(r.rank)}`)),
      avatar(r),
      el('div', { class: 'winner-tile-body' },
        el('b', {}, r.name),
        el('small', {}, r.branch || '—')),
      el('div', { class: 'winner-tile-stats' },
        el('span', { class: 'meta-chip' }, `🎯 ${nf.format(r.exact_count)} دقيقة`),
        el('span', { class: 'meta-chip' }, `${nf.format(r.accuracy)}٪ دقة`),
        el('span', { class: 'winner-points num' }, nf.format(r.points)))));
  });
  main.append(grid);
}

/* ─── لوحة الأقسام ─── */
interface DeptRow { rank: number; label: string; points: number; members: number; exact: number; avg: number; }
async function renderDepartments(g: number): Promise<void> {
  const holder = el('section', { class: 'rise-2' }, skeletonBoard(5));
  main.append(holder);
  const rows = await get<DeptRow[]>('/api/leaderboard/departments');
  if (g !== gen) return;
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
async function renderAdmins(g: number): Promise<void> {
  const rows = await get<Row[]>('/api/leaderboard/admins');
  if (g !== gen) return;
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

async function renderBranches(g: number): Promise<void> {
  const first = !document.querySelector('.bars');
  const holder = el('section', { class: 'rise-2' }, skeletonBoard(5));
  if (first) main.append(holder);
  const rows = await get<BranchRow[]>('/api/leaderboard/branches');
  if (g !== gen) return;
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