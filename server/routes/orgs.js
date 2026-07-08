import { Router } from 'express';
import { db, NAME_NORM } from '../db.js';
import { authRequired, adminRequired } from '../auth.js';
import { audit } from '../audit.js';
import { createNotification } from '../notify.js';
import {
  cleanName, branchNameTakenBy, deptNameTakenBy,
  BRANCH_TAKEN, DEPT_TAKEN, constraintMessage, resolveDepartment,
} from '../validation.js';

const r = Router();
r.use(authRequired, adminRequired);

const esc = (t) => '%' + String(t).replace(/[%_\\]/g, (m) => '\\' + m) + '%';
const pageParams = (q) => {
  const per = Math.min(Math.max(Number(q.per) || 10, 1), 100);
  return { per, page: Math.max(Number(q.page) || 1, 1) };
};

/* ═══════════════════════════ الفروع ═══════════════════════════ */
const B_SORTS = { name: 'b.name', employees: 'emp_count', departments: 'dept_count', status: 'b.active' };

r.get('/orgs/branches', (req, res) => {
  const where = [], args = [];
  const q = String(req.query.q || '').trim();
  if (q) { where.push("b.name LIKE ? ESCAPE '\\'"); args.push(esc(q)); }
  if (req.query.status === 'active') where.push('b.active = 1');
  if (req.query.status === 'disabled') where.push('b.active = 0');
  const wsql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const sort = B_SORTS[req.query.sort] || 'b.name';
  const dir = req.query.dir === 'desc' ? 'DESC' : 'ASC';

  const base = `FROM branches b ${wsql}`;
  const total = db.prepare(`SELECT COUNT(*) c ${base}`).get(...args).c;
  const { per } = pageParams(req.query);
  const pages = Math.max(Math.ceil(total / per), 1);
  const page = Math.min(pageParams(req.query).page, pages);
  const rows = db.prepare(`
    SELECT b.id, b.name, b.active,
           (SELECT COUNT(*) FROM employees e WHERE e.branch_id = b.id) AS emp_count,
           (SELECT COUNT(*) FROM departments d WHERE d.branch_id = b.id) AS dept_count
    ${base} ORDER BY ${sort} ${dir}, b.id ASC LIMIT ? OFFSET ?`)
    .all(...args, per, (page - 1) * per);
  res.json({ rows, total, page, per, pages });
});

r.post('/orgs/branches', (req, res) => {
  const name = cleanName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'أدخل اسم الفرع' });
  if (branchNameTakenBy(name)) return res.status(409).json({ error: BRANCH_TAKEN });
  try {
    const id = db.prepare('INSERT INTO branches(name) VALUES(?)').run(name).lastInsertRowid;
    audit(req, 'BRANCH_CREATED', 'branch', id, name);
    res.json({ ok: true, id });
  } catch (e) {
    const msg = constraintMessage(e);
    if (msg) return res.status(409).json({ error: msg });
    throw e;
  }
});

