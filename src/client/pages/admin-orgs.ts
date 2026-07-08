import { get, post, patch, api } from '../api.js';
import { el, toast, openModal, emptyState } from '../ui.js';
import { nf } from '../format.js';

interface Branch { id: number; name: string; active: number; emp_count: number; dept_count: number; }
interface Dept { id: number; name: string; active: number; branch_id: number; branch: string; emp_count: number; }
interface ListRes<T> { rows: T[]; total: number; page: number; per: number; pages: number; }

const bState = { q: '', status: '', sort: 'name', dir: 'asc', page: 1, per: 10 };
const dState = { q: '', status: '', sort: 'name', dir: 'asc', page: 1, per: 10 };
let selBranch: { id: number; name: string } | null = null;
let bHost: HTMLElement, dHost: HTMLElement;

const qs = (o: Record<string, unknown>) =>
  new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();

export async function orgsTab(body: HTMLElement): Promise<void> {
  bHost = el('div'); dHost = el('div');
  body.append(bHost, dHost);
  await renderBranches();
  await renderDepts();
}

/* ═══ لوح الفروع ═══ */
async function renderBranches(): Promise<void> {
  const d = await get<ListRes<Branch>>(`/api/admin/orgs/branches?${qs(bState)}`);
  bState.page = d.page;
  bHost.innerHTML = '';

  let deb = 0;
  const search = el('input', { class: 'input users-search', placeholder: '🔍 بحث بالفروع', value: bState.q }) as HTMLInputElement;
  search.oninput = () => { clearTimeout(deb); deb = setTimeout(() => { bState.q = search.value; bState.page = 1; renderBranches(); }, 300) as unknown as number; };

  bHost.append(el('div', { class: 'card card-compact users-toolbar', style: 'margin-bottom:var(--s-3)' },
    el('h3', { style: 'font-size:var(--text-md)' }, '🏬 الفروع'),
    search,
    statusSel(bState, () => renderBranches()),
    sortSel([['name', 'الاسم'], ['employees', 'الموظفون'], ['departments', 'الأقسام'], ['status', 'الحالة']], bState, () => renderBranches()),
    el('span', { style: 'flex:1' }),
    el('button', { class: 'btn btn-primary btn-sm', onclick: () => branchModal() }, '+ فرع جديد')));

  const card = el('div', { class: 'card', style: 'padding:var(--s-3)' });
  if (!d.rows.length) {
    card.append(emptyState({ icon: '🏬', title: 'لا فروع مطابقة', msg: 'أنشئ فرعاً أو عدّل البحث',
      action: { label: 'مسح البحث', onclick: () => { Object.assign(bState, { q: '', status: '', page: 1 }); renderBranches(); } } }));
  } else {
    card.append(el('div', { class: 'table-wrap' }, el('table', { class: 'table-compact' },
      el('thead', {}, el('tr', {}, ...['الفرع', 'الحالة', 'الموظفون', 'الأقسام', ''].map(h => el('th', {}, h)))),
      el('tbody', {}, ...d.rows.map(b => el('tr', { class: selBranch?.id === b.id ? 'row-selected' : '' },
        el('td', {}, el('b', {}, b.name)),
        el('td', {}, el('span', { class: `chip ${b.active ? 'ok' : ''}` }, b.active ? 'فعّال' : 'موقوف')),
        el('td', { class: 'num' }, nf.format(b.emp_count)),
        el('td', { class: 'num' }, nf.format(b.dept_count)),
        el('td', { class: 'u-flex u-gap-2' },
          el('button', { class: 'btn btn-ghost btn-sm', onclick: () => { selBranch = { id: b.id, name: b.name }; dState.page = 1; renderBranches(); renderDepts(); } }, 'الأقسام ‹'),
          el('button', { class: 'btn btn-ghost btn-sm', onclick: () => branchModal(b) }, '✏️'),
          el('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
            await patch(`/api/admin/orgs/branches/${b.id}`, { active: !b.active });
            toast(b.active ? 'أُوقف الفرع' : 'فُعّل الفرع', 'ok'); renderBranches();
          } }, b.active ? '⏸' : '▶️'),
          el('button', { class: 'btn btn-danger btn-sm', onclick: () => deleteBranch(b) }, '🗑'))))))));
  }
  card.append(pager(d, bState, () => renderBranches()));
  bHost.append(card);
}

