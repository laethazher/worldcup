import { get, post, patch, api } from '../api.js';
import { el, toast, openModal, emptyState } from '../ui.js';
import { dateTimeFull, nf, initials } from '../format.js';

interface Emp {
  id: number; username: string; name: string; phone: string | null;
  department: string; branch: string | null; branch_id: number | null;
  role: string; active: number; created_at: string; last_login_at: string | null;
  login_count: number; photo_url: string;
}
interface ListRes { rows: Emp[]; total: number; page: number; per: number; pages: number; }
interface Branch { id: number; name: string; active: number; }

const state = { q: '', branch: '', role: '', status: '', sort: 'name', dir: 'asc', page: 1, per: 10 };
const selected = new Set<number>();
let host: HTMLElement;
let branches: Branch[] = [];
let openMenu: HTMLElement | null = null;

document.addEventListener('click', (e) => {
  if (openMenu && !openMenu.parentElement?.contains(e.target as Node)) { openMenu.remove(); openMenu = null; }
}, true);

const qs = () => new URLSearchParams(Object.entries(state).map(([k, v]) => [k, String(v)])).toString();

export async function usersTab(body: HTMLElement): Promise<void> {
  host = el('div', { class: 'grid' });
  body.append(host);
  branches = await get<Branch[]>('/api/admin/branches');
  await render();
}

async function render(): Promise<void> {
  const d = await get<ListRes>(`/api/admin/employees?${qs()}`);
  state.page = d.page;
  host.innerHTML = '';
  host.append(toolbar(), tableCard(d), pager(d));
  if (selected.size) host.append(bulkBar());
}

/* ─── شريط الأدوات: بحث · فلاتر · فرز · تصدير · إنشاء · استيراد ─── */
function toolbar(): HTMLElement {
  let deb = 0;
  const search = el('input', { class: 'input users-search', placeholder: '🔍 بحث بالاسم / المستخدم / الهاتف', value: state.q }) as HTMLInputElement;
  search.oninput = () => { clearTimeout(deb); deb = setTimeout(() => { state.q = search.value; state.page = 1; render(); }, 300) as unknown as number; };

  const sel = (opts: [string, string][], val: string, on: (v: string) => void) => {
    const s = el('select', { class: 'input users-sel' }) as HTMLSelectElement;
    for (const [v, l] of opts) s.append(el('option', { value: v, selected: val === v ? '' : null }, l));
    s.onchange = () => { on(s.value); state.page = 1; render(); };
    return s;
  };

  const dirBtn = el('button', { class: 'btn btn-ghost btn-sm btn-icon', title: 'اتجاه الفرز',
    onclick: () => { state.dir = state.dir === 'asc' ? 'desc' : 'asc'; render(); } },
    state.dir === 'asc' ? '↑' : '↓');

  return el('div', { class: 'card card-compact users-toolbar' },
    search,
    sel([['', 'كل الفروع'], ...branches.map(b => [String(b.id), b.name] as [string, string])], state.branch, v => state.branch = v),
    sel([['', 'كل الأدوار'], ['admin', 'إدارة'], ['employee', 'موظف']], state.role, v => state.role = v),
    sel([['', 'كل الحالات'], ['active', 'فعّال'], ['disabled', 'موقوف']], state.status, v => state.status = v),
    sel([['name', 'فرز: الاسم'], ['username', 'فرز: المستخدم'], ['branch', 'فرز: الفرع'], ['created', 'فرز: الإنشاء'], ['last_login', 'فرز: آخر دخول'], ['logins', 'فرز: مرات الدخول']], state.sort, v => state.sort = v),
    dirBtn,
    el('span', { style: 'flex:1' }),
    el('a', { class: 'btn btn-ghost btn-sm', href: `/api/admin/export/users.xlsx?${qs()}` }, '⬇ Excel'),
    el('a', { class: 'btn btn-ghost btn-sm', href: `/api/admin/export/users.csv?${qs()}` }, '⬇ CSV'),
    el('button', { class: 'btn btn-primary btn-sm', onclick: () => addEmployeeModal() }, '+ موظف جديد'),
    el('button', { class: 'btn btn-ghost btn-sm', onclick: () => importModal() }, '⬆ استيراد'));
}

