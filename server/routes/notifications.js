import { Router } from 'express';
import { db } from '../db.js';
import { authRequired } from '../auth.js';
import { VIS_SQL, visParams } from '../notify.js';

const r = Router();
r.use(authRequired);

const HIDDEN_SQL = 'NOT EXISTS(SELECT 1 FROM notification_hidden h WHERE h.notification_id = n.id AND h.employee_id = @eid)';
const READ_SQL = 'EXISTS(SELECT 1 FROM notification_reads rd WHERE rd.notification_id = n.id AND rd.employee_id = @eid)';
const PRIO_ORDER = "CASE n.priority WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END";

const unreadCount = (p) => db.prepare(
  `SELECT COUNT(*) c FROM notifications n WHERE ${VIS_SQL} AND ${HIDDEN_SQL} AND NOT ${READ_SQL}`).get(p).c;

/** مركز الإشعارات: بحث/فلترة/فرز/ترقيم — ضمن ما يخص الموظف حصراً. */
r.get('/notifications', (req, res) => {
  const p = visParams(req.user);
  const where = [VIS_SQL, HIDDEN_SQL];
  const q = String(req.query.q || '').trim();
  if (q) {
    p.like = '%' + q.replace(/[%_\\]/g, (m) => '\\' + m) + '%';
    where.push("(n.title LIKE @like ESCAPE '\\' OR n.body LIKE @like ESCAPE '\\')");
  }
  if (req.query.type === 'system' || req.query.type === 'admin') { p.type = req.query.type; where.push('n.type = @type'); }
  if (['low', 'normal', 'high', 'critical'].includes(req.query.priority)) { p.prio = req.query.priority; where.push('n.priority = @prio'); }
  if (req.query.status === 'read') where.push(READ_SQL);
  if (req.query.status === 'unread') where.push(`NOT ${READ_SQL}`);

  const wsql = 'WHERE ' + where.join(' AND ');
  const sort = req.query.sort === 'priority' ? `${PRIO_ORDER}` : 'n.id';
  const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';
  const per = Math.min(Math.max(Number(req.query.per) || 10, 1), 50);
  const total = db.prepare(`SELECT COUNT(*) c FROM notifications n ${wsql}`).get(p).c;
  const pages = Math.max(Math.ceil(total / per), 1);
  const page = Math.min(Math.max(Number(req.query.page) || 1, 1), pages);
  const rows = db.prepare(`
    SELECT n.id, n.title, n.body, n.type, n.priority, n.sender_name, n.created_at,
           CASE WHEN ${READ_SQL} THEN 1 ELSE 0 END AS read
    FROM notifications n ${wsql}
    ORDER BY ${sort} ${dir}, n.id DESC LIMIT @per OFFSET @off`)
    .all({ ...p, per, off: (page - 1) * per });
  res.json({ rows, total, page, per, pages, unread: unreadCount(p) });
});

r.get('/notifications/unread-count', (req, res) => {
  res.json({ unread: unreadCount(visParams(req.user)) });
});

/** تعليم مقروء (فردي/جماعي) — بحارس الرؤية، idempotent. نفس المسار القديم بشكله. */
r.post('/notifications/read', (req, res) => {
  const p = visParams(req.user);
  const ins = db.prepare(`INSERT OR IGNORE INTO notification_reads(employee_id, notification_id)
                          SELECT @eid, n.id FROM notifications n WHERE n.id = @nid AND ${VIS_SQL}`);
  for (const raw of (req.body?.ids || []).slice(0, 200)) {
    const id = Number(raw);
    if (Number.isInteger(id)) ins.run({ ...p, nid: id });
  }
  res.json({ ok: true, unread: unreadCount(p) });
});

r.post('/notifications/read-all', (req, res) => {
  const p = visParams(req.user);
  db.prepare(`INSERT OR IGNORE INTO notification_reads(employee_id, notification_id)
              SELECT @eid, n.id FROM notifications n
              WHERE ${VIS_SQL} AND ${HIDDEN_SQL} AND NOT ${READ_SQL}`).run(p);
  res.json({ ok: true, unread: 0 });
});

/** حذف من مركزي = إخفاء شخصي (فردي/جماعي) — الصف يبقى بأرشيف الإدارة. */
r.post('/notifications/hide', (req, res) => {
  const p = visParams(req.user);
  const ins = db.prepare(`INSERT OR IGNORE INTO notification_hidden(employee_id, notification_id)
                          SELECT @eid, n.id FROM notifications n WHERE n.id = @nid AND ${VIS_SQL}`);
  let done = 0;
  for (const raw of (req.body?.ids || []).slice(0, 200)) {
    const id = Number(raw);
    if (Number.isInteger(id)) done += ins.run({ ...p, nid: id }).changes;
  }
  res.json({ ok: true, done, unread: unreadCount(p) });
});

export default r;