function branchModal(b?: Branch): void {
  const n = el('input', { class: 'input', value: b?.name || '', placeholder: 'المنصور' }) as HTMLInputElement;
  const save = el('button', { class: 'btn btn-primary' }, b ? 'حفظ' : 'إنشاء') as HTMLButtonElement;
  const close = openModal(el('div', { class: 'grid' },
    el('h2', { style: 'font-size:var(--text-lg)' }, b ? `تعديل فرع — ${b.name}` : 'فرع جديد'),
    el('div', { class: 'field' }, el('label', {}, 'اسم الفرع'), n,
      el('span', { class: 'helper-text' }, 'فريد على مستوى الشركة')),
    save));
  save.onclick = async () => {
    save.classList.add('loading');
    try {
      if (b) await patch(`/api/admin/orgs/branches/${b.id}`, { name: n.value });
      else await post('/api/admin/orgs/branches', { name: n.value });
      toast('✓ حُفظ', 'ok'); close(); renderBranches(); renderDepts();
    } catch { save.classList.remove('loading'); }
  };
}

async function deleteBranch(b: Branch): Promise<void> {
  try {
    await api(`/api/admin/orgs/branches/${b.id}`, { method: 'DELETE' });
    toast(`حُذف فرع «${b.name}»`, 'ok');
    if (selBranch?.id === b.id) selBranch = null;
    renderBranches(); renderDepts();
  } catch (e: any) {
    if (!e?.needs_reassign) return;
    const all = await get<ListRes<Branch>>(`/api/admin/orgs/branches?per=100&status=active`);
    const opts = all.rows.filter(x => x.id !== b.id);
    if (!opts.length) { toast('لا يوجد فرع نشط بديل للنقل', 'err'); return; }
    const s = el('select', { class: 'input' }, ...opts.map(x => el('option', { value: String(x.id) }, x.name))) as HTMLSelectElement;
    const go = el('button', { class: 'btn btn-danger' }, 'نقل ثم حذف') as HTMLButtonElement;
    const close = openModal(el('div', { class: 'grid' },
      el('h2', { style: 'font-size:var(--text-lg)' }, `حذف «${b.name}»`),
      el('p', { class: 't-muted t-sm' }, `${nf.format(b.emp_count)} موظفاً مرتبطون به — اختر فرعاً بديلاً، وستُعاد أقسامهم تحته تلقائياً.`),
      el('div', { class: 'field' }, el('label', {}, 'الفرع البديل'), s), go));
    go.onclick = async () => {
      go.classList.add('loading');
      try {
        const r = await api<{ moved: number }>(`/api/admin/orgs/branches/${b.id}`, { method: 'DELETE', body: JSON.stringify({ reassign_to: Number(s.value) }) });
        toast(`حُذف الفرع ونُقل ${nf.format(r.moved)} موظفاً ✓`, 'ok');
        if (selBranch?.id === b.id) selBranch = null;
        close(); renderBranches(); renderDepts();
      } catch { go.classList.remove('loading'); }
    };
  }
}

