type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, any> = {}, ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = String(v);
    else if (k === 'html') node.innerHTML = String(v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'dataset') Object.assign((node as HTMLElement).dataset, v);
    else node.setAttribute(k, String(v));
  }
  const flat = (arr: readonly unknown[]): unknown[] =>
    arr.reduce<unknown[]>((acc, c) => acc.concat(Array.isArray(c) ? flat(c) : c), []);
  for (const c of flat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// ─── toast ───────────────────────────────────────────────────────
let toastHost: HTMLElement | null = null;
export function toast(msg: string, kind: 'ok' | 'err' | 'gold' | '' = '', ms = 3400): void {
  if (!toastHost) { toastHost = el('div', { class: 'toasts' }); document.body.append(toastHost); }
  const icon = kind === 'ok' ? '✓' : kind === 'err' ? '✕' : kind === 'gold' ? '🏆' : '';
  const t = el('div', { class: `toast ${kind}` }, icon && el('span', {}, icon), el('span', {}, msg));
  toastHost.append(t);
  setTimeout(() => { t.style.transition = 'opacity .4s, transform .4s'; t.style.opacity = '0'; t.style.transform = 'translateY(10px)'; setTimeout(() => t.remove(), 420); }, ms);
}

// ─── modal ───────────────────────────────────────────────────────
export function openModal(content: HTMLElement): () => void {
  const veil = el('div', { class: 'modal-veil' });
  const box = el('div', { class: 'modal' }, content);
  veil.append(box);
  const close = () => { veil.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  veil.addEventListener('click', (e) => { if (e.target === veil) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(veil);
  return close;
}

export function skeleton(h: number, w = '100%'): HTMLElement {
  return el('div', { class: 'skel', style: `height:${h}px;width:${w}` });
}

// ─── الحالة الفارغة الموقّعة ───────────────────────────────────────
export interface EmptyOpts {
  icon: string; title: string; msg: string;
  action?: { label: string; href?: string; onclick?: () => void };
}
export function emptyState(o: EmptyOpts): HTMLElement {
  const root = el('div', { class: 'empty-state' },
    el('div', { class: 'empty-ico', 'aria-hidden': 'true' }, o.icon),
    el('h4', {}, o.title),
    el('p', {}, o.msg));
  if (o.action) {
    root.append(o.action.href
      ? el('a', { class: 'btn btn-ghost btn-sm', href: o.action.href }, o.action.label)
      : el('button', { class: 'btn btn-ghost btn-sm', onclick: o.action.onclick }, o.action.label));
  }
  root.append(el('img', { class: 'empty-brand', src: '/assets/brand/mark-192.png', alt: '' }));
  return root;
}

// ─── هياكل التحميل (aria-busy · تحترم reduced-motion عبر التوكنز) ───
function skelHost(...children: (Node | string)[]): HTMLElement {
  return el('div', { class: 'skel-stack', role: 'status', 'aria-busy': 'true' },
    el('span', { class: 'sr-only' }, 'جارٍ التحميل'), ...children);
}
const sk = (h: number, w = '100%', extra = '') => el('div', { class: `skel ${extra}`.trim(), style: `height:${h}px;width:${w}` });

export function skeletonCard(h = 120): HTMLElement {
  return skelHost(el('div', { class: 'card' }, el('div', { class: 'skel-stack' }, sk(18, '38%'), sk(12), sk(12, '82%'), sk(h - 78))));
}
export function skeletonMatchGrid(n = 4): HTMLElement {
  const g = el('div', { class: 'match-grid' });
  for (let i = 0; i < n; i++) {
    g.append(el('div', { class: 'card' }, el('div', { class: 'skel-stack' },
      sk(22, '55%'), el('div', { class: 'skel-row', style: 'padding:0' }, sk(42, '64px'), sk(30, '52%'), sk(42, '64px')), sk(38))));
  }
  return skelHost(g);
}
export function skeletonBoard(rows = 7): HTMLElement {
  const list = el('div', { class: 'card', style: 'padding:var(--s-3)' });
  for (let i = 0; i < rows; i++) {
    list.append(el('div', { class: 'skel-row' }, sk(36, '36px', 'skel-circle'), sk(14, `${78 - i * 4}%`), sk(18, '46px')));
  }
  return skelHost(list);
}
export function skeletonTable(rows = 6): HTMLElement {
  const t = el('div', { class: 'card' }, sk(18, '30%'));
  const body = el('div', { class: 'skel-stack', style: 'margin-top:var(--s-4)' });
  for (let i = 0; i < rows; i++) body.append(sk(34));
  t.append(body);
  return skelHost(t);
}
export function skeletonDashboard(): HTMLElement {
  const strip = el('div', { class: 'stats-strip' });
  for (let i = 0; i < 4; i++) strip.append(el('div', { class: 'card' }, sk(56)));
  return skelHost(sk(320, '100%'), strip, sk(180));
}