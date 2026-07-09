import { Router } from 'express';
import { db } from '../db.js';
import { authRequired, verifyPassword, hashPassword } from '../auth.js';
import { audit } from '../audit.js';
import { normalizePhone, validPhone, phoneTakenBy, normalizeDigits, passwordProblem, PHONE_TAKEN, PHONE_INVALID, constraintMessage } from '../validation.js';

const r = Router();
r.use(authRequired);

const WRONG_CURRENT = 'كلمة المرور الحالية غير صحيحة';
const currentOk = (pw, hash) => verifyPassword(pw, hash) || verifyPassword(normalizeDigits(pw), hash);
const self = (id) => db.prepare(`
  SELECT e.id, e.username, e.name, e.phone, e.department, e.role, e.active,
         e.created_at, e.last_login_at, e.login_count, e.photo_url,
         e.password_hash, e.token_version, b.name AS branch
  FROM employees e LEFT JOIN branches b ON b.id = e.branch_id
  WHERE e.id = ?`).get(id);

r.get('/profile', (req, res) => {
  const me = self(req.user.id);
  const { password_hash, token_version, ...safe } = me;
  res.json(safe);
});

/** تغيير كلمة المرور: يتطلب الحالية · ≥٨ · مطابقة التأكيد → إبطال كل الجلسات وإعادة المصادقة */
r.post('/profile/password', (req, res) => {
  const me = self(req.user.id);
  const current = String(req.body?.current ?? '');
  const password = String(req.body?.password ?? '');
  const confirm = String(req.body?.confirm ?? '');

  if (!currentOk(current, me.password_hash)) {
    audit(req, 'PASSWORD_CHANGE_DENIED', 'employee', me.id, 'كلمة المرور الحالية خاطئة', 'failure');
    return res.status(400).json({ error: WRONG_CURRENT });
  }
  const pwErr = passwordProblem(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  if (password !== confirm) return res.status(400).json({ error: 'تأكيد كلمة المرور غير مطابق' });

  db.prepare('UPDATE employees SET password_hash = ?, token_version = token_version + 1 WHERE id = ?')
    .run(hashPassword(normalizeDigits(password)), me.id);
  audit(req, 'PASSWORD_CHANGED', 'employee', me.id);
  res.clearCookie('token');
  res.json({ ok: true, reauth: true });
});

/** تغيير رقم الهاتف: يتطلب كلمة المرور الحالية · تطبيع + صيغة + فرادة */
r.post('/profile/phone', (req, res) => {
  const me = self(req.user.id);
  const current = String(req.body?.current ?? '');
  if (!currentOk(current, me.password_hash)) {
    audit(req, 'PHONE_CHANGE_DENIED', 'employee', me.id, 'كلمة المرور الحالية خاطئة', 'failure');
    return res.status(400).json({ error: WRONG_CURRENT });
  }
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ error: 'رقم الهاتف مطلوب' });
  if (!validPhone(phone)) return res.status(400).json({ error: PHONE_INVALID });
  if (phoneTakenBy(phone, me.id)) return res.status(409).json({ error: PHONE_TAKEN });

  try {
    db.prepare('UPDATE employees SET phone = ? WHERE id = ?').run(phone, me.id);
  } catch (e) {
    const msg = constraintMessage(e);
    if (msg) return res.status(409).json({ error: msg });
    throw e;
  }
  audit(req, 'PHONE_CHANGED', 'employee', me.id, `${me.phone || '—'} ← ${phone}`);
  res.json({ ok: true, phone });
});

export default r;