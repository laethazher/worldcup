import { Router } from 'express';
import { db } from '../db.js';
import { verifyPassword, signToken, authRequired } from '../auth.js';
import { audit, rateLimit } from '../audit.js';
import { config } from '../config.js';

const r = Router();

r.post('/login', rateLimit({ windowMs: 60_000, max: 6 }), (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'أدخل اسم المستخدم وكلمة المرور' });

  const user = db.prepare('SELECT * FROM employees WHERE username = ? AND active = 1').get(String(username).trim());
  if (!user || !verifyPassword(String(password), user.password_hash)) {
    audit(req, 'LOGIN_FAILED', 'employee', '', username, 'failure');
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }

  const token = signToken(user);
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: 30 * 24 * 3600 * 1000 });
  req.user = { id: user.id, name: user.name, username: user.username, role: user.role, branch_id: user.branch_id };

  const firstLogin = !user.last_login_at;
  db.prepare(`UPDATE employees SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), login_count = login_count + 1 WHERE id = ?`).run(user.id);
  audit(req, firstLogin ? 'FIRST_LOGIN' : 'LOGIN', 'employee', user.id);

  const branch = user.branch_id ? db.prepare('SELECT name FROM branches WHERE id=?').get(user.branch_id)?.name : '';
  res.json({ ok: true, first_login: firstLogin, user: { id: user.id, name: user.name, username: user.username, role: user.role, department: user.department, branch, photo_url: user.photo_url } });
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