/* ═══ لوح الأقسام ═══ */
async function renderDepts(): Promise<void> {
  dHost.innerHTML = '';
  const head = el('div', { class: 'card card-compact users-toolbar', style: 'margin:var(--s-4) 0 var(--s-3)' },
    el('h3', { style: 'font-size:var(--text-md)' }, '🗂 الأقسام'),
    el('span', { class: 'chip' }, selBranch ? `فرع: ${selBranch.name}` : 'كل الفروع'));
  if (!selBranch) {
    dHost.append(head, el('div', { class: 'card' }, emptyState({
      icon: '🗂', title: 'اختر فرعاً', msg: 'اضغط «الأقسام» عند أي فرع أعلاه لإدارة أقسامه' })));
    return;
  }

  const d = await get<ListRes<Dept>>(`/api/admin/orgs/departments?branch=${selBranch.id}&${qs(dState)}`);
  dState.page = d.page;

  let deb = 0;
  const search = el('input', { class: 'input users-search', placeholder: '🔍 بحث بالأقسام', value: dState.q }) as HTMLInputElement;
  search.oninput = () => { clearTimeout(deb); deb = setTimeout(() => { dState.q = search.value; dState.page = 1; renderDepts(); }, 300) as unknown as number; };
  head.append(search, statusSel(dState, () => renderDepts()),
    sortSel([['name', 'الاسم'], ['employees', 'الموظفون'], ['status', 'الحالة']], dState, () => renderDepts()),
    el('span', { style: 'flex:1' }),
    el('button', { class: 'btn btn-primary btn-sm', onclick: () => deptModal() }, '+ قسم جديد'));

  const card = el('div', { class: 'card', style: 'padding:var(--s-3)' });
  if (!d.rows.length) {
    card.append(emptyState({ icon: '🗂', title: 'لا أقسام بعد', msg: `أنشئ أول قسم في «${selBranch.name}»`,
      action: { label: '+ قسم جديد', onclick: () => deptModal() } }));
  } else {
    card.append(el('div', { class: 'table-wrap' }, el('table', { class: 'table-compact' },
      el('thead', {}, el('tr', {}, ...['القسم', 'الحالة', 'الموظفون', ''].map(h => el('th', {}, h)))),
      el('tbody', {}, ...d.rows.map(x => el('tr', {},
        el('td', {}, el('b', {}, x.name)),
        el('td', {}, el('span', { class: `chip ${x.active ? 'ok' : ''}` }, x.active ? 'فعّال' : 'موقوف')),
        el('td', { class: 'num' }, nf.format(x.emp_count)),
        el('td', { class: 'u-flex u-gap-2' },
          el('button', { class: 'btn btn-ghost btn-sm', onclick: () => deptModal(x) }, '✏️'),
          el('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
            await patch(`/api/admin/orgs/departments/${x.id}`, { active: !x.active });
            toast(x.active ? 'أُوقف القسم' : 'فُعّل القسم', 'ok'); renderDepts();
          } }, x.active ? '⏸' : '▶️'),
          el('button', { class: 'btn btn-danger btn-sm', onclick: () => deleteDept(x) }, '🗑'))))))));
  }
  card.append(pager(d, dState, () => renderDepts()));
  dHost.append(head, card);
}

function deptModal(x?: Dept): void {
  const n = el('input', { class: 'input', value: x?.name || '', placeholder: 'المبيعات' }) as HTMLInputElement;
  const save = el('button', { class: 'btn btn-primary' }, x ? 'حفظ' : 'إنشاء') as HTMLButtonElement;
  const close = openModal(el('div', { class: 'grid' },
    el('h2', { style: 'font-size:var(--text-lg)' }, x ? `تعديل قسم — ${x.name}` : `قسم جديد في «${selBranch!.name}»`),
    el('div', { class: 'field' }, el('label', {}, 'اسم القسم'), n,
      el('span', { class: 'helper-text' }, 'فريد داخل الفرع — وتُحدَّث بطاقات الموظفين تلقائياً عند إعادة التسمية')),
    save));
  save.onclick = async () => {
    save.classList.add('loading');
    try {
      if (x) await patch(`/api/admin/orgs/departments/${x.id}`, { name: n.value });
      else await post('/api/admin/orgs/departments', { branch_id: selBranch!.id, name: n.value });
      toast('✓ حُفظ', 'ok'); close(); renderDepts();
    } catch { save.classList.remove('loading'); }
  };
}

