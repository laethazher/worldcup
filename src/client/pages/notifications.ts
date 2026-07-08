import { get, post } from '../api.js';
import { el, toast, emptyState, skeletonBoard } from '../ui.js';
import { dateTimeFull, nf } from '../format.js';
import { initNav, setNotifBadge } from '../nav.js';

interface N {
  id: number; title: string; body: string; type: 'system' | 'admin';
  priority: 'low' | 'normal' | 'high' | 'critical';
  sender_name: string | null; created_at: string; read: 0 | 1;
}
interface ListRes { rows: N[]; total: number; page: number; per: number; pages: number; unread: number; }

const st = { q: '', type: '', priority: '', status: '', sort: 'time', dir: 'desc', page: 1, per: 10 };
const selected = new Set<number>();
const main = document.getElementById('app')!;
let host: HTMLElement;

const PRIO: Record<string, [string, string]> = {
  critical: ['حرجة', 'chip-danger'], high: ['عالية', 'gold'],
  normal: ['عادية', ''], low: ['منخفضة', 'chip-neutral'],
};
const qs = () => new URLSearchParams(Object.entries(st).map(([k, v]) => [k, String(v)])).toString();

async function render(): Promise<void> {
  const d = await get<ListRes>(`/api/notifications?${qs()}`);
  st.page = d.page;
  setNotifBadge(d.unread);
  host.innerHTML = '';
  host.append(toolbar(d.unread), list(d), pager(d));
  if (selected.size) host.append(bulkBar());
}

function toolbar(unread: number): HTMLElement {
  let deb = 0;
  const search = el('input', { class: 'input users-search', placeholder: '🔍 بحث بالعنوان أو النص', value: st.q }) as HTMLInputElement;
  search.oninput = () => { clearTimeout(deb); deb = setTimeout(() => { st.q = search.value; st.page = 1; render(); }, 300) as unknown as number; };
  const sel = (opts: [string, string][], val: string, on: (v: string) => void) => {
    const s = el('select', { class: 'input users-sel' },
      ...opts.map(([v, l]) => el('option', { value: v, selected: val === v ? '' : null }, l))) as HTMLSelectElement;
    s.onchange = () => { on(s.value); st.page = 1; render(); };
    return s;
  };
  return el('div', { class: 'card card-compact users-toolbar' },
    search,
    sel([['', 'كل الأنواع'], ['system', 'النظام'], ['admin', 'الإدارة']], st.type, v => st.type = v),
    sel([['', 'كل الأولويات'], ['critical', 'حرجة'], ['high', 'عالية'], ['normal', 'عادية'], ['low', 'منخفضة']], st.priority, v => st.priority = v),
    sel([['', 'الكل'], ['unread', 'غير مقروء'], ['read', 'مقروء']], st.status, v => st.status = v),
    sel([['time', 'فرز: التوقيت'], ['priority', 'فرز: الأولوية']], st.sort, v => st.sort = v),
    el('button', { class: 'btn btn-ghost btn-sm btn-icon', title: 'اتجاه الفرز',
      onclick: () => { st.dir = st.dir === 'asc' ? 'desc' : 'asc'; render(); } }, st.dir === 'asc' ? '↑' : '↓'),
    el('span', { style: 'flex:1' }),
    unread ? el('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
      await post('/api/notifications/read-all', {});
      toast('عُلّم الكل مقروءاً ✓', 'ok'); selected.clear(); render();
    } }, `✓ تعليم الكل مقروءاً (${nf.format(unread)})`) : null);
}

function list(d: ListRes): HTMLElement {
  const wrap = el('div', { class: 'grid', style: 'gap:var(--s-3)' });
  if (!d.rows.length) {
    wrap.append(el('div', { class: 'card' }, emptyState({
      icon: '📣', title: 'لا إشعارات هنا', msg: 'كل الجديد من الإدارة والنظام يصلك بهذه الصفحة فور إرساله',
      action: (st.q || st.type || st.priority || st.status)
        ? { label: 'مسح الفلاتر', onclick: () => { Object.assign(st, { q: '', type: '', priority: '', status: '', page: 1 }); render(); } }
        : { label: 'الرئيسية', href: '/index.html' },
    })));
    return wrap;
  }
  for (const n of d.rows) wrap.append(item(n));
  return wrap;
}