/* ─── الجدول: تحديد + ٩ أعمدة + قائمة إجراءات ─── */
function tableCard(d: ListRes): HTMLElement {
  const card = el('div', { class: 'card', style: 'padding:var(--s-3)' });
  if (!d.rows.length) {
    card.append(emptyState({
      icon: '🔍', title: 'لا نتائج مطابقة',
      msg: 'جرّب تعديل البحث أو الفلاتر — أو أنشئ موظفاً جديداً',
      action: { label: 'مسح الفلاتر', onclick: () => { Object.assign(state, { q: '', branch: '', role: '', status: '', page: 1 }); render(); } },
    }));
    return card;
  }

  const allChecked = d.rows.every(r => selected.has(r.id));
  const headCb = el('input', { type: 'checkbox', 'aria-label': 'تحديد الكل' }) as HTMLInputElement;
  headCb.checked = allChecked;
  headCb.onchange = () => { d.rows.forEach(r => headCb.checked ? selected.add(r.id) : selected.delete(r.id)); render(); };

  const rows = d.rows.map(e => {
    const cb = el('input', { type: 'checkbox', 'aria-label': `تحديد ${e.name}` }) as HTMLInputElement;
    cb.checked = selected.has(e.id);
    cb.onchange = () => { cb.checked ? selected.add(e.id) : selected.delete(e.id); render(); };
    return el('tr', { class: selected.has(e.id) ? 'row-selected' : '' },
      el('td', { class: 'sel-col' }, cb),
      el('td', {}, el('b', {}, e.name)),
      el('td', {}, e.username),
      el('td', { class: 'num', dir: 'ltr' }, e.phone || '—'),
      el('td', {}, e.branch || '—'),
      el('td', {}, e.role === 'admin' ? el('span', { class: 'chip crimson', style: 'font-size:.66rem' }, 'إدارة') : 'موظف'),
      el('td', {}, e.active ? el('span', { class: 'chip ok' }, 'فعّال') : el('span', { class: 'chip' }, 'موقوف')),
      el('td', { class: 'num t-xs t-muted' }, dateTimeFull(e.created_at)),
      el('td', { class: 'num t-xs t-muted' }, e.last_login_at ? dateTimeFull(e.last_login_at) : '—'),
      el('td', { class: 'num' }, nf.format(e.login_count)),
      el('td', { class: 'act-cell' }, actionsBtn(e)));
  });

  card.append(el('div', { class: 'table-wrap' },
    el('table', { class: 'table-compact' },
      el('thead', {}, el('tr', {},
        el('th', { class: 'sel-col' }, headCb),
        ...['الاسم', 'المستخدم', 'الهاتف', 'الفرع', 'الدور', 'الحالة', 'الإنشاء', 'آخر دخول', 'الدخولات', ''].map(h => el('th', {}, h)))),
      el('tbody', {}, ...rows))));
  return card;
}

function actionsBtn(e: Emp): HTMLElement {
  const btn = el('button', { class: 'btn btn-ghost btn-sm btn-icon', 'aria-label': `إجراءات ${e.name}` }, '⋯') as HTMLButtonElement;
  btn.onclick = (ev) => {
    ev.stopPropagation();
    if (openMenu) { openMenu.remove(); openMenu = null; }
    const item = (label: string, fn: () => void, danger = false) =>
      el('button', { class: `dropdown-item ${danger ? 'error-text' : ''}`, onclick: () => { openMenu?.remove(); openMenu = null; fn(); } }, label);
    openMenu = el('div', { class: 'dropdown-menu' },
      item('✏️ تعديل البيانات', () => editModal(e)),
      item('📜 سجل النشاط', () => activityModal(e)),
      item('🔑 كلمة مرور جديدة', async () => {
        const r = await patch<{ password: string }>(`/api/admin/employees/${e.id}`, { password: 'reset' });
        passwordModal(e.name, e.username, r.password);
      }),
      item(e.active ? '⏸ إيقاف الحساب' : '▶️ تفعيل الحساب', async () => {
        await patch(`/api/admin/employees/${e.id}`, { active: !e.active });
        toast(e.active ? 'أُوقف الحساب' : 'فُعّل الحساب', 'ok'); render();
      }),
      item('🗑 حذف نهائي', () => deleteEmployeeModal(e), true));
    btn.parentElement!.append(openMenu);
  };
  return btn;
}

