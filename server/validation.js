import { db, NAME_NORM } from './db.js';

/* ─── تحقق مشترك بين مسارات الإدارة والملف الشخصي ─── */

export const NAME_TAKEN = 'هذا الاسم مستخدم لموظف آخر — أسماء الموظفين يجب أن تكون فريدة';
export const PHONE_TAKEN = 'رقم الهاتف مستخدم لموظف آخر — الأرقام يجب أن تكون فريدة';
export const PHONE_INVALID = 'رقم الهاتف غير صحيح — الصيغة المطلوبة: 07XXXXXXXXX';
export const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

export const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim();

export function nameTakenBy(name, excludeId = 0) {
  return db.prepare(
    `SELECT id, username FROM employees
     WHERE ${NAME_NORM('name')} = ${NAME_NORM('?')} COLLATE NOCASE AND id != ?`)
    .get(name, excludeId);
}

/** يطبّع الرقم: أرقام عربية → لاتينية، إزالة الفواصل، +964/00964 → 0 */
export function normalizePhone(raw) {
  let p = String(raw ?? '').trim();
  p = p.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  p = p.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
  p = p.replace(/[\s\-().]/g, '');
  if (p.startsWith('+964')) p = '0' + p.slice(4);
  else if (p.startsWith('00964')) p = '0' + p.slice(5);
  else if (p.startsWith('964') && p.length === 13) p = '0' + p.slice(3);
  return p;
}
export const validPhone = (p) => /^07\d{9}$/.test(p);
export const phoneTakenBy = (phone, excludeId = 0) =>
  db.prepare('SELECT id FROM employees WHERE phone = ? AND id != ?').get(phone, excludeId);

export const BRANCH_TAKEN = 'اسم الفرع مستخدم مسبقاً — أسماء الفروع يجب أن تكون فريدة';
export const DEPT_TAKEN = 'اسم القسم مستخدم داخل هذا الفرع — الأقسام فريدة ضمن فرعها';

export const branchNameTakenBy = (name, excludeId = 0) =>
  db.prepare(`SELECT id FROM branches WHERE ${NAME_NORM('name')} = ${NAME_NORM('?')} COLLATE NOCASE AND id != ?`)
    .get(name, excludeId);

export const deptNameTakenBy = (branchId, name, excludeId = 0) =>
  db.prepare(`SELECT id FROM departments
    WHERE branch_id = ? AND ${NAME_NORM('name')} = ${NAME_NORM('?')} COLLATE NOCASE AND id != ?`)
    .get(branchId, name, excludeId);

/** إيجاد فرع بالتطبيع أو إنشاؤه (يوحّد كل مسارات الكتابة). */
export function findOrCreateBranch(rawName) {
  const name = cleanName(rawName);
  if (!name) return null;
  const row = db.prepare(`SELECT id FROM branches WHERE ${NAME_NORM('name')} = ${NAME_NORM('?')} COLLATE NOCASE`).get(name);
  if (row) return row.id;
  return db.prepare('INSERT INTO branches(name) VALUES(?)').run(name).lastInsertRowid;
}

/** إيجاد قسم داخل فرع بالتطبيع أو إنشاؤه — يعيد {id, name} أو null. */
export function resolveDepartment(branchId, rawText) {
  if (!branchId) return null;
  const name = cleanName(rawText);
  if (!name) return null;
  const row = db.prepare(`SELECT id, name FROM departments
    WHERE branch_id = ? AND ${NAME_NORM('name')} = ${NAME_NORM('?')} COLLATE NOCASE`).get(branchId, name);
  if (row) return row;
  return { id: db.prepare('INSERT INTO departments(branch_id, name) VALUES(?, ?)').run(branchId, name).lastInsertRowid, name };
}

/** يحوّل أخطاء قيود القاعدة إلى رسالة عربية (شبكة أمان تحت التحقق). */
export function constraintMessage(err) {
  const m = String(err?.message || '');
  if (m.includes('idx_emp_name_unique')) return NAME_TAKEN;
  if (m.includes('idx_emp_phone_unique') || m.includes('employees.phone')) return PHONE_TAKEN;
  if (m.includes('employees.username')) return 'اسم المستخدم موجود مسبقاً';
  if (m.includes('idx_branch_name_unique') || m.includes('branches.name')) return BRANCH_TAKEN;
  if (m.includes('idx_dept_unique')) return DEPT_TAKEN;
  return null;
}