r.patch('/orgs/branches/:id', (req, res) => {
  const b = db.prepare('SELECT * FROM branches WHERE id=?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'الفرع غير موجود' });
  let name;
  if (req.body?.name !== undefined) {
    name = cleanName(req.body.name);
    if (!name) return res.status(400).json({ error: 'اسم الفرع لا يمكن أن يكون فارغاً' });
    if (branchNameTakenBy(name, b.id)) return res.status(409).json({ error: BRANCH_TAKEN });
  }
  const active = req.body?.active;
  try {
    db.prepare(`UPDATE branches SET
        name = COALESCE(?, name),
        active = COALESCE(?, active)
      WHERE id = ?`)
      .run(name ?? null, active === undefined ? null : (active ? 1 : 0), b.id);
  } catch (e) {
    const msg = constraintMessage(e);
    if (msg) return res.status(409).json({ error: msg });
    throw e;
  }
  const bch = [];
  if (name && name !== b.name) bch.push(`الاسم: «${b.name}» ← «${name}»`);
  if (active !== undefined && (active ? 1 : 0) !== b.active) {
    bch.push(`الحالة: «${b.active ? 'فعّال' : 'موقوف'}» ← «${active ? 'فعّال' : 'موقوف'}»`);
  }
  audit(req, 'BRANCH_UPDATED', 'branch', b.id, bch.length ? bch.join(' · ') : `${b.name} · بلا تغييرات`);
  res.json({ ok: true });
});

/** حذف فرع: محظور وهو مرجَع من موظفين إلا بنقل صريح — النقل يعيد ربط أقسامهم تحت الوجهة. */
r.delete('/orgs/branches/:id', (req, res) => {
  const b = db.prepare('SELECT * FROM branches WHERE id=?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'الفرع غير موجود' });
  const empCount = db.prepare('SELECT COUNT(*) c FROM employees WHERE branch_id=?').get(b.id).c;
  const reassign = req.body?.reassign_to ? Number(req.body.reassign_to) : null;

  if (empCount > 0 && !reassign) {
    return res.status(409).json({
      error: `لا يمكن حذف «${b.name}» — مرتبط بـ ${empCount} موظفاً. اختر فرعاً بديلاً لنقلهم إليه.`,
      employees: empCount, needs_reassign: true,
    });
  }
  let target = null;
  if (empCount > 0) {
    target = db.prepare('SELECT * FROM branches WHERE id=?').get(reassign);
    if (!target) return res.status(400).json({ error: 'فرع النقل غير موجود' });
    if (target.id === b.id) return res.status(400).json({ error: 'لا يمكن النقل إلى الفرع نفسه' });
    if (!target.active) return res.status(400).json({ error: 'لا يمكن النقل إلى فرع موقوف' });
  }

  const movedIds = target ? db.prepare('SELECT id FROM employees WHERE branch_id=?').all(b.id).map(x => x.id) : [];
  db.transaction(() => {
    if (target) {
      const emps = db.prepare('SELECT id, department FROM employees WHERE branch_id=?').all(b.id);
      const upd = db.prepare('UPDATE employees SET branch_id=?, department_id=?, department=? WHERE id=?');
      for (const e of emps) {
        const dep = resolveDepartment(target.id, e.department);
        upd.run(target.id, dep ? dep.id : null, dep ? dep.name : e.department, e.id);
      }
    }
    db.prepare('DELETE FROM branches WHERE id=?').run(b.id); // الأقسام تُحذف تتابعياً (CASCADE)
  })();
  for (const id of movedIds) {
    createNotification({ type: 'system', title: 'نقل فرع',
      body: `أُغلق فرع «${b.name}» ونُقلت إلى «${target.name}»`, target_type: 'employee', target_id: String(id) });
  }

  audit(req, 'BRANCH_DELETED', 'branch', b.id,
    `${b.name}${target ? ` · نُقل ${empCount} موظفاً إلى «${target.name}»` : ''}`);
  res.json({ ok: true, moved: empCount });
});

/* ═══════════════════════════ الأقسام ═══════════════════════════ */
const D_SORTS = { name: 'd.name', employees: 'emp_count', status: 'd.active', branch: 'b.name' };

r.get('/orgs/departments', (req, res) => {
  const where = [], args = [];
  if (req.query.branch) { where.push('d.branch_id = ?'); args.push(Number(req.query.branch)); }
  const q = String(req.query.q || '').trim();
  if (q) { where.push("d.name LIKE ? ESCAPE '\\'"); args.push(esc(q)); }
  if (req.query.status === 'active') where.push('d.active = 1');
  if (req.query.status === 'disabled') where.push('d.active = 0');
  const wsql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const sort = D_SORTS[req.query.sort] || 'd.name';
  const dir = req.query.dir === 'desc' ? 'DESC' : 'ASC';

  const base = `FROM departments d JOIN branches b ON b.id = d.branch_id ${wsql}`;
  const total = db.prepare(`SELECT COUNT(*) c ${base}`).get(...args).c;
  const { per } = pageParams(req.query);
  const pages = Math.max(Math.ceil(total / per), 1);
  const page = Math.min(pageParams(req.query).page, pages);
  const rows = db.prepare(`
    SELECT d.id, d.name, d.active, d.branch_id, b.name AS branch,
           (SELECT COUNT(*) FROM employees e WHERE e.department_id = d.id) AS emp_count
    ${base} ORDER BY ${sort} ${dir}, d.id ASC LIMIT ? OFFSET ?`)
    .all(...args, per, (page - 1) * per);
  res.json({ rows, total, page, per, pages });
});

r.post('/orgs/departments', (req, res) => {
  const branchId = Number(req.body?.branch_id);
  const name = cleanName(req.body?.name);
  const branch = db.prepare('SELECT * FROM branches WHERE id=?').get(branchId);
  if (!branch) return res.status(400).json({ error: 'اختر فرعاً صحيحاً' });
  if (!name) return res.status(400).json({ error: 'أدخل اسم القسم' });
  if (deptNameTakenBy(branchId, name)) return res.status(409).json({ error: DEPT_TAKEN });
  try {
    const id = db.prepare('INSERT INTO departments(branch_id, name) VALUES(?, ?)').run(branchId, name).lastInsertRowid;
    audit(req, 'DEPARTMENT_CREATED', 'department', id, `${name} @ ${branch.name}`);
    res.json({ ok: true, id });
  } catch (e) {
    const msg = constraintMessage(e);
    if (msg) return res.status(409).json({ error: msg });
    throw e;
  }
});

r.patch('/orgs/departments/:id', (req, res) => {
  const d = db.prepare('SELECT d.*, b.name AS branch FROM departments d JOIN branches b ON b.id=d.branch_id WHERE d.id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'القسم غير موجود' });
  let name;
  if (req.body?.name !== undefined) {
    name = cleanName(req.body.name);
    if (!name) return res.status(400).json({ error: 'اسم القسم لا يمكن أن يكون فارغاً' });
    if (deptNameTakenBy(d.branch_id, name, d.id)) return res.status(409).json({ error: DEPT_TAKEN });
  }
  const active = req.body?.active;
  try {
    db.transaction(() => {
      db.prepare('UPDATE departments SET name = COALESCE(?, name), active = COALESCE(?, active) WHERE id = ?')
        .run(name ?? null, active === undefined ? null : (active ? 1 : 0), d.id);
      if (name && name !== d.name) {
        db.prepare('UPDATE employees SET department = ? WHERE department_id = ?').run(name, d.id); // مزامنة المرآة النصية
      }
    })();
  } catch (e) {
    const msg = constraintMessage(e);
    if (msg) return res.status(409).json({ error: msg });
    throw e;
  }
  const dch = [];
  if (name && name !== d.name) dch.push(`الاسم: «${d.name}» ← «${name}»`);
  if (active !== undefined && (active ? 1 : 0) !== d.active) {
    dch.push(`الحالة: «${d.active ? 'فعّال' : 'موقوف'}» ← «${active ? 'فعّال' : 'موقوف'}»`);
  }
  audit(req, 'DEPARTMENT_UPDATED', 'department', d.id, `${dch.length ? dch.join(' · ') : 'بلا تغييرات'} @ ${d.branch}`);
  res.json({ ok: true });
});

/** حذف قسم: محظور وهو مرجَع إلا بنقل صريح لقسم آخر في الفرع نفسه. */
r.delete('/orgs/departments/:id', (req, res) => {
  const d = db.prepare('SELECT d.*, b.name AS branch FROM departments d JOIN branches b ON b.id=d.branch_id WHERE d.id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'القسم غير موجود' });
  const empCount = db.prepare('SELECT COUNT(*) c FROM employees WHERE department_id=?').get(d.id).c;
  const reassign = req.body?.reassign_to ? Number(req.body.reassign_to) : null;

  if (empCount > 0 && !reassign) {
    return res.status(409).json({
      error: `لا يمكن حذف «${d.name}» — مرتبط بـ ${empCount} موظفاً. اختر قسماً بديلاً في الفرع نفسه.`,
      employees: empCount, needs_reassign: true,
    });
  }
  let target = null;
  if (empCount > 0) {
    target = db.prepare('SELECT * FROM departments WHERE id=?').get(reassign);
    if (!target) return res.status(400).json({ error: 'قسم النقل غير موجود' });
    if (target.id === d.id) return res.status(400).json({ error: 'لا يمكن النقل إلى القسم نفسه' });
    if (target.branch_id !== d.branch_id) return res.status(400).json({ error: 'وجهة النقل يجب أن تكون قسماً في الفرع نفسه' });
    if (!target.active) return res.status(400).json({ error: 'لا يمكن النقل إلى قسم موقوف' });
  }

  const movedIds = target ? db.prepare('SELECT id FROM employees WHERE department_id=?').all(d.id).map(x => x.id) : [];
  db.transaction(() => {
    if (target) {
      db.prepare('UPDATE employees SET department_id=?, department=? WHERE department_id=?')
        .run(target.id, target.name, d.id);
    }
    db.prepare('DELETE FROM departments WHERE id=?').run(d.id);
  })();
  for (const id of movedIds) {
    createNotification({ type: 'system', title: 'نقل قسم',
      body: `أُلغي قسم «${d.name}» ونُقلت إلى «${target.name}»`, target_type: 'employee', target_id: String(id) });
  }

  audit(req, 'DEPARTMENT_DELETED', 'department', d.id,
    `${d.name} @ ${d.branch}${target ? ` · نُقل ${empCount} موظفاً إلى «${target.name}»` : ''}`);
  res.json({ ok: true, moved: empCount });
});

export default r;
