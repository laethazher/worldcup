import { get } from '../api.js';
import { el, openModal, emptyState } from '../ui.js';
import { dateTimeFull, nf } from '../format.js';

interface Row {
  id: number; created_at: string; actor_id: number | null; actor_name: string;
  actor_username: string | null; actor_role: string | null; actor_branch: string | null;
  ip: string | null; user_agent: string | null; action: string; entity: string;
  entity_id: string; details: string; res: 'success' | 'failure';
}
interface ListRes { rows: Row[]; total: number; page: number; per: number; pages: number; }
interface Meta { actions: string[]; actors: { id: number; name: string }[]; }

const st = { q: '', action: '', actor: '', result: '', from: '', to: '', sort: 'time', dir: 'desc', page: 1, per: 15 };
let host: HTMLElement;
let meta: Meta = { actions: [], actors: [] };

const qs = () => new URLSearchParams(Object.entries(st).map(([k, v]) => [k, String(v)])).toString();

export async function auditTab(body: HTMLElement): Promise<void> {
  host = el('div', { class: 'grid' });
  body.append(host);
  meta = await get<Meta>('/api/admin/audit/meta');
  await render();
}

async function render(): Promise<void> {
  const d = await get<ListRes>(`/api/admin/audit?${qs()}`);
  st.page = d.page;
  host.innerHTML = '';
  host.append(toolbar(), tableCard(d));
}

function toolbar(): HTMLElement {
  let deb = 0;
  const search = el('input', { class: 'input users-search', placeholder: '🔍 مستخدم / تفاصيل / هدف', value: st.q }) as HTMLInputElement;
  search.oninput = () => { clearTimeout(deb); deb = setTimeout(() => { st.q = search.value; st.page = 1; render(); }, 300) as unknown as number; };

  const sel = (opts: [string, string][], val: string, on: (v: string) => void) => {
    const s = el('select', { class: 'input users-sel' },
      ...opts.map(([v, l]) => el('option', { value: v, selected: val === v ? '' : null }, l))) as HTMLSelectElement;
    s.onchange = () => { on(s.value); st.page = 1; render(); };
    return s;
  };
  const date = (val: string, label: string, on: (v: string) => void) => {
    const i = el('input', { class: 'input users-sel', type: 'date', value: val, 'aria-label': label, dir: 'ltr' }) as HTMLInputElement;
    i.onchange = () => { on(i.value); st.page = 1; render(); };
    return i;
  };

  return el('div', { class: 'card card-compact users-toolbar' },
    el('h3', { style: 'font-size:var(--text-md)' }, '📜 سجل التدقيق'),
    el('span', { class: 'chip' }, 'قراءة فقط'),
    search,
    sel([['', 'كل الحركات'], ...meta.actions.map(a => [a, a] as [string, string])], st.action, v => st.action = v),
    sel([['', 'كل المستخدمين'], ...meta.actors.map(a => [String(a.id), a.name] as [string, string])], st.actor, v => st.actor = v),
    sel([['', 'كل النتائج'], ['success', 'نجاح'], ['failure', 'فشل']], st.result, v => st.result = v),
    date(st.from, 'من تاريخ', v => st.from = v),
    el('span', { class: 't-xs t-muted' }, 'إلى'),
    date(st.to, 'إلى تاريخ', v => st.to = v),
    sel([['time', 'فرز: التوقيت'], ['actor', 'فرز: المستخدم'], ['action', 'فرز: الحركة'], ['result', 'فرز: النتيجة']], st.sort, v => st.sort = v),
    el('button', { class: 'btn btn-ghost btn-sm btn-icon', title: 'اتجاه الفرز',
      onclick: () => { st.dir = st.dir === 'asc' ? 'desc' : 'asc'; render(); } }, st.dir === 'asc' ? '↑' : '↓'),
    el('span', { style: 'flex:1' }),
    el('a', { class: 'btn btn-ghost btn-sm', href: `/api/admin/export/audit.xlsx?${qs()}` }, '⬇ Excel'),
    el('a', { class: 'btn btn-ghost btn-sm', href: `/api/admin/export/audit.csv?${qs()}` }, '⬇ CSV'));
}