async function deleteDept(x: Dept): Promise<void> {
  try {
    await api(`/api/admin/orgs/departments/${x.id}`, { method: 'DELETE' });
    toast(`حُذف قسم «${x.name}»`, 'ok'); renderDepts();
  } catch (e: any) {
    if (!e?.needs_reassign) return;
    const all = await get<ListRes<Dept>>(`/api/admin/orgs/departments?branch=${x.branch_id}&per=100&status=active`);
    const opts = all.rows.filter(o => o.id !== x.id);
    if (!opts.length) { toast('لا قسم نشط بديل في الفرع نفسه — أنشئ قسماً أولاً', 'err'); return; }
    const s = el('select', { class: 'input' }, ...opts.map(o => el('option', { value: String(o.id) }, o.name))) as HTMLSelectElement;
    const go = el('button', { class: 'btn btn-danger' }, 'نقل ثم حذف') as HTMLButtonElement;
    const close = openModal(el('div', { class: 'grid' },
      el('h2', { style: 'font-size:var(--text-lg)' }, `حذف «${x.name}»`),
      el('p', { class: 't-muted t-sm' }, `${nf.format(x.emp_count)} موظفاً بهذا القسم — اختر قسماً بديلاً في الفرع نفسه.`),
      el('div', { class: 'field' }, el('label', {}, 'القسم البديل'), s), go));
    go.onclick = async () => {
      go.classList.add('loading');
      try {
        const r = await api<{ moved: number }>(`/api/admin/orgs/departments/${x.id}`, { method: 'DELETE', body: JSON.stringify({ reassign_to: Number(s.value) }) });
        toast(`حُذف القسم ونُقل ${nf.format(r.moved)} موظفاً ✓`, 'ok'); close(); renderDepts();
      } catch { go.classList.remove('loading'); }
    };
  }
}

/* ═══ أدوات مشتركة صغيرة ═══ */
function statusSel(st: { status: string; page: number }, on: () => void): HTMLSelectElement {
  const s = el('select', { class: 'input users-sel' },
    ...[['', 'كل الحالات'], ['active', 'فعّال'], ['disabled', 'موقوف']].map(([v, l]) =>
      el('option', { value: v, selected: st.status === v ? '' : null }, l))) as HTMLSelectElement;
  s.onchange = () => { st.status = s.value; st.page = 1; on(); };
  return s;
}
function sortSel(opts: [string, string][], st: { sort: string; dir: string; page: number }, on: () => void): HTMLElement {
  const s = el('select', { class: 'input users-sel' },
    ...opts.map(([v, l]) => el('option', { value: v, selected: st.sort === v ? '' : null }, `فرز: ${l}`))) as HTMLSelectElement;
  s.onchange = () => { st.sort = s.value; on(); };
  const dir = el('button', { class: 'btn btn-ghost btn-sm btn-icon', title: 'اتجاه الفرز',
    onclick: () => { st.dir = st.dir === 'asc' ? 'desc' : 'asc'; on(); } }, st.dir === 'asc' ? '↑' : '↓');
  return el('span', { class: 'u-flex u-gap-2' }, s, dir);
}
function pager(d: { total: number; page: number; per: number; pages: number }, st: { page: number; per: number }, on: () => void): HTMLElement {
  const from = (d.page - 1) * d.per + 1, to = Math.min(d.page * d.per, d.total);
  return el('div', { class: 'pager', style: 'padding:var(--s-3) var(--s-2) 0' },
    el('span', { class: 'num' }, d.total ? `عرض ${nf.format(from)}–${nf.format(to)} من ${nf.format(d.total)}` : 'لا سجلات'),
    el('div', { class: 'u-flex u-gap-2' },
      el('button', { class: 'btn btn-ghost btn-sm', disabled: d.page <= 1 ? '' : null, onclick: () => { st.page = d.page - 1; on(); } }, '‹ السابق'),
      el('span', { class: 'num' }, `${nf.format(d.page)} / ${nf.format(d.pages)}`),
      el('button', { class: 'btn btn-ghost btn-sm', disabled: d.page >= d.pages ? '' : null, onclick: () => { st.page = d.page + 1; on(); } }, 'التالي ›')));
}
