import { get, post } from '../api.js';

interface Dept { id: number; name: string }
interface Branch { id: number; name: string; departments: Dept[] }
interface Options { enabled: boolean; branches: Branch[] }

const form = document.getElementById('reg-form') as HTMLFormElement;
const nameIn = document.getElementById('name') as HTMLInputElement;
const phoneIn = document.getElementById('phone') as HTMLInputElement;
const branchSel = document.getElementById('branch') as HTMLSelectElement;
const deptSel = document.getElementById('dept') as HTMLSelectElement;
const userIn = document.getElementById('username') as HTMLInputElement;
const passIn = document.getElementById('pass') as HTMLInputElement;
const confirmIn = document.getElementById('confirm') as HTMLInputElement;
const btn = document.getElementById('go') as HTMLButtonElement;

let branches: Branch[] = [];

/* ─── أدوات ─── */
const fieldOf = (el: HTMLElement): HTMLElement => el.closest('.field') as HTMLElement;

function setErr(input: HTMLElement, msg: string | null): void {
  const f = fieldOf(input);
  const help = f.querySelector('.helper-text') as HTMLParagraphElement;
  if (msg) { f.classList.add('error'); help.textContent = msg; help.hidden = false; }
  else { f.classList.remove('error'); help.hidden = true; }
}

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩', FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
function normalizePhone(raw: string): string {
  let p = raw.trim()
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)))
    .replace(/[\s\-().]/g, '');
  if (p.startsWith('+964')) p = '0' + p.slice(4);
  else if (p.startsWith('00964')) p = '0' + p.slice(5);
  else if (p.startsWith('964') && p.length === 13) p = '0' + p.slice(3);
  return p;
}
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

/* ─── تحميل الفروع/الأقسام ─── */
async function loadOptions(): Promise<void> {
  try {
    const o = await get<Options>('/api/register/options');
    if (!o.enabled) {
      form.innerHTML = '<p class="login-sub" style="margin:0">التسجيل الذاتي متوقف حالياً — راجع الإدارة لإنشاء حسابك.</p>';
      return;
    }
    branches = o.branches;
    branchSel.innerHTML = '<option value="">— اختر فرعك —</option>' +
      branches.map((b) => `<option value="${b.id}">${b.name}</option>`).join('');
  } catch {
    branchSel.innerHTML = '<option value="">تعذّر التحميل — حدّث الصفحة</option>';
  }
}

function onBranchChange(): void {
  setErr(branchSel, null);
  const b = branches.find((x) => String(x.id) === branchSel.value);
  if (!b) { deptSel.disabled = true; deptSel.innerHTML = '<option value="">اختر الفرع أولاً</option>'; return; }
  if (!b.departments.length) {
    deptSel.disabled = true;
    deptSel.innerHTML = '<option value="">لا توجد أقسام لهذا الفرع</option>';
  } else {
    deptSel.disabled = false;
    deptSel.innerHTML = '<option value="">بدون قسم</option>' +
      b.departments.map((d) => `<option value="${d.id}">${d.name}</option>`).join('');
  }
}

/* ─── تحقق فوري لكل حقل ─── */
function validate(): boolean {
  let ok = true;
  const name = nameIn.value.replace(/\s+/g, ' ').trim();
  if (!name) { setErr(nameIn, 'الاسم الكامل مطلوب'); ok = false; }
  else if (name.length < 5 || !name.includes(' ')) { setErr(nameIn, 'اكتب اسمك الثنائي على الأقل (الاسم واللقب)'); ok = false; }
  else setErr(nameIn, null);

  const phone = normalizePhone(phoneIn.value);
  if (!phone) { setErr(phoneIn, 'رقم الهاتف مطلوب'); ok = false; }
  else if (!/^07\d{9}$/.test(phone)) { setErr(phoneIn, 'الصيغة المطلوبة: 07XXXXXXXXX (١١ رقماً)'); ok = false; }
  else setErr(phoneIn, null);

  if (!branchSel.value) { setErr(branchSel, 'اختر فرعك من القائمة'); ok = false; }
  else setErr(branchSel, null);

  const u = userIn.value.trim();
  if (!u) { setErr(userIn, 'اسم المستخدم مطلوب'); ok = false; }
  else if (!USERNAME_RE.test(u)) { setErr(userIn, '3–32 حرفاً إنكليزياً أو أرقاماً أو . _ -'); ok = false; }
  else setErr(userIn, null);

  if (!passIn.value) { setErr(passIn, 'كلمة المرور مطلوبة'); ok = false; }
  else if (passIn.value.length < 8) { setErr(passIn, '٨ أحرف على الأقل'); ok = false; }
  else setErr(passIn, null);

  if (confirmIn.value !== passIn.value) { setErr(confirmIn, 'غير مطابقة لكلمة المرور'); ok = false; }
  else setErr(confirmIn, null);

  return ok;
}

/* توجيه رسالة السيرفر إلى حقلها (اليوزر/الهاتف/الاسم) لتجربة أوضح */
function routeServerError(msg: string): void {
  if (/اسم المستخدم/.test(msg)) { setErr(userIn, msg); userIn.focus(); }
  else if (/الهاتف/.test(msg)) { setErr(phoneIn, msg); phoneIn.focus(); }
  else if (/الاسم/.test(msg)) { setErr(nameIn, msg); nameIn.focus(); }
  else if (/كلمة المرور/.test(msg)) { setErr(passIn, msg); passIn.focus(); }
  else if (/فرع/.test(msg)) setErr(branchSel, msg);
  else if (/قسم/.test(msg)) setErr(deptSel, msg);
}

async function submit(e: Event): Promise<void> {
  e.preventDefault();
  if (!validate()) return;
  btn.disabled = true;
  btn.textContent = 'جارٍ إنشاء الحساب…';
  try {
    const r = await post<{ ok: boolean; user: { name: string } }>('/api/register', {
      name: nameIn.value.replace(/\s+/g, ' ').trim(),
      phone: normalizePhone(phoneIn.value),
      username: userIn.value.trim(),
      password: passIn.value,
      confirm: confirmIn.value,
      branch_id: Number(branchSel.value),
      department_id: deptSel.value ? Number(deptSel.value) : null,
    });
    try { sessionStorage.setItem('ahc-welcome', r.user.name); } catch { /* noop */ }
    location.href = '/index.html';
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'إنشاء الحساب';
    routeServerError(err instanceof Error ? err.message : '');
  }
}

/* مسح خطأ الحقل عند التعديل */
for (const el of [nameIn, phoneIn, userIn, passIn, confirmIn]) {
  el.addEventListener('input', () => setErr(el, null));
}
branchSel.addEventListener('change', onBranchChange);
form.addEventListener('submit', submit);
void loadOptions();