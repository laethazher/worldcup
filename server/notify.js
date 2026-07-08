import { db } from './db.js';
import { broadcast, sendToSet } from './sse.js';

export const PRIORITIES = ['low', 'normal', 'high', 'critical'];
export const TARGET_TYPES = ['all', 'employee', 'branch', 'department', 'role'];

/** شرط الرؤية الموحّد — يُستخدم بالقائمة والعدّاد والتعليم والإخفاء. */
export const VIS_SQL = `(
  n.target_type = 'all'
  OR (n.target_type = 'employee'   AND n.target_id = @eid)
  OR (n.target_type = 'branch'     AND n.target_id = @bid)
  OR (n.target_type = 'department' AND n.target_id = @did)
  OR (n.target_type = 'role'       AND n.target_id = @role)
)`;
export const visParams = (u) => ({
  eid: String(u.id),
  bid: u.branch_id != null ? String(u.branch_id) : '∅',
  did: u.department_id != null ? String(u.department_id) : '∅',
  role: u.role,
});

/** يتحقق من الهدف ويعيد { error } أو { target_id, label } (الاسم للعرض والتدقيق). */
export function validateTarget(target_type, raw) {
  if (!TARGET_TYPES.includes(target_type)) return { error: 'نوع الاستهداف غير معروف' };
  if (target_type === 'all') return { target_id: null, label: 'كل الموظفين' };
  const tid = String(raw ?? '').trim();
  if (!tid) return { error: 'حدد هدف الإرسال' };
  if (target_type === 'employee') {
    const e = db.prepare('SELECT id, name FROM employees WHERE id=?').get(Number(tid));
    return e ? { target_id: String(e.id), label: `الموظف: ${e.name}` } : { error: 'الموظف غير موجود' };
  }
  if (target_type === 'branch') {
    const b = db.prepare('SELECT id, name FROM branches WHERE id=?').get(Number(tid));
    return b ? { target_id: String(b.id), label: `فرع: ${b.name}` } : { error: 'الفرع غير موجود' };
  }
  if (target_type === 'department') {
    const d = db.prepare('SELECT d.id, d.name, b.name AS branch FROM departments d JOIN branches b ON b.id=d.branch_id WHERE d.id=?').get(Number(tid));
    return d ? { target_id: String(d.id), label: `قسم: ${d.name} @ ${d.branch}` } : { error: 'القسم غير موجود' };
  }
  if (tid !== 'admin' && tid !== 'employee') return { error: 'الدور غير صحيح' };
  return { target_id: tid, label: tid === 'admin' ? 'دور: الإدارة' : 'دور: الموظفون' };
}

/** معرّفات المستلمين النشطين حالياً (للبث الحي وعدّاد «المستلمون»). */
export function recipientIds(target_type, target_id) {
  if (target_type === 'all') return db.prepare('SELECT id FROM employees WHERE active=1').all().map(r => r.id);
  const q = {
    employee: 'SELECT id FROM employees WHERE active=1 AND id=?',
    branch: 'SELECT id FROM employees WHERE active=1 AND branch_id=?',
    department: 'SELECT id FROM employees WHERE active=1 AND department_id=?',
    role: 'SELECT id FROM employees WHERE active=1 AND role=?',
  }[target_type];
  const param = target_type === 'role' ? target_id : Number(target_id);
  return db.prepare(q).all(param).map(r => r.id);
}

/**
 * ينشئ الإشعار (صف واحد — لا تكرار) ويبثه حياً للمستهدفين المتصلين فقط.
 * type: 'system' | 'admin'.
 */
export function createNotification({ type = 'admin', title, body = '', priority = 'normal',
  target_type = 'all', target_id = null, sender = null }) {
  const info = db.prepare(`INSERT INTO notifications
      (title, body, type, priority, sender_id, sender_name, target_type, target_id)
      VALUES(?,?,?,?,?,?,?,?)`)
    .run(String(title).trim(), String(body ?? '').trim(), type,
      PRIORITIES.includes(priority) ? priority : 'normal',
      sender?.id ?? null, sender?.name ?? (type === 'system' ? 'النظام' : null),
      target_type, target_id);
  const row = db.prepare('SELECT id, title, body, type, priority, sender_name, created_at FROM notifications WHERE id=?')
    .get(info.lastInsertRowid);
  if (target_type === 'all') broadcast('notification', row);
  else sendToSet('notification', row, new Set(recipientIds(target_type, target_id)));
  return row;
}