function tableCard(d: ListRes): HTMLElement {
  const card = el('div', { class: 'card', style: 'padding:var(--s-3)' });
  if (!d.rows.length) {
    card.append(emptyState({
      icon: '📜', title: 'لا سجلات مطابقة', msg: 'عدّل الفلاتر أو المدى الزمني',
      action: { label: 'مسح الفلاتر', onclick: () => { Object.assign(st, { q: '', action: '', actor: '', result: '', from: '', to: '', page: 1 }); render(); } },
    }));
    card.append(pager(d));
    return card;
  }

  const rows = d.rows.map(r => {
    const tr = el('tr', { style: 'cursor:pointer', tabindex: '0', role: 'button', 'aria-label': `تفاصيل حركة ${r.action}` },
      el('td', { class: 'num t-xs t-muted', style: 'white-space:nowrap' }, dateTimeFull(r.created_at)),
      el('td', {}, el('b', { class: 't-sm' }, r.actor_name),
        r.actor_username ? el('div', { class: 't-xs t-muted num', dir: 'ltr' }, r.actor_username) : null),
      el('td', {}, r.actor_role ? el('span', { class: `chip ${r.actor_role === 'admin' ? 'crimson' : ''}`, style: 'font-size:.64rem' }, r.actor_role === 'admin' ? 'إدارة' : 'موظف') : '—'),
      el('td', { class: 't-sm' }, r.actor_branch || '—'),
      el('td', {}, el('span', { class: 'chip', style: 'font-size:.64rem' }, r.action)),
      el('td', { class: 't-xs t-muted num' }, r.entity ? `${r.entity}${r.entity_id ? '#' + r.entity_id : ''}` : '—'),
      el('td', {}, el('span', { class: `chip ${r.res === 'failure' ? 'chip-danger' : 'ok'}`, style: 'font-size:.64rem' }, r.res === 'failure' ? 'فشل' : 'نجاح')),
      el('td', { class: 't-xs t-muted', style: 'max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, r.details || '—'));
    const open = () => detailModal(r);
    tr.onclick = open;
    tr.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } };
    return tr;
  });

  card.append(el('div', { class: 'table-wrap' },
    el('table', { class: 'table-compact' },
      el('thead', {}, el('tr', {}, ...['التوقيت', 'المستخدم', 'الدور', 'الفرع', 'الحركة', 'الهدف', 'النتيجة', 'التفاصيل'].map(h => el('th', {}, h)))),
      el('tbody', {}, ...rows))),
    pager(d));
  return card;
}

function detailModal(r: Row): void {
  const kv = (label: string, v: Node | string) =>
    el('div', { class: 'kv-row' }, el('dt', {}, label), el('dd', {}, v));
  openModal(el('div', {},
    el('h2', { style: 'font-size:var(--text-lg);margin-bottom:var(--s-3)' }, `حركة #${nf.format(r.id)}`),
    el('dl', { class: 'kv' },
      kv('التوقيت', el('span', { class: 'num' }, dateTimeFull(r.created_at))),
      kv('المستخدم', r.actor_name),
      kv('اسم المستخدم', r.actor_username ? el('bdi', { dir: 'ltr', class: 'num' }, r.actor_username) : '—'),
      kv('الدور', r.actor_role ? (r.actor_role === 'admin' ? 'إدارة' : 'موظف') : '—'),
      kv('الفرع', r.actor_branch || '—'),
      kv('عنوان IP', r.ip ? el('bdi', { dir: 'ltr', class: 'num' }, r.ip) : '—'),
      kv('User-Agent', r.user_agent ? el('span', { class: 't-xs', dir: 'ltr', style: 'overflow-wrap:anywhere' }, r.user_agent) : '—'),
      kv('الحركة', el('span', { class: 'chip' }, r.action)),
      kv('الهدف', r.entity ? `${r.entity}${r.entity_id ? '#' + r.entity_id : ''}` : '—'),
      kv('التفاصيل', el('span', { style: 'overflow-wrap:anywhere' }, r.details || '—')),
      kv('النتيجة', el('span', { class: `chip ${r.res === 'failure' ? 'chip-danger' : 'ok'}` }, r.res === 'failure' ? 'فشل' : 'نجاح')))));
}

function pager(d: ListRes): HTMLElement {
  const from = d.total ? (d.page - 1) * d.per + 1 : 0, to = Math.min(d.page * d.per, d.total);
  const per = el('select', { class: 'input users-sel' },
    ...[15, 30, 50, 100].map(n => el('option', { value: String(n), selected: d.per === n ? '' : null }, `${n} / صفحة`))) as HTMLSelectElement;
  per.onchange = () => { st.per = Number(per.value); st.page = 1; render(); };
  return el('div', { class: 'pager', style: 'padding:var(--s-3) var(--s-2) 0' },
    el('span', { class: 'num' }, d.total ? `عرض ${nf.format(from)}–${nf.format(to)} من ${nf.format(d.total)}` : 'لا سجلات'),
    el('div', { class: 'u-flex u-gap-2' }, per,
      el('button', { class: 'btn btn-ghost btn-sm', disabled: d.page <= 1 ? '' : null, onclick: () => { st.page = d.page - 1; render(); } }, '‹ السابق'),
      el('span', { class: 'num' }, `${nf.format(d.page)} / ${nf.format(d.pages)}`),
      el('button', { class: 'btn btn-ghost btn-sm', disabled: d.page >= d.pages ? '' : null, onclick: () => { st.page = d.page + 1; render(); } }, 'التالي ›')));
}
