import { get, post } from '../api.js';

interface Options { enabled: boolean; branch: string; titles: string[] }

const form = document.getElementById('reg-form') as HTMLFormElement;
const nameIn = document.getElementById('name') as HTMLInputElement;
const phoneIn = document.getElementById('phone') as HTMLInputElement;
const titleSel = document.getElementById('title') as HTMLSelectElement;
const passIn = document.getElementById('pass') as HTMLInputElement;
const confirmIn = document.getElementById('confirm') as HTMLInputElement;
const btn = document.getElementById('go') as HTMLButtonElement;

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
  else if (/^7\d{9}$/.test(p)) p = '0' + p;
  return p;
}

/* ─── تحميل العناوين الوظيفية ─── */
async function loadOptions(): Promise<void> {
  try {
    const o = await get<Options>('/api/register/options');
    if (!o.enabled) {
      form.innerHTML = '<p class="login-sub" style="margin:0">التسجيل الذاتي متوقف حالياً — راجع الإدارة لإنشاء حسابك.</p>';
      return;
    }
    titleSel.innerHTML = '<option value="">— اختر عنوانك الوظيفي —</option>' +
      o.titles.map((t) => `<option value="${t}">${t}</option>`).join('');
  } catch {
    titleSel.innerHTML = '<option value="">تعذّر التحميل — حدّث الصفحة</option>';
  }
}

/* ─── تحقق فوري لكل حقل ─── */
function validate(): boolean {
  let ok = true;
  const name = nameIn.value.replace(/\s+/g, ' ').trim();
  if (!name) { setErr(nameIn, 'الاسم الكامل مطلوب'); ok = false; }
  else if (name.split(' ').length < 3) { setErr(nameIn, 'اكتب اسمك الثلاثي (الاسم واسم الأب واللقب)'); ok = false; }
  else setErr(nameIn, null);

  const phone = normalizePhone(phoneIn.value);
  if (!phone) { setErr(phoneIn, 'رقم الهاتف مطلوب'); ok = false; }
  else if (!/^07\d{9}$/.test(phone)) { setErr(phoneIn, 'الصيغة المطلوبة: 07XXXXXXXXX (١١ رقماً)'); ok = false; }
  else setErr(phoneIn, null);

  if (!titleSel.value) { setErr(titleSel, 'اختر عنوانك الوظيفي'); ok = false; }
  else setErr(titleSel, null);

  if (!passIn.value) { setErr(passIn, 'كلمة المرور مطلوبة'); ok = false; }
  else if (passIn.value.length < 8 || !/[A-Za-z\u0621-\u064A]/.test(passIn.value)) {
    setErr(passIn, '٨ خانات على الأقل وبينها حرف واحد (عربي أو إنكليزي) — مثال: 1234567م'); ok = false;
  }
  else setErr(passIn, null);

  if (confirmIn.value !== passIn.value) { setErr(confirmIn, 'غير مطابقة لكلمة المرور'); ok = false; }
  else setErr(confirmIn, null);

  return ok;
}

/* توجيه رسالة السيرفر إلى حقلها لتجربة أوضح */
function routeServerError(msg: string): void {
  if (/عنوان/.test(msg)) { setErr(titleSel, msg); }
  else if (/الهاتف/.test(msg)) { setErr(phoneIn, msg); phoneIn.focus(); }
  else if (/كلمة المرور/.test(msg)) { setErr(passIn, msg); passIn.focus(); }
  else if (/الاسم|اسمك/.test(msg)) { setErr(nameIn, msg); nameIn.focus(); }
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
      title: titleSel.value,
      password: passIn.value,
      confirm: confirmIn.value,
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
for (const el of [nameIn, phoneIn, passIn, confirmIn]) {
  el.addEventListener('input', () => setErr(el, null));
}
titleSel.addEventListener('change', () => setErr(titleSel, null));
form.addEventListener('submit', submit);
void loadOptions();