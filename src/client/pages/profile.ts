import { get, post } from '../api.js';
import { el, toast } from '../ui.js';
import { dateTimeFull, nf } from '../format.js';
import { initNav } from '../nav.js';

interface Profile {
  id: number; username: string; name: string; phone: string | null;
  department: string; branch: string | null; role: string; active: number;
  created_at: string; last_login_at: string | null; login_count: number;
}

const main = document.getElementById('app')!;

function kv(label: string, value: Node | string): HTMLElement {
  return el('div', { class: 'kv-row' }, el('dt', {}, label), el('dd', {}, value));
}

async function load(): Promise<void> {
  const p = await get<Profile>('/api/profile');
  main.innerHTML = '';

  main.append(el('div', { class: 'rise', style: 'margin-bottom:22px' },
    el('p', { class: 'eyebrow' }, 'إعدادات الحساب'),
    el('h1', { style: 'font-size:var(--text-xl)' }, p.name)));

  // ─── معلومات الحساب ───
  main.append(el('section', { class: 'card rise-2' },
    el('div', { class: 'card-title' }, el('h3', {}, 'معلومات الحساب')),
    el('dl', { class: 'kv' },
      kv('الاسم الكامل', el('span', {}, p.name, ' ',
        el('span', { class: 'chip', style: 'font-size:.66rem' }, 'تعديل الاسم عبر الإدارة'))),
      kv('اسم المستخدم', el('bdi', { dir: 'ltr', class: 'num' }, p.username)),
      kv('رقم الهاتف', p.phone ? el('bdi', { dir: 'ltr', class: 'num' }, p.phone) : '—'),
      kv('حالة الحساب', el('span', { class: `chip ${p.active ? 'ok' : ''}` }, p.active ? 'فعّال' : 'موقوف')),
      kv('تاريخ الإنشاء', el('span', { class: 'num' }, dateTimeFull(p.created_at))),
      kv('آخر تسجيل دخول', el('span', { class: 'num' }, p.last_login_at ? dateTimeFull(p.last_login_at) : '—')),
      kv('عدد مرات الدخول', el('span', { class: 'num' }, nf.format(p.login_count))),
      kv('الفرع والقسم', [p.branch, p.department].filter(Boolean).join(' · ') || '—'))));

  // ─── تغيير كلمة المرور ───
  const c0 = pwInput(); const n1 = pwInput(); const n2 = pwInput();
  const pwBtn = el('button', { class: 'btn btn-primary' }, 'تغيير كلمة المرور') as HTMLButtonElement;
  main.append(el('section', { class: 'card rise-3', style: 'margin-top:18px' },
    el('div', { class: 'card-title' }, el('h3', {}, '🔐 تغيير كلمة المرور'),
      el('span', { class: 'chip' }, 'تُنهي كل الجلسات المفتوحة')),
    el('div', { class: 'grid', style: 'max-width:420px' },
      el('div', { class: 'field' }, el('label', {}, 'كلمة المرور الحالية'), c0),
      el('div', { class: 'field' }, el('label', {}, 'كلمة المرور الجديدة'), n1,
        el('span', { class: 'helper-text' }, '٨ أحرف على الأقل')),
      el('div', { class: 'field' }, el('label', {}, 'تأكيد كلمة المرور الجديدة'), n2),
      pwBtn)));
  pwBtn.onclick = async () => {
    if (n1.value.length < 8) { toast('كلمة المرور الجديدة: ٨ أحرف على الأقل', 'err'); return; }
    if (n1.value !== n2.value) { toast('تأكيد كلمة المرور غير مطابق', 'err'); return; }
    pwBtn.classList.add('loading');
    try {
      await post('/api/profile/password', { current: c0.value, password: n1.value, confirm: n2.value });
      toast('تم تغيير كلمة المرور — أُنهيت كل الجلسات، سجّل الدخول من جديد', 'ok', 4500);
      setTimeout(() => { location.href = '/login.html'; }, 1600);
    } catch { pwBtn.classList.remove('loading'); }
  };

  // ─── تغيير رقم الهاتف ───
  const cp = pwInput();
  const ph = el('input', { class: 'input', placeholder: '07XXXXXXXXX', inputmode: 'tel', dir: 'ltr', value: p.phone || '' }) as HTMLInputElement;
  const phBtn = el('button', { class: 'btn btn-ghost' }, 'حفظ رقم الهاتف') as HTMLButtonElement;
  main.append(el('section', { class: 'card rise-4', style: 'margin-top:18px' },
    el('div', { class: 'card-title' }, el('h3', {}, '📱 تغيير رقم الهاتف')),
    el('div', { class: 'grid', style: 'max-width:420px' },
      el('div', { class: 'field' }, el('label', {}, 'كلمة المرور الحالية'), cp,
        el('span', { class: 'helper-text' }, 'مطلوبة لأي تغيير حساس')),
      el('div', { class: 'field' }, el('label', {}, 'الرقم الجديد'), ph,
        el('span', { class: 'helper-text' }, 'فريد لكل موظف — الصيغة: 07XXXXXXXXX')),
      phBtn)));
  phBtn.onclick = async () => {
    phBtn.classList.add('loading');
    try {
      const r = await post<{ phone: string }>('/api/profile/phone', { current: cp.value, phone: ph.value });
      toast(`تم تحديث رقم الهاتف إلى ${r.phone} ✓`, 'ok');
      load();
    } catch { phBtn.classList.remove('loading'); }
  };
}

function pwInput(): HTMLInputElement {
  return el('input', { class: 'input', type: 'password', autocomplete: 'new-password' }) as HTMLInputElement;
}

initNav().then(() => load());
