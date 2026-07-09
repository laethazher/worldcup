import { db } from './db.js';

const branchName = db.prepare('SELECT name FROM branches WHERE id = ?');

/* ─── تعقيم تلقائي: لا سرّ يدخل سجل التدقيق مهما كان مصدر الاستدعاء ─── */
const SENSITIVE_KEY = /pass|pwd|token|secret|jwt|cookie|hash|auth|otp|pin|credential/i;

function maskDeep(v) {
  if (Array.isArray(v)) return v.map(maskDeep);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = SENSITIVE_KEY.test(k) ? '•••' : maskDeep(val);
    return out;
  }
  return v;
}

function scrubString(str) {
  return String(str)
    .replace(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, '•••jwt•••')            // JWT
    .replace(/Bearer\s+[\w.~+/-]+/gi, 'Bearer •••')
    .replace(/\b[0-9a-fA-F]{32,}\b/g, '•••')                                      // هاشات/مفاتيح hex طويلة
    .replace(/((?:password|pass|pwd|token|secret|otp|pin)\s*[:=]\s*)\S+/gi, '$1•••');
}

/** تُطبَّق على كل details قبل الكتابة — كائنات تُقنَّع بالمفاتيح، ونصوص تُكشط بالأنماط. */
export function sanitizeDetails(details) {
  if (details == null) return '';
  if (typeof details === 'object') return JSON.stringify(maskDeep(details));
  return scrubString(details);
}

/**
 * يسجّل الحركة بلقطة كاملة لهوية الفاعل وقت التنفيذ (الاسم/المستخدم/الدور/الفرع)
 * مع IP وUser-Agent والنتيجة ('success' افتراضاً، 'failure' للمحاولات المرفوضة).
 */
export function audit(req, action, entity = '', entityId = '', details = '', result = 'success') {
  const u = req.user;
  db.prepare(`INSERT INTO audit_logs
      (actor_id, actor_name, actor_username, actor_role, actor_branch,
       action, entity, entity_id, details, ip, user_agent, result)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      u?.id ?? null,
      u?.name ?? 'غير مسجّل',
      u?.username ?? null,
      u?.role ?? null,
      u?.branch_id ? (branchName.get(u.branch_id)?.name ?? null) : null,
      action, entity, String(entityId ?? ''),
      sanitizeDetails(details),
      req.ip || req.socket?.remoteAddress || '',
      String(req.headers?.['user-agent'] || '').slice(0, 255) || null,
      result === 'failure' ? 'failure' : 'success');
}

// ---- rate limiter (per key, sliding window) ----
// كل مُقيِّد له سلّته الخاصة: عدّاد الدخول لا يختلط بعدّاد التسجيل أو غيره.
export function rateLimit({ windowMs = 60_000, max = 5, keyFn = (req) => req.ip } = {}) {
  const buckets = new Map();
  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    const arr = (buckets.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) {
      return res.status(429).json({ error: 'محاولات كثيرة، انتظر دقيقة ثم حاول من جديد' });
    }
    arr.push(now);
    buckets.set(key, arr);
    next();
  };
}