/* ─── تعديل البيانات ─── */
function editModal(e: Emp): void {
  const n = el('input', { class: 'input', value: e.name }) as HTMLInputElement;
  const ph = el('input', { class: 'input', value: e.phone || '', placeholder: '07XXXXXXXXX', dir: 'ltr', inputmode: 'tel' }) as HTMLInputElement;
  const br = el('input', { class: 'input', value: e.branch || '', list: 'branches-dl' }) as HTMLInputElement;
  const dp = el('input', { class: 'input', value: e.department || '' }) as HTMLInputElement;
  const rl = el('select', { class: 'input' },
    el('option', { value: 'employee', selected: e.role === 'employee' ? '' : null }, 'موظف'),
    el('option', { value: 'admin', selected: e.role === 'admin' ? '' : null }, 'إدارة')) as HTMLSelectElement;
  const save = el('button', { class: 'btn btn-primary' }, 'حفظ التعديلات') as HTMLButtonElement;

  openModal(el('div', { class: 'grid' },
    el('h2', { style: 'font-size:var(--text-lg)' }, `تعديل — ${e.name}`),
    el('p', { class: 'helper-text' }, `اسم المستخدم ثابت: ${e.username}`),
    el('datalist', { id: 'branches-dl' }, ...branches.filter(b => b.active).map(b => el('option', { value: b.name }))),
    el('div', { class: 'field' }, el('label', {}, 'الاسم الكامل'), n),
    el('div', { class: 'field' }, el('label', {}, 'رقم الهاتف'), ph,
      el('span', { class: 'helper-text' }, 'اتركه فارغاً لإزالة الرقم')),
    el('div', { class: 'grid', style: 'grid-template-columns:1fr 1fr' },
      el('div', { class: 'field' }, el('label', {}, 'الفرع'), br),
      el('div', { class: 'field' }, el('label', {}, 'القسم'), dp)),
    el('div', { class: 'field' }, el('label', {}, 'الدور'), rl),
    save));

  save.onclick = async () => {
    save.classList.add('loading');
    try {
      await patch(`/api/admin/employees/${e.id}`,
        { name: n.value, phone: ph.value, branch: br.value, department: dp.value, role: rl.value });
      toast('حُفظت التعديلات ✓', 'ok');
      (document.querySelector('.modal-veil') as HTMLElement)?.remove();
      render();
    } catch { save.classList.remove('loading'); }
  };
}

/* ─── سجل النشاط ─── */
async function activityModal(e: Emp): Promise<void> {
  const d = await get<{ rows: any[] }>(`/api/admin/employees/${e.id}/activity`);
  const rows = d.rows.length ? d.rows.map(r =>
    el('div', { class: 'tl-row' },
      el('div', { class: 'u-flex u-gap-2 u-wrap' },
        el('span', { class: 'chip', style: 'font-size:.66rem' }, r.action),
        r.actor_id !== e.id ? el('span', { class: 't-xs t-muted' }, `بواسطة ${r.actor_name}`) : null,
        el('span', { class: 't-xs t-muted num', style: 'margin-inline-start:auto' }, dateTimeFull(r.created_at))),
      r.details ? el('span', { class: 't-sm t-muted', style: 'overflow-wrap:anywhere' }, r.details) : null))
    : [emptyState({ icon: '📜', title: 'لا نشاط بعد', msg: 'يظهر هنا كل ما يفعله الحساب وما يُجرى عليه' })];

  openModal(el('div', {},
    el('h2', { style: 'font-size:var(--text-lg);margin-bottom:4px' }, `سجل نشاط — ${e.name}`),
    el('p', { class: 'helper-text', style: 'margin-bottom:var(--s-3)' }, `آخر ${nf.format(d.rows.length)} حركة (ما فعله الحساب + ما أُجري عليه)`),
    el('div', { class: 'tl' }, ...rows)));
}

