import { get, post, api } from '../api.js';
import { el, toast, openModal, emptyState } from '../ui.js';
import { dateTimeFull, nf } from '../format.js';

interface Sent {
  id: number; title: string; body: string; type: string; priority: string;
  target_type: string; target_label: string; recipients: number; reads: number;
  sender_name: string | null; created_at: string;
}
interface ListRes { rows: Sent[]; total: number; page: number; per: number; pages: number; }

const st = { q: '', type: '', target_type: '', page: 1, per: 10 };
let host: HTMLElement;
const PRIO_L: Record<string, string> = { critical: 'حرجة', high: 'عالية', normal: 'عادية', low: 'منخفضة' };

export async function notifyTab(body: HTMLElement): Promise<void> {
  host = el('div', { class: 'grid' });
  body.append(composer(), host);
  await renderSent();
}

/* ─── المُرسِل المستهدف ─── */
function composer(): HTMLElement {
  const t = el('input', { class: 'input', placeholder: 'مثال: انطلقت توقعات النهائي 🏆', maxlength: '120' }) as HTMLInputElement;
  const b = el('textarea', { class: 'input', rows: '3', placeholder: 'نص الإشعار…', maxlength: '2000' }) as HTMLTextAreaElement;
  const prio = el('select', { class: 'input' },
    ...Object.entries(PRIO_L).reverse().map(([v, l]) => el('option', { value: v, selected: v === 'normal' ? '' : null }, l))) as HTMLSelectElement;
  const tt = el('select', { class: 'input' },
    ...[['all', 'كل الموظفين'], ['branch', 'فرع محدد'], ['department', 'قسم محدد'], ['employee', 'موظف واحد'], ['role', 'حسب الدور']]
      .map(([v, l]) => el('option', { value: v }, l))) as HTMLSelectElement;
  const targetHost = el('div', { class: 'field', hidden: '' });
  let targetSel: HTMLSelectElement | null = null;

  tt.onchange = async () => {
    targetHost.innerHTML = ''; targetSel = null;
    if (tt.value === 'all') { targetHost.setAttribute('hidden', ''); return; }
    targetHost.removeAttribute('hidden');
    targetHost.append(el('label', {}, 'الهدف'));
    if (tt.value === 'role') {
      targetSel = el('select', { class: 'input' },
        el('option', { value: 'employee' }, 'كل الموظفين (غير الإدارة)'),
        el('option', { value: 'admin' }, 'الإدارة فقط')) as HTMLSelectElement;
    } else if (tt.value === 'branch') {
      const bs = await get<{ id: number; name: string; active: number }[]>('/api/admin/branches');
      targetSel = el('select', { class: 'input' },
        ...bs.filter(x => x.active).map(x => el('option', { value: String(x.id) }, x.name))) as HTMLSelectElement;
    } else if (tt.value === 'department') {
      const bs = await get<{ id: number; name: string; active: number }[]>('/api/admin/branches');
      const bSel = el('select', { class: 'input' },
        ...bs.filter(x => x.active).map(x => el('option', { value: String(x.id) }, x.name))) as HTMLSelectElement;
      targetSel = el('select', { class: 'input' }) as HTMLSelectElement;
      const loadDepts = async () => {
        const d = await get<{ rows: { id: number; name: string }[] }>(`/api/admin/orgs/departments?branch=${bSel.value}&status=active&per=100`);
        targetSel!.innerHTML = '';
        for (const x of d.rows) targetSel!.append(el('option', { value: String(x.id) }, x.name));
        if (!d.rows.length) targetSel!.append(el('option', { value: '' }, '— لا أقسام نشطة —'));
      };
      bSel.onchange = loadDepts;
      targetHost.append(el('span', { class: 'helper-text' }, 'اختر الفرع ثم القسم'), bSel);
      await loadDepts();
    } else {
      const d = await get<{ rows: { id: number; name: string; username: string }[] }>('/api/admin/employees?per=100&status=active&sort=name');
      targetSel = el('select', { class: 'input' },
        ...d.rows.map(x => el('option', { value: String(x.id) }, `${x.name} (${x.username})`))) as HTMLSelectElement;
    }
    if (targetSel) targetHost.append(targetSel);
  };

  const send = el('button', { class: 'btn btn-primary' }, '📣 إرسال الإشعار') as HTMLButtonElement;
  send.onclick = async () => {
    send.classList.add('loading');
    try {
      const r = await post<{ recipients: number }>('/api/admin/notifications',
        { title: t.value, body: b.value, priority: prio.value, target_type: tt.value, target_id: targetSel?.value ?? null });
      toast(`أُرسل إلى ${nf.format(r.recipients)} مستلماً ✓ — وصل حياً للمتصلين`, 'ok');
      t.value = ''; b.value = ''; st.page = 1; renderSent();
    } finally { send.classList.remove('loading'); }
  };

  return el('div', { class: 'card', style: 'max-width:680px' },
    el('div', { class: 'card-title' }, el('h3', {}, '📣 إرسال إشعار'), el('span', { class: 'chip' }, 'يصل فوراً للمستهدفين المتصلين')),
    el('div', { class: 'grid' },
      el('div', { class: 'field' }, el('label', {}, 'العنوان'), t),
      el('div', { class: 'field' }, el('label', {}, 'النص'), b),
      el('div', { class: 'grid', style: 'grid-template-columns:1fr 1fr' },
        el('div', { class: 'field' }, el('label', {}, 'الأولوية'), prio),
        el('div', { class: 'field' }, el('label', {}, 'الاستهداف'), tt)),
      targetHost,
      send));
}

