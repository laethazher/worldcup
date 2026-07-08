import { countdownParts, pad } from './format.js';
import { el } from './ui.js';

const LABELS = ['يوم', 'ساعة', 'دقيقة', 'ثانية'];

export function mountCountdown(host: HTMLElement, utc: string, opts: { compact?: boolean; onDone?: () => void } = {}): () => void {
  host.innerHTML = '';
  const wrap = el('div', { class: `countdown ${opts.compact ? 'compact' : ''}` });
  const cells = LABELS.map(label => {
    const num = el('div', { class: 'cd-num num' }, '00');
    wrap.append(el('div', { class: 'cd-cell' }, num, el('div', { class: 'cd-label' }, label)));
    return num;
  });
  host.append(wrap);

  let prev = ['', '', '', ''];
  let doneFired = false;
  const render = () => {
    const p = countdownParts(utc);
    const vals = [pad(p.d), pad(p.h), pad(p.m), pad(p.s)];
    vals.forEach((v, i) => {
      if (v !== prev[i]) {
        cells[i].textContent = v;
        cells[i].classList.remove('tick');
        void cells[i].offsetWidth;
        cells[i].classList.add('tick');
        prev[i] = v;
      }
    });
    if (p.done && !doneFired) { doneFired = true; opts.onDone?.(); }
  };
  render();
  const iv = setInterval(render, 1000);
  return () => clearInterval(iv);
}