/* ─── العمليات الجماعية ─── */
function bulkBar(): HTMLElement {
  const run = async (op: string, branch?: string) => {
    const r = await post<{ done: number; skipped: { name: string; reason: string }[] }>(
      '/api/admin/employees/bulk', { op, ids: [...selected], branch });
    toast(`تم تنفيذ ${nf.format(r.done)}${r.skipped.length ? ` · تُخُطي ${nf.format(r.skipped.length)}` : ''}`, r.skipped.length ? '' : 'ok');
    if (r.skipped.length) {
      openModal(el('div', { class: 'grid' },
        el('h2', { style: 'font-size:var(--text-lg)' }, 'سجلات تُخُطيت'),
        el('div', { class: 'tl' }, ...r.skipped.map(s => el('div', { class: 'tl-row' },
          el('b', { class: 't-sm' }, s.name), el('span', { class: 't-xs t-muted' }, s.reason))))));
    }
    selected.clear(); render();
  };

  return el('div', { class: 'bulk-bar rise' },
    el('span', { class: 'chip crimson' }, `${nf.format(selected.size)} محدداً`),
    el('button', { class: 'btn btn-ghost btn-sm', onclick: () => run('enable') }, '▶️ تفعيل'),
    el('button', { class: 'btn btn-ghost btn-sm', onclick: () => run('disable') }, '⏸ إيقاف'),
    el('button', { class: 'btn btn-ghost btn-sm', onclick: () => {
      const s = el('select', { class: 'input' }, ...branches.filter(b => b.active).map(b => el('option', { value: b.name }, b.name))) as HTMLSelectElement;
      const go = el('button', { class: 'btn btn-primary' }, 'نقل') as HTMLButtonElement;
      openModal(el('div', { class: 'grid' },
        el('h2', { style: 'font-size:var(--text-lg)' }, `نقل ${nf.format(selected.size)} موظفاً إلى فرع`),
        el('div', { class: 'field' }, el('label', {}, 'الفرع الهدف'), s), go));
      go.onclick = () => { (document.querySelector('.modal-veil') as HTMLElement)?.remove(); run('move', s.value); };
    } }, '🏬 نقل لفرع'),
    el('span', { style: 'flex:1' }),
    el('button', { class: 'btn btn-danger btn-sm', onclick: () => {
      const go = el('button', { class: 'btn btn-danger' }, `نعم — حذف ${nf.format(selected.size)}`) as HTMLButtonElement;
      openModal(el('div', { class: 'grid', style: 'text-align:center' },
        el('div', { class: 'empty-ico', style: 'margin:0 auto' }, '🗑'),
        el('h2', { style: 'font-size:var(--text-lg)' }, `حذف ${nf.format(selected.size)} حساباً نهائياً؟`),
        el('p', { class: 't-muted t-sm' }, 'لا رجعة فيه — تُحذف توقعاتهم وإنجازاتهم. حسابك وآخر إدارة نشطة محميان تلقائياً.'),
        go));
      go.onclick = () => { (document.querySelector('.modal-veil') as HTMLElement)?.remove(); run('delete'); };
    } }, '🗑 حذف المحدد'),
    el('button', { class: 'btn btn-ghost btn-sm', onclick: () => { selected.clear(); render(); } }, 'إلغاء التحديد'));
}