/* ─── أرشيف المرسَل ─── */
async function renderSent(): Promise<void> {
  const d = await get<ListRes>(`/api/admin/notifications?${new URLSearchParams(Object.entries(st).map(([k, v]) => [k, String(v)]))}`);
  st.page = d.page;
  host.innerHTML = '';

  let deb = 0;
  const search = el('input', { class: 'input users-search', placeholder: '🔍 بحث بالأرشيف', value: st.q }) as HTMLInputElement;
  search.oninput = () => { clearTimeout(deb); deb = setTimeout(() => { st.q = search.value; st.page = 1; renderSent(); }, 300) as unknown as number; };
  const sel = (opts: [string, string][], val: string, on: (v: string) => void) => {
    const s = el('select', { class: 'input users-sel' },
      ...opts.map(([v, l]) => el('option', { value: v, selected: val === v ? '' : null }, l))) as HTMLSelectElement;
    s.onchange = () => { on(s.value); st.page = 1; renderSent(); };
    return s;
  };
  host.append(el('div', { class: 'card card-compact users-toolbar' },
    el('h3', { style: 'font-size:var(--text-md)' }, '🗄 أرشيف الإشعارات'),
    search,
    sel([['', 'كل الأنواع'], ['system', 'النظام'], ['admin', 'الإدارة']], st.type, v => st.type = v),
    sel([['', 'كل الأهداف'], ['all', 'الجميع'], ['branch', 'فرع'], ['department', 'قسم'], ['employee', 'موظف'], ['role', 'دور']], st.target_type, v => st.target_type = v)));

  const card = el('div', { class: 'card', style: 'padding:var(--s-3)' });
  if (!d.rows.length) {
    card.append(emptyState({ icon: '🗄', title: 'لا إشعارات بالأرشيف', msg: 'كل ما يُرسل — إدارياً أو من النظام — يُؤرشف هنا' }));
  } else {
    card.append(el('div', { class: 'table-wrap' }, el('table', { class: 'table-compact' },
      el('thead', {}, el('tr', {}, ...['الإشعار', 'النوع', 'الأولوية', 'الهدف', 'المستلمون', 'قرأه', 'التوقيت', ''].map(h => el('th', {}, h)))),
      el('tbody', {}, ...d.rows.map(n => el('tr', {},
        el('td', { style: 'max-width:280px' }, el('b', { class: 't-sm' }, n.title),
          n.body ? el('div', { class: 't-xs t-muted', style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, n.body) : null),
        el('td', {}, el('span', { class: `chip ${n.type === 'system' ? 'chip-info' : 'crimson'}`, style: 'font-size:.62rem' }, n.type === 'system' ? 'النظام' : 'الإدارة')),
        el('td', { class: 't-sm' }, PRIO_L[n.priority] ?? n.priority),
        el('td', { class: 't-sm' }, n.target_label),
        el('td', { class: 'num' }, nf.format(n.recipients)),
        el('td', { class: 'num' }, nf.format(n.reads)),
        el('td', { class: 'num t-xs t-muted' }, dateTimeFull(n.created_at)),
        el('td', {}, el('button', { class: 'btn btn-danger btn-sm', 'aria-label': 'حذف نهائي', onclick: () => {
          const go = el('button', { class: 'btn btn-danger' }, 'نعم — حذف للجميع') as HTMLButtonElement;
          const close = openModal(el('div', { class: 'grid', style: 'text-align:center' },
            el('h2', { style: 'font-size:var(--text-lg)' }, `حذف «${n.title}»؟`),
            el('p', { class: 't-muted t-sm' }, 'يُحذف نهائياً من مراكز كل الموظفين ومن الأرشيف.'),
            el('div', { class: 'u-center u-gap-3' }, go, el('button', { class: 'btn btn-ghost', onclick: () => close() }, 'إلغاء'))));
          go.onclick = async () => {
            await api(`/api/admin/notifications/${n.id}`, { method: 'DELETE' });
            toast('حُذف ✓', 'ok'); close(); renderSent();
          };
        } }, '🗑')))))))); 
  }
  const from = d.total ? (d.page - 1) * d.per + 1 : 0, to = Math.min(d.page * d.per, d.total);
  card.append(el('div', { class: 'pager', style: 'padding:var(--s-3) var(--s-2) 0' },
    el('span', { class: 'num' }, d.total ? `عرض ${nf.format(from)}–${nf.format(to)} من ${nf.format(d.total)}` : 'لا سجلات'),
    el('div', { class: 'u-flex u-gap-2' },
      el('button', { class: 'btn btn-ghost btn-sm', disabled: d.page <= 1 ? '' : null, onclick: () => { st.page = d.page - 1; renderSent(); } }, '‹ السابق'),
      el('span', { class: 'num' }, `${nf.format(d.page)} / ${nf.format(d.pages)}`),
      el('button', { class: 'btn btn-ghost btn-sm', disabled: d.page >= d.pages ? '' : null, onclick: () => { st.page = d.page + 1; renderSent(); } }, 'التالي ›'))));
  host.append(card);
}