function item(n: N): HTMLElement {
  const cb = el('input', { type: 'checkbox', 'aria-label': `تحديد «${n.title}»` }) as HTMLInputElement;
  cb.checked = selected.has(n.id);
  cb.onchange = () => { cb.checked ? selected.add(n.id) : selected.delete(n.id); render(); };
  const [pl, pc] = PRIO[n.priority] ?? PRIO.normal;
  return el('article', { class: `card card-compact notif-item ${n.read ? '' : 'notif-unread'}` },
    el('div', { class: 'u-flex u-gap-3', style: 'align-items:flex-start' },
      cb,
      el('div', { style: 'flex:1;min-width:0' },
        el('div', { class: 'u-flex u-gap-2 u-wrap' },
          el('b', {}, n.title),
          el('span', { class: `chip ${n.type === 'system' ? 'chip-info' : 'crimson'}`, style: 'font-size:.62rem' }, n.type === 'system' ? 'النظام' : 'الإدارة'),
          el('span', { class: `chip ${pc}`, style: 'font-size:.62rem' }, pl),
          n.read ? null : el('span', { class: 'chip crimson', style: 'font-size:.62rem' }, 'جديد')),
        n.body ? el('p', { class: 't-sm', style: 'margin:6px 0 0;color:var(--ink-2);white-space:pre-wrap' }, n.body) : null,
        el('div', { class: 't-xs t-muted num', style: 'margin-top:8px' },
          `${n.sender_name || 'الإدارة'} · ${dateTimeFull(n.created_at)}`)),
      el('div', { class: 'u-flex u-gap-2' },
        n.read ? null : el('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
          const r = await post<{ unread: number }>('/api/notifications/read', { ids: [n.id] });
          setNotifBadge(r.unread); render();
        } }, '✓'),
        el('button', { class: 'btn btn-ghost btn-sm', 'aria-label': 'حذف', onclick: async () => {
          const r = await post<{ unread: number }>('/api/notifications/hide', { ids: [n.id] });
          setNotifBadge(r.unread); toast('حُذف من مركزك', 'ok'); selected.delete(n.id); render();
        } }, '🗑'))));
}

function bulkBar(): HTMLElement {
  const run = async (path: string, okMsg: string) => {
    const r = await post<{ unread: number }>(path, { ids: [...selected] });
    setNotifBadge(r.unread); toast(okMsg, 'ok'); selected.clear(); render();
  };
  return el('div', { class: 'bulk-bar rise' },
    el('span', { class: 'chip crimson' }, `${nf.format(selected.size)} محدداً`),
    el('button', { class: 'btn btn-ghost btn-sm', onclick: () => run('/api/notifications/read', 'عُلّمت مقروءة ✓') }, '✓ تعليم مقروءاً'),
    el('button', { class: 'btn btn-danger btn-sm', onclick: () => run('/api/notifications/hide', 'حُذفت من مركزك ✓') }, '🗑 حذف المحدد'),
    el('span', { style: 'flex:1' }),
    el('button', { class: 'btn btn-ghost btn-sm', onclick: () => { selected.clear(); render(); } }, 'إلغاء التحديد'));
}

function pager(d: ListRes): HTMLElement {
  const from = d.total ? (d.page - 1) * d.per + 1 : 0, to = Math.min(d.page * d.per, d.total);
  return el('div', { class: 'pager' },
    el('span', { class: 'num' }, d.total ? `عرض ${nf.format(from)}–${nf.format(to)} من ${nf.format(d.total)}` : 'لا سجلات'),
    el('div', { class: 'u-flex u-gap-2' },
      el('button', { class: 'btn btn-ghost btn-sm', disabled: d.page <= 1 ? '' : null, onclick: () => { st.page = d.page - 1; render(); } }, '‹ السابق'),
      el('span', { class: 'num' }, `${nf.format(d.page)} / ${nf.format(d.pages)}`),
      el('button', { class: 'btn btn-ghost btn-sm', disabled: d.page >= d.pages ? '' : null, onclick: () => { st.page = d.page + 1; render(); } }, 'التالي ›')));
}

initNav().then(() => {
  main.append(el('div', { class: 'rise', style: 'margin-bottom:18px' },
    el('p', { class: 'eyebrow' }, 'مركز الإشعارات'),
    el('h1', { style: 'font-size:var(--text-xl)' }, 'إشعاراتك')));
  host = el('div', { class: 'grid rise-2' }, skeletonBoard(5));
  main.append(host);
  render();
  document.addEventListener('ahc:notifications', () => render());
});