/* ─── الترقيم ─── */
function pager(d: ListRes): HTMLElement {
  const from = (d.page - 1) * d.per + 1, to = Math.min(d.page * d.per, d.total);
  const per = el('select', { class: 'input users-sel' },
    ...[10, 25, 50].map(n => el('option', { value: String(n), selected: d.per === n ? '' : null }, `${n} / صفحة`))) as HTMLSelectElement;
  per.onchange = () => { state.per = Number(per.value); state.page = 1; render(); };
  return el('div', { class: 'pager' },
    el('span', { class: 'num' }, d.total ? `عرض ${nf.format(from)}–${nf.format(to)} من ${nf.format(d.total)}` : 'لا سجلات'),
    el('div', { class: 'u-flex u-gap-2' },
      per,
      el('button', { class: 'btn btn-ghost btn-sm', disabled: d.page <= 1 ? '' : null, onclick: () => { state.page--; render(); } }, '‹ السابق'),
      el('span', { class: 'num' }, `${nf.format(d.page)} / ${nf.format(d.pages)}`),
      el('button', { class: 'btn btn-ghost btn-sm', disabled: d.page >= d.pages ? '' : null, onclick: () => { state.page++; render(); } }, 'التالي ›')));
}

/* ─── إنشاء / كلمة مرور / حذف / استيراد ─── */
function addEmployeeModal(): void {
  const n = el('input', { class: 'input', placeholder: 'علي حسين', autocomplete: 'off' }) as HTMLInputElement;
  const u = el('input', { class: 'input', placeholder: 'ali.h', autocomplete: 'off' }) as HTMLInputElement;
  const ph = el('input', { class: 'input', placeholder: '07XXXXXXXXX', inputmode: 'tel', dir: 'ltr' }) as HTMLInputElement;
  const p1 = el('input', { class: 'input', type: 'password', autocomplete: 'new-password' }) as HTMLInputElement;
  const p2 = el('input', { class: 'input', type: 'password', autocomplete: 'new-password' }) as HTMLInputElement;
  const b = el('input', { class: 'input', placeholder: 'المنصور', list: 'branches-dl2' }) as HTMLInputElement;
  const d = el('input', { class: 'input', placeholder: 'المبيعات' }) as HTMLInputElement;
  const gen = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => {
    const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const buf = new Uint32Array(10); crypto.getRandomValues(buf);
    const pw = [...buf].map(x => chars[x % chars.length]).join('');
    p1.value = pw; p2.value = pw; p1.type = 'text'; p2.type = 'text';
  } }, '🎲 توليد كلمة مرور');
  const submit = el('button', { class: 'btn btn-primary' }, 'إنشاء الحساب') as HTMLButtonElement;

  const close = openModal(el('div', { class: 'grid' },
    el('h2', { style: 'font-size:var(--text-lg)' }, 'تسجيل موظف جديد'),
    el('datalist', { id: 'branches-dl2' }, ...branches.filter(x => x.active).map(x => el('option', { value: x.name }))),
    el('div', { class: 'field' }, el('label', {}, 'الاسم الكامل'), n),
    el('div', { class: 'field' }, el('label', {}, 'اسم المستخدم'), u),
    el('div', { class: 'field' }, el('label', {}, 'رقم الهاتف'), ph,
      el('span', { class: 'helper-text' }, 'فريد لكل موظف — الصيغة: 07XXXXXXXXX')),
    el('div', { class: 'field' }, el('label', {}, 'كلمة المرور'), p1,
      el('span', { class: 'helper-text' }, '٨ أحرف على الأقل')),
    el('div', { class: 'field' }, el('label', {}, 'تأكيد كلمة المرور'), p2),
    gen,
    el('div', { class: 'grid', style: 'grid-template-columns:1fr 1fr' },
      el('div', { class: 'field' }, el('label', {}, 'الفرع'), b),
      el('div', { class: 'field' }, el('label', {}, 'القسم'), d)),
    submit));

  submit.onclick = async () => {
    if (p1.value.length < 8) { toast('كلمة المرور: ٨ أحرف على الأقل', 'err'); return; }
    if (p1.value !== p2.value) { toast('تأكيد كلمة المرور غير مطابق', 'err'); return; }
    submit.classList.add('loading');
    try {
      const r = await post<{ password: string }>('/api/admin/employees',
        { name: n.value, username: u.value, phone: ph.value, password: p1.value, confirm: p2.value, branch: b.value, department: d.value });
      close(); passwordModal(n.value, u.value, r.password); render();
    } catch { submit.classList.remove('loading'); }
  };
}

