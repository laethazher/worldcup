import { Router } from 'express';
import { db, getSetting } from '../db.js';
import { verifyPassword, hashPassword, signToken, authRequired } from '../auth.js';
import { audit, rateLimit } from '../audit.js';
import { config } from '../config.js';
import { createNotification } from '../notify.js';
import {
  cleanName, nameTakenBy, phoneTakenBy, normalizePhone, validPhone,
  USERNAME_RE, NAME_TAKEN, PHONE_TAKEN, PHONE_INVALID, constraintMessage,
} from '../validation.js';

const r = Router();

/* ─── جلسة موحّدة: كوكي + تحديث إحصاءات الدخول (يستخدمها الدخول والتسجيل) ─── */
function openSession(req, res, user, auditAction) {
  const token = signToken(user);
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: 30 * 24 * 3600 * 1000 });
  req.user = { id: user.id, name: user.name, username: user.username, role: user.role, branch_id: user.branch_id };
  db.prepare(`UPDATE employees SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), login_count = login_count + 1 WHERE id = ?`).run(user.id);
  audit(req, auditAction, 'employee', user.id);
  const branch = user.branch_id ? db.prepare('SELECT name FROM branches WHERE id=?').get(user.branch_id)?.name : '';
  return { id: user.id, name: user.name, username: user.username, role: user.role, department: user.department, branch, photo_url: user.photo_url };
}

/* ─── الدخول: يقبل اسم المستخدم أو رقم الهاتف ─── */
r.post('/login', rateLimit({ windowMs: 60_000, max: 6 }), (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'أدخل اسم المستخدم أو رقم الهاتف مع كلمة المرور' });

  const ident = String(username).trim();
  let user = db.prepare('SELECT * FROM employees WHERE username = ? AND active = 1').get(ident);
  if (!user) {
    const phone = normalizePhone(ident);
    if (validPhone(phone)) user = db.prepare('SELECT * FROM employees WHERE phone = ? AND active = 1').get(phone);
  }
  if (!user || !verifyPassword(String(password), user.password_hash)) {
    audit(req, 'LOGIN_FAILED', 'employee', '', ident, 'failure');
    return res.status(401).json({ error: 'بيانات الدخول غير صحيحة — تأكد من اسم المستخدم/رقم الهاتف وكلمة المرور' });
  }

  const firstLogin = !user.last_login_at;
  const payload = openSession(req, res, user, firstLogin ? 'FIRST_LOGIN' : 'LOGIN');
  res.json({ ok: true, first_login: firstLogin, user: payload });
});

/* ─── خيارات نموذج التسجيل الذاتي (عام): الفروع النشطة وأقسامها ─── */
r.get('/register/options', (_req, res) => {
  const enabled = getSetting('self_signup', '1') !== '0';
  if (!enabled) return res.json({ enabled: false, branches: [] });
  const branches = db.prepare('SELECT id, name FROM branches WHERE active = 1 ORDER BY name').all()
    .map(b => ({ ...b, departments: db.prepare('SELECT id, name FROM departments WHERE branch_id = ? AND active = 1 ORDER BY name').all(b.id) }));
  res.json({ enabled: true, branches });
});

/* ─── التسجيل الذاتي للموظف ───
   الاسم الكامل ورقم الهاتف إجباريان (فريدان)، الفرع إجباري من القائمة،
   القسم اختياري ويجب أن يتبع الفرع. الدور دائماً employee (لا يُقبل من الطلب).
   بعد النجاح: جلسة مفتوحة مباشرة + تدقيق + إشعار حي للإدارة. */
r.post('/register', rateLimit({ windowMs: 60_000, max: 5 }), (req, res) => {
  if (getSetting('self_signup', '1') === '0') {
    return res.status(403).json({ error: 'التسجيل الذاتي متوقف حالياً — راجع الإدارة لإنشاء حسابك' });
  }

  const name = cleanName(req.body?.name);
  const phone = normalizePhone(req.body?.phone);
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');
  const confirm = String(req.body?.confirm ?? '');
  const branchId = Number(req.body?.branch_id);
  const deptIdRaw = req.body?.department_id;

  if (!name) return res.status(400).json({ error: 'الاسم الكامل مطلوب' });
  if (name.length < 5 || !name.includes(' ')) return res.status(400).json({ error: 'اكتب اسمك الثنائي على الأقل (الاسم واللقب)' });
  if (!phone) return res.status(400).json({ error: 'رقم الهاتف مطلوب' });
  if (!validPhone(phone)) return res.status(400).json({ error: PHONE_INVALID });
  if (!username) return res.status(400).json({ error: 'اسم المستخدم مطلوب' });
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'اسم المستخدم: 3–32 حرفاً لاتينياً أو أرقاماً أو . _ -' });
  if (!password) return res.status(400).json({ error: 'كلمة المرور مطلوبة' });
  if (password.length < 8) return res.status(400).json({ error: 'كلمة المرور: ٨ أحرف على الأقل' });
  if (password !== confirm) return res.status(400).json({ error: 'تأكيد كلمة المرور غير مطابق' });

  const branch = Number.isInteger(branchId)
    ? db.prepare('SELECT id, name FROM branches WHERE id = ? AND active = 1').get(branchId) : null;
  if (!branch) return res.status(400).json({ error: 'اختر فرعك من القائمة' });

  let dep = null;
  if (deptIdRaw !== null && deptIdRaw !== undefined && String(deptIdRaw) !== '') {
    dep = db.prepare('SELECT id, name FROM departments WHERE id = ? AND branch_id = ? AND active = 1')
      .get(Number(deptIdRaw), branch.id);
    if (!dep) return res.status(400).json({ error: 'القسم المحدد غير موجود ضمن هذا الفرع' });
  }

  if (db.prepare('SELECT 1 FROM employees WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'اسم المستخدم موجود مسبقاً — اختر اسماً آخر' });
  }
  if (nameTakenBy(name)) return res.status(409).json({ error: NAME_TAKEN });
  if (phoneTakenBy(phone)) return res.status(409).json({ error: PHONE_TAKEN });

  try {
    const info = db.prepare(`INSERT INTO employees(username, password_hash, name, phone, department, department_id, branch_id, role)
                             VALUES(?,?,?,?,?,?,?, 'employee')`)
      .run(username, hashPassword(password), name, phone, dep ? dep.name : '', dep ? dep.id : null, branch.id);

    const user = db.prepare('SELECT * FROM employees WHERE id = ?').get(info.lastInsertRowid);
    const payload = openSession(req, res, user, 'EMPLOYEE_SELF_REGISTERED');

    try {
      createNotification({
        type: 'system', priority: 'normal', target_type: 'role', target_id: 'admin',
        title: 'موظف جديد سجّل في المنصة',
        body: `${name} — ${branch.name}${dep ? ' / ' + dep.name : ''} · ${username}`,
      });
    } catch (e) { console.error('تعذّر إشعار الإدارة بتسجيل جديد:', e.message); }

    res.json({ ok: true, first_login: false, user: payload });
  } catch (e) {
    const msg = constraintMessage(e);
    if (msg) return res.status(409).json({ error: msg });
    throw e;
  }
});

r.post('/logout', authRequired, (req, res) => {
  audit(req, 'LOGOUT', 'employee', req.user.id);
  res.clearCookie('token');
  res.json({ ok: true });
});

r.get('/me', authRequired, (req, res) => {
  const branch = req.user.branch_id ? db.prepare('SELECT name FROM branches WHERE id=?').get(req.user.branch_id)?.name : '';
  res.json({ ...req.user, branch });
});

export default r;