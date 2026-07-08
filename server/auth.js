import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { db, getSetting, setSetting } from './db.js';
import { config } from './config.js';

// JWT secret: environment override first (rotation / multi-instance),
// otherwise generated once and persisted in DB settings.
let SECRET = config.jwtSecret || getSetting('jwt_secret');
if (!SECRET) {
  SECRET = crypto.randomBytes(48).toString('hex');
  setSetting('jwt_secret', SECRET);
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

export function signToken(employee) {
  return jwt.sign({ id: employee.id, role: employee.role, v: employee.token_version ?? 0 }, SECRET, { expiresIn: '30d' });
}

export function authRequired(req, res, next) {
  const token = req.cookies?.token || (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'يجب تسجيل الدخول' });
  try {
    const payload = jwt.verify(token, SECRET);
    const user = db.prepare('SELECT id, username, name, department, department_id, branch_id, role, photo_url, champion_team, champion_at, active, token_version FROM employees WHERE id = ?').get(payload.id);
    if (!user || !user.active) return res.status(401).json({ error: 'الحساب غير فعّال' });
    if ((payload.v ?? 0) !== (user.token_version ?? 0)) {
      return res.status(401).json({ error: 'انتهت الجلسة، سجّل الدخول من جديد' });
    }
    delete user.token_version;
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'انتهت الجلسة، سجّل الدخول من جديد' });
  }
}

export function adminRequired(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'هذه الصفحة مخصصة للإدارة فقط' });
  next();
}