function passwordModal(name: string, username: string, password: string): void {
  openModal(el('div', { class: 'grid', style: 'text-align:center' },
    el('h2', { style: 'font-size:var(--text-lg)' }, `بيانات دخول ${name}`),
    el('div', { class: 'card' },
      el('div', {}, 'المستخدم: ', el('b', { class: 'num' }, username)),
      el('div', {}, 'كلمة المرور: ', el('b', { class: 'num', style: 'letter-spacing:.08em' }, password))),
    el('p', { class: 't-muted t-xs' }, 'انسخها الآن — لن تظهر مرة أخرى'),
    el('button', { class: 'btn btn-ghost btn-sm', onclick: () => { navigator.clipboard?.writeText(`${username} / ${password}`); toast('نُسخت ✓', 'ok'); } }, 'نسخ')));
}

function deleteEmployeeModal(e: Emp): void {
  const btn = el('button', { class: 'btn btn-danger' }, 'نعم — حذف نهائي') as HTMLButtonElement;
  const close = openModal(el('div', { class: 'grid', style: 'text-align:center' },
    el('div', { class: 'empty-ico', style: 'margin:0 auto' }, '🗑'),
    el('h2', { style: 'font-size:var(--text-lg)' }, `حذف ${e.name}؟`),
    el('p', { class: 't-muted t-sm' }, 'حذف نهائي لا رجعة فيه — تُحذف معه كل توقعاته وإنجازاته. لإيقاف مؤقت استخدم «إيقاف».'),
    el('div', { class: 'u-center u-gap-3' }, btn,
      el('button', { class: 'btn btn-ghost', onclick: () => close() }, 'إلغاء'))));
  btn.onclick = async () => {
    btn.classList.add('loading');
    try {
      await api(`/api/admin/employees/${e.id}`, { method: 'DELETE' });
      toast(`حُذف ${e.name} نهائياً`, 'ok'); close(); render();
    } catch { btn.classList.remove('loading'); }
  };
}

function importModal(): void {
  const ta = el('textarea', { class: 'input', rows: '8',
    placeholder: 'username,الاسم الكامل,الهاتف,الفرع,القسم[,كلمة المرور]\nali.h,علي حسين,07701234567,المنصور,المبيعات' }) as HTMLTextAreaElement;
  const out = el('div', { class: 'import-out' });
  openModal(el('div', { class: 'grid' },
    el('h2', { style: 'font-size:var(--text-lg)' }, 'استيراد الموظفين'),
    el('p', { class: 'helper-text' }, 'سطر لكل موظف — الهاتف إلزامي وفريد · كلمات المرور تُولّد تلقائياً إن لم تُزوَّد (≥٨)'),
    ta,
    el('button', { class: 'btn btn-primary', onclick: async () => {
      const r = await post<{ created: any[]; errors: { no: number; reason: string }[] }>('/api/admin/employees/import', { csv: ta.value });
      out.innerHTML = '';
      if (r.created.length) {
        const csv = 'username,password,name,phone\n' + r.created.map(c => `${c.username},${c.password},${c.name},${c.phone}`).join('\n');
        const url = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv' }));
        out.append(
          el('div', { class: 'chip ok', style: 'margin-bottom:10px' }, `أُنشئ ${nf.format(r.created.length)} حساباً`),
          el('a', { class: 'btn btn-ghost btn-sm', href: url, download: 'بيانات-الدخول.csv' }, '⬇ تنزيل بيانات الدخول'));
      }
      if (r.errors.length) {
        out.append(el('div', { class: 'chip-danger chip', style: 'margin:10px 0 6px' }, `${nf.format(r.errors.length)} سطراً مرفوضاً`),
          el('div', { class: 'tl' }, ...r.errors.map(x => el('div', { class: 'tl-row' },
            el('b', { class: 't-sm num' }, `سطر ${nf.format(x.no)}`),
            el('span', { class: 't-xs t-muted' }, x.reason)))));
      }
      render();
    } }, 'استيراد'),
    out));
}
