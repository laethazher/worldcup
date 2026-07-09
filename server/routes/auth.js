import { Router } from 'express';
import { db, getSetting, NAME_NORM } from '../db.js';
import { verifyPassword, hashPassword, signToken, authRequired } from '../auth.js';
import { audit, rateLimit } from '../audit.js';
import { config } from '../config.js';
import { createNotification } from '../notify.js';
import {
  cleanName, nameTakenBy, phoneTakenBy, normalizePhone, validPhone, normalizeDigits,
  passwordProblem, findOrCreateBranch, resolveDepartment, CENTRAL_BRANCH, JOB_TITLES,
  NAME_TAKEN, PHONE_TAKEN, PHONE_INVALID, constraintMessage,
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

/* ─── الدخول: يقبل الاسم الثلاثي أو رقم الهاتف (أو اسم مستخدم قديم) ─── */
r.post('/login', rateLimit({ windowMs: 60_000, max: 30 }), (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'أدخل اسمك الثلاثي أو رقم هاتفك مع كلمة المرور' });

  const ident = String(username).trim();
  let user = db.prepare('SELECT * FROM employees WHERE username = ? AND active = 1').get(ident);
  if (!user) {
    const phone = normalizePhone(ident);
    if (validPhone(phone)) user = db.prepare('SELECT * FROM employees WHERE phone = ? AND active = 1').get(phone);
  }
  if (!user) {
    // مطابقة الاسم الثلاثي مع تجاهل فروق المسافات
    user = db.prepare(`SELECT * FROM employees WHERE ${NAME_NORM('name')} = ${NAME_NORM('?')} COLLATE NOCASE AND active = 1`).get(ident);
  }
  const pw = String(password);
  const passOk = user && (verifyPassword(pw, user.password_hash) || verifyPassword(normalizeDigits(pw), user.password_hash));
  if (!user || !passOk) {
    audit(req, 'LOGIN_FAILED', 'employee', '', ident, 'failure');
    return res.status(401).json({ error: 'بيانات الدخول غير صحيحة — تأكد من الاسم/رقم الهاتف وكلمة المرور' });
  }

  const firstLogin = !user.last_login_at;
  const payload = openSession(req, res, user, firstLogin ? 'FIRST_LOGIN' : 'LOGIN');
  res.json({ ok: true, first_login: firstLogin, user: payload });
});

/* ─── خيارات نموذج التسجيل (عام): الفرع الثابت + العناوين الوظيفية ─── */
r.get('/register/options', (_req, res) => {
  const enabled = getSetting('self_signup', '1') !== '0';
  res.json({ enabled, branch: CENTRAL_BRANCH, titles: enabled ? JOB_TITLES : [] });
});

/* ─── التسجيل الذاتي للموظف ───
   الاسم الثلاثي (بالعربي) هو نفسه اسم الدخول، ورقم الهاتف إجباري وفريد.
   الفرع ثابت حالياً على «المخازن المركزية» (يغيّره المسؤول فقط)،
   والعنوان الوظيفي يُختار من قائمة محددة. الدور دائماً employee. */
r.post('/register', rateLimit({ windowMs: 60_000, max: 15 }), (req, res) => {
  if (getSetting('self_signup', '1') === '0') {
    return res.status(403).json({ error: 'التسجيل الذاتي متوقف حالياً — راجع الإدارة لإنشاء حسابك' });
  }

  const name = cleanName(req.body?.name);
  const phone = normalizePhone(req.body?.phone);
  const title = cleanName(req.body?.title);
  const password = String(req.body?.password ?? '');
  const confirm = String(req.body?.confirm ?? '');

  if (!name) return res.status(400).json({ error: 'الاسم الكامل مطلوب' });
  if (name.split(' ').length < 3) return res.status(400).json({ error: 'اكتب اسمك الثلاثي (الاسم واسم الأب واللقب)' });
  if (!phone) return res.status(400).json({ error: 'رقم الهاتف مطلوب' });
  if (!validPhone(phone)) return res.status(400).json({ error: PHONE_INVALID });
  if (!JOB_TITLES.includes(title)) return res.status(400).json({ error: 'اختر عنوانك الوظيفي من القائمة' });
  const pwErr = passwordProblem(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  if (password !== confirm) return res.status(400).json({ error: 'تأكيد كلمة المرور غير مطابق' });

  if (db.prepare('SELECT 1 FROM employees WHERE username = ?').get(name)) {
    return res.status(409).json({ error: NAME_TAKEN });
  }
  if (nameTakenBy(name)) return res.status(409).json({ error: NAME_TAKEN });
  if (phoneTakenBy(phone)) return res.status(409).json({ error: PHONE_TAKEN });

  try {
    const branchId = findOrCreateBranch(CENTRAL_BRANCH);
    const dep = resolveDepartment(branchId, title);
    const info = db.prepare(`INSERT INTO employees(username, password_hash, name, phone, department, department_id, branch_id, role)
                             VALUES(?,?,?,?,?,?,?, 'employee')`)
      .run(name, hashPassword(normalizeDigits(password)), name, phone, dep.name, dep.id, branchId);

    const user = db.prepare('SELECT * FROM employees WHERE id = ?').get(info.lastInsertRowid);
    const payload = openSession(req, res, user, 'EMPLOYEE_SELF_REGISTERED');

    try {
      createNotification({
        type: 'system', priority: 'normal', target_type: 'role', target_id: 'admin',
        title: 'موظف جديد سجّل في المنصة',
        body: `${name} — ${title} · ${phone}`,
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