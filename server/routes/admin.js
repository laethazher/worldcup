import { Router } from 'express';
import crypto from 'node:crypto';
import { db, getSetting, setSetting } from '../db.js';
import { cleanName, nameTakenBy, NAME_TAKEN, normalizePhone, validPhone, phoneTakenBy, PHONE_TAKEN, PHONE_INVALID, USERNAME_RE, constraintMessage, findOrCreateBranch, resolveDepartment } from '../validation.js';
import { authRequired, adminRequired, hashPassword } from '../auth.js';
import { audit } from '../audit.js';
import { broadcast } from '../sse.js';
import { recalcAll, leaderboard, branchLeaderboard, AWARD_META } from '../scoring.js';
import { createNotification, validateTarget, recipientIds, PRIORITIES } from '../notify.js';
import { scoringConfig, STAGE_KEYS } from '../scoring.js';
import { isCompleted, completeTournament, regenerateWinners, reopenTournament, tournamentStatus, TOURNAMENT } from '../tournament.js';

/** إعلان ما بعد الاحتساب: لوحة حية + إنجازات (بث موجّه + تدقيق + إشعار نظام دائم). */
function announceRecalc(req, board, granted) {
  broadcast('leaderboard', { top: board.slice(0, 10) });
  for (const g of granted) {
    const meta = AWARD_META[g.code] || {};
    broadcast('achievement', { code: g.code, ...meta }, g.employee_id);
    const emp = db.prepare('SELECT name FROM employees WHERE id=?').get(g.employee_id);
    audit(req, 'ACHIEVEMENT_UNLOCKED', 'achievement', g.code,
      `${emp?.name ?? g.employee_id} · ${meta.name} (${meta.rarity ?? '—'})`);
    createNotification({ type: 'system',
      title: `🏅 إنجاز جديد: ${meta.name}`,
      body: `${meta.icon ?? ''} ${meta.desc}${meta.rarity === 'legendary' ? ' — أسطوري!' : ''}`.trim(),
      priority: meta.rarity === 'legendary' ? 'high' : 'normal',
      target_type: 'employee', target_id: String(g.employee_id) });
  }
}

const r = Router();
r.use(authRequired, adminRequired);

// ---------------------------------------------------------------- matches
const BRACKET = {
  97:  { winner: { match: 101, slot: 'home' } },
  98:  { winner: { match: 101, slot: 'away' } },
  99:  { winner: { match: 102, slot: 'home' } },
  100: { winner: { match: 102, slot: 'away' } },
  101: { winner: { match: 104, slot: 'home' }, loser: { match: 103, slot: 'home' } },
  102: { winner: { match: 104, slot: 'away' }, loser: { match: 103, slot: 'away' } },
};

r.post('/matches/:id/result', (req, res) => {
  if (isCompleted()) {
    return res.status(409).json({ error: 'البطولة مكتملة ومُقفلة — أعد فتحها من الإعدادات لتعديل النتائج', tournament_locked: true });
  }
  const m = db.prepare('SELECT * FROM matches WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'المباراة غير موجودة' });
  if (!m.home_team || !m.away_team) return res.status(400).json({ error: 'حدّد الفريقين أولاً' });

  let { home_score, away_score, advancing_team = null } = req.body || {};
  home_score = Number(home_score); away_score = Number(away_score);
  const ok = (n) => Number.isInteger(n) && n >= 0 && n <= 20;
  if (!ok(home_score) || !ok(away_score)) return res.status(400).json({ error: 'نتيجة غير صحيحة' });

  if (home_score > away_score) advancing_team = m.home_team;
  else if (away_score > home_score) advancing_team = m.away_team;
  else if (![m.home_team, m.away_team].includes(advancing_team)) {
    return res.status(400).json({ error: 'عند التعادل حدّد المتأهل بركلات الترجيح' });
  }

  db.prepare(`UPDATE matches SET home_score=?, away_score=?, advancing_team=?, status='finished',
              finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
    .run(home_score, away_score, advancing_team, m.id);

  // bracket propagation
  const hop = BRACKET[m.round_no];
  if (hop) {
    const loser = advancing_team === m.home_team ? m.away_team : m.home_team;
    if (hop.winner) db.prepare(`UPDATE matches SET ${hop.winner.slot}_team=? WHERE round_no=?`).run(advancing_team, hop.winner.match);
    if (hop.loser)  db.prepare(`UPDATE matches SET ${hop.loser.slot}_team=?  WHERE round_no=?`).run(loser, hop.loser.match);
  }

  const { board, granted } = recalcAll({ trigger: 'result', match_id: m.id, actor: req.user.name });
  const prev = m.status === 'finished' ? `${m.home_score}-${m.away_score} (${m.advancing_team})` : '—';
  audit(req, 'RESULT_ENTERED', 'match', m.id,
    `«${prev}» ← «${home_score}-${away_score} (${advancing_team})» · م${m.round_no} ${m.stage_ar}`);

  broadcast('match_result', { match_id: m.id, round_no: m.round_no, home_score, away_score, advancing_team });
  announceRecalc(req, board, granted);

  // اكتمال تلقائي: النهائي انتهى ← قفل + فائزون + كؤوس + قاعة + احتفال (مرة واحدة)
  if (m.stage === 'FINAL') {
    const w = completeTournament(req, board);
    if (w) announceRecalc(req, board, w.trophyGrants); // تسليم الكؤوس عبر منظومة الإنجازات ذاتها
  }
  // بث نقاط شخصي حي: لكل من توقع هذه المباراة نتيجتُه وسببها — مرة واحدة موجهة
  for (const row of db.prepare(
    'SELECT employee_id, points_total, calc_reason FROM predictions WHERE match_id = ?').all(m.id)) {
    broadcast('score_update',
      { match_id: m.id, round_no: m.round_no, points: row.points_total, reason: row.calc_reason },
      row.employee_id);
  }

  res.json({ ok: true });
});

/** تاريخ احتساب مباراة: توقع كل موظف + النقاط + السبب + المضاعف المستخدم. */
r.get('/matches/:id/scoring', (req, res) => {
  const m = db.prepare('SELECT id, round_no, stage_ar, status, home_score, away_score, multiplier FROM matches WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'المباراة غير موجودة' });
  const rows = db.prepare(`
    SELECT e.name, e.username, p.home_score, p.away_score, p.penalty_winner, p.joker,
           p.points_total, p.calc_reason, p.calc_multiplier, p.calc_breakdown
    FROM predictions p JOIN employees e ON e.id = p.employee_id
    WHERE p.match_id = ? ORDER BY p.points_total DESC, e.name`).all(m.id);
  res.json({ match: m, rows });
});

r.patch('/matches/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM matches WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'المباراة غير موجودة' });
  const { home_team, away_team, kickoff_utc, multiplier } = req.body || {};
  db.prepare(`UPDATE matches SET
      home_team = COALESCE(?, home_team),
      away_team = COALESCE(?, away_team),
      kickoff_utc = COALESCE(?, kickoff_utc),
      multiplier = COALESCE(?, multiplier)
    WHERE id=?`)
    .run(home_team ?? null, away_team ?? null, kickoff_utc ?? null, multiplier ?? null, m.id);
  audit(req, 'MATCH_UPDATED', 'match', m.id, JSON.stringify(req.body));
  broadcast('matches_changed', { match_id: m.id });
  res.json({ ok: true });
});

r.post('/recalculate', (req, res) => {
  if (isCompleted() && req.body?.force !== true) {
    return res.status(409).json({ error: 'البطولة مكتملة — أعد الاحتساب بالفرض الصريح فقط (force)', needs_force: true });
  }
  const forced = isCompleted();
  const { board, granted } = recalcAll({ trigger: forced ? 'forced' : 'manual', actor: req.user.name });
  audit(req, 'RECALCULATED', 'system', '', forced ? 'فرض صريح بعد اكتمال البطولة' : '');
  announceRecalc(req, board, granted);
  res.json({ ok: true, players: board.length });
});

// ---------------------------------------------------------------- employees
const EMP_SORTS = {
  name: 'e.name', username: 'e.username', created: 'e.created_at',
  last_login: 'e.last_login_at', logins: 'e.login_count', branch: 'b.name',
};

/** باني استعلام مشترك (القائمة + التصدير) — أعمدة الفرز مقيدة بقائمة بيضاء */
function employeeFilter(q) {
  const where = [], args = [];
  const text = String(q.q || '').trim();
  if (text) {
    const like = '%' + text.replace(/[%_\\]/g, (m) => '\\' + m) + '%';
    where.push("(e.name LIKE ? ESCAPE '\\' OR e.username LIKE ? ESCAPE '\\' OR IFNULL(e.phone,'') LIKE ? ESCAPE '\\')");
    args.push(like, like, like);
  }
  if (q.branch) { where.push('e.branch_id = ?'); args.push(Number(q.branch)); }
  if (q.role === 'admin' || q.role === 'employee') { where.push('e.role = ?'); args.push(q.role); }
  if (q.status === 'active') where.push('e.active = 1');
  if (q.status === 'disabled') where.push('e.active = 0');
  const sort = EMP_SORTS[q.sort] || 'e.name';
  const dir = q.dir === 'desc' ? 'DESC' : 'ASC';
  return {
    wsql: where.length ? 'WHERE ' + where.join(' AND ') : '',
    args,
    order: `ORDER BY ${sort} ${dir}, e.id ASC`,
  };
}

const EMP_SELECT = `
  SELECT e.id, e.username, e.name, e.phone, e.department, e.role, e.active,
         e.photo_url, e.created_at, e.last_login_at, e.login_count,
         b.name AS branch, e.branch_id
  FROM employees e LEFT JOIN branches b ON b.id = e.branch_id`;

r.get('/employees', (req, res) => {
  const f = employeeFilter(req.query);
  const per = Math.min(Math.max(Number(req.query.per) || 10, 1), 100);
  const total = db.prepare(`SELECT COUNT(*) c FROM employees e LEFT JOIN branches b ON b.id=e.branch_id ${f.wsql}`).get(...f.args).c;
  const pages = Math.max(Math.ceil(total / per), 1);
  const page = Math.min(Math.max(Number(req.query.page) || 1, 1), pages);
  const rows = db.prepare(`${EMP_SELECT} ${f.wsql} ${f.order} LIMIT ? OFFSET ?`)
    .all(...f.args, per, (page - 1) * per);
  res.json({ rows, total, page, per, pages });
});

/** سجل نشاط موظف: ما فعله + ما فُعل بحسابه */
r.get('/employees/:id/activity', (req, res) => {
  const e = db.prepare('SELECT id, name FROM employees WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'الموظف غير موجود' });
  const rows = db.prepare(`
    SELECT action, entity, entity_id, details, actor_id, actor_name, created_at
    FROM audit_logs
    WHERE actor_id = ? OR (entity = 'employee' AND entity_id = ?)
    ORDER BY id DESC LIMIT 150`).all(e.id, String(e.id));
  res.json({ employee: e, rows });
});

const branchId = (name) => findOrCreateBranch(name);
const branchNameOf = (id) => id ? (db.prepare('SELECT name FROM branches WHERE id=?').get(id)?.name ?? null) : null;
const diffPart = (label, a, b) => `${label}: «${a ?? '—'}» ← «${b ?? '—'}»`;

const genPassword = () => crypto.randomBytes(4).toString('hex');


r.post('/employees', (req, res) => {
  const { department = '', branch = '', role = 'employee' } = req.body || {};
  const name = cleanName(req.body?.name);
  const username = String(req.body?.username ?? '').trim();
  const phone = normalizePhone(req.body?.phone);
  const password = String(req.body?.password ?? '');
  const confirm = String(req.body?.confirm ?? '');

  if (!name) return res.status(400).json({ error: 'الاسم الكامل مطلوب' });
  if (!username) return res.status(400).json({ error: 'اسم المستخدم مطلوب' });
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'اسم المستخدم: 3–32 حرفاً لاتينياً أو أرقاماً أو . _ -' });
  if (!phone) return res.status(400).json({ error: 'رقم الهاتف مطلوب' });
  if (!validPhone(phone)) return res.status(400).json({ error: PHONE_INVALID });
  if (!password) return res.status(400).json({ error: 'كلمة المرور مطلوبة' });
  if (password.length < 8) return res.status(400).json({ error: 'كلمة المرور: ٨ أحرف على الأقل' });
  if (password !== confirm) return res.status(400).json({ error: 'تأكيد كلمة المرور غير مطابق' });

  if (db.prepare('SELECT 1 FROM employees WHERE username=?').get(username)) {
    return res.status(409).json({ error: 'اسم المستخدم موجود مسبقاً' });
  }
  if (nameTakenBy(name)) return res.status(409).json({ error: NAME_TAKEN });
  if (phoneTakenBy(phone)) return res.status(409).json({ error: PHONE_TAKEN });

  try {
    const bId = branchId(branch);
    const dep = resolveDepartment(bId, department);
    const info = db.prepare(`INSERT INTO employees(username,password_hash,name,phone,department,department_id,branch_id,role)
                             VALUES(?,?,?,?,?,?,?,?)`)
      .run(username, hashPassword(password), name, phone, dep ? dep.name : cleanName(department), dep ? dep.id : null,
           bId, role === 'admin' ? 'admin' : 'employee');
    audit(req, 'EMPLOYEE_CREATED', 'employee', info.lastInsertRowid, `${username} · ${phone}`);
    res.json({ ok: true, id: info.lastInsertRowid, password });
  } catch (e) {
    const msg = constraintMessage(e);
    if (msg) return res.status(409).json({ error: msg });
    throw e;
  }
});

r.patch('/employees/:id', (req, res) => {
  const e = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'الموظف غير موجود' });
  const { department, branch, photo_url, password } = req.body || {};
  let role = req.body?.role;
  if (role !== undefined && role !== 'admin' && role !== 'employee') {
    return res.status(400).json({ error: 'الدور غير صحيح' });
  }
  const active = req.body?.active;
  const lastActiveAdmin = e.role === 'admin' && e.active === 1 &&
    db.prepare(`SELECT COUNT(*) c FROM employees WHERE role='admin' AND active=1`).get().c <= 1;
  if (lastActiveAdmin) {
    if (active === false) return res.status(400).json({ error: 'لا يمكن إيقاف آخر حساب إدارة نشط في النظام' });
    if (role === 'employee') return res.status(400).json({ error: 'لا يمكن تخفيض آخر حساب إدارة نشط في النظام' });
  }
  let name = req.body?.name !== undefined ? cleanName(req.body.name) : undefined;
  if (name !== undefined) {
    if (!name) return res.status(400).json({ error: 'الاسم الكامل لا يمكن أن يكون فارغاً' });
    if (nameTakenBy(name, e.id)) return res.status(409).json({ error: NAME_TAKEN });
  }
  let phone;
  if (req.body?.phone !== undefined) {
    phone = normalizePhone(req.body.phone);
    if (phone === '') phone = null;                       // مسح الرقم مسموح للإدارة
    else {
      if (!validPhone(phone)) return res.status(400).json({ error: PHONE_INVALID });
      if (phoneTakenBy(phone, e.id)) return res.status(409).json({ error: PHONE_TAKEN });
    }
  }

  // إعادة ربط القسم ككيان إذا تغيّر الفرع أو نص القسم
  const branchProvided = branch !== undefined;
  const deptProvided = department !== undefined;
  const finalBranchId = branchProvided ? branchId(branch) : e.branch_id;
  let deptName = null, deptId = null;
  const rebindDept = branchProvided || deptProvided;
  if (rebindDept) {
    const text = deptProvided ? department : e.department;
    const dep = resolveDepartment(finalBranchId, text);
    deptName = dep ? dep.name : cleanName(text);
    deptId = dep ? dep.id : null;
  }

  try {
    db.prepare(`UPDATE employees SET
        name = COALESCE(@name, name),
        role = COALESCE(@role, role),
        active = COALESCE(@active, active),
        photo_url = COALESCE(@photo, photo_url),
        branch_id = CASE WHEN @setBranch THEN @branchId ELSE branch_id END,
        department = CASE WHEN @setDept THEN @deptName ELSE department END,
        department_id = CASE WHEN @setDept THEN @deptId ELSE department_id END,
        phone = CASE WHEN @setPhone THEN @phone ELSE phone END
      WHERE id = @id`)
      .run({
        name: name ?? null, role: role ?? null,
        active: active === undefined ? null : (active ? 1 : 0),
        photo: photo_url ?? null,
        setBranch: branchProvided ? 1 : 0, branchId: finalBranchId,
        setDept: rebindDept ? 1 : 0, deptName, deptId,
        setPhone: req.body?.phone !== undefined ? 1 : 0, phone: phone ?? null,
        id: e.id,
      });
  } catch (err) {
    const msg = constraintMessage(err);
    if (msg) return res.status(409).json({ error: msg });
    throw err;
  }
  let newPw = null;
  if (password === true || password === 'reset') {
    newPw = genPassword();
    db.prepare('UPDATE employees SET password_hash=?, token_version = token_version + 1 WHERE id=?').run(hashPassword(newPw), e.id);
  } else if (typeof password === 'string' && password.length > 0 && password.length < 8) {
    return res.status(400).json({ error: 'كلمة المرور: ٨ أحرف على الأقل' });
  } else if (typeof password === 'string' && password.length >= 8) {
    db.prepare('UPDATE employees SET password_hash=?, token_version = token_version + 1 WHERE id=?').run(hashPassword(password), e.id);
  }
  // فروقات حقلية: قديم ← جديد (بلا أي قيم حساسة إطلاقاً)
  const changes = [];
  if (name !== undefined && name !== e.name) changes.push(diffPart('الاسم', e.name, name));
  if (req.body?.phone !== undefined && (phone ?? null) !== (e.phone ?? null)) changes.push(diffPart('الهاتف', e.phone, phone));
  if (branchProvided && finalBranchId !== e.branch_id) changes.push(diffPart('الفرع', branchNameOf(e.branch_id), branchNameOf(finalBranchId)));
  if (rebindDept && (deptName ?? '') !== (e.department ?? '')) changes.push(diffPart('القسم', e.department || null, deptName || null));
  if (role !== undefined && role !== e.role) changes.push(diffPart('الدور', e.role === 'admin' ? 'إدارة' : 'موظف', role === 'admin' ? 'إدارة' : 'موظف'));
  if (active !== undefined && (active ? 1 : 0) !== e.active) changes.push(diffPart('الحالة', e.active ? 'فعّال' : 'موقوف', active ? 'فعّال' : 'موقوف'));
  if (newPw) changes.push('كلمة المرور: أُعيد تعيينها (توليد)');
  else if (typeof password === 'string' && password.length >= 8) changes.push('كلمة المرور: غُيّرت (إدخال يدوي)');
  audit(req, 'EMPLOYEE_UPDATED', 'employee', e.id, changes.length ? changes.join(' · ') : 'بلا تغييرات');

  // إشعارات نظام تلقائية — تُطلق فقط عند تغيّر فعلي (لا تكرار ولا ضجيج)
  const sysN = (title, bodyTxt, prio = 'normal') =>
    createNotification({ type: 'system', title, body: bodyTxt, priority: prio,
      target_type: 'employee', target_id: String(e.id) });
  if (active !== undefined && (active ? 1 : 0) !== e.active) {
    if (active) sysN('تم تفعيل حسابك', 'أهلاً بعودتك — حسابك فعّال ويمكنك التوقع من جديد', 'high');
    else sysN('تم إيقاف حسابك', 'حسابك موقوف مؤقتاً — راجع الإدارة للتفاصيل', 'critical');
  }
  if (newPw || (typeof password === 'string' && password.length >= 8)) {
    sysN('أُعيد تعيين كلمة مرورك', 'أُنهيت كل جلساتك المفتوحة — استلم كلمة المرور الجديدة من الإدارة', 'critical');
  }
  if (branchProvided && finalBranchId !== e.branch_id) {
    sysN('نقل فرع', `فرعك الجديد: «${branchNameOf(finalBranchId) ?? '—'}»`);
  }
  if (rebindDept && (deptName ?? '') !== (e.department ?? '')) {
    sysN('نقل قسم', `قسمك الجديد: «${deptName || '—'}»`);
  }
  res.json({ ok: true, password: newPw });
});

/** استيراد v2: username,الاسم,الهاتف,الفرع,القسم[,كلمة المرور] — تحقق كامل وتقرير برقم السطر */
r.post('/employees/import', (req, res) => {
  const csv = String(req.body?.csv || '').trim();
  if (!csv) return res.status(400).json({ error: 'ألصق بيانات الموظفين أولاً' });
  const created = [], errors = [];
  const seenU = new Set(), seenN = new Set(), seenP = new Set();
  const ins = db.prepare(`INSERT INTO employees(username,password_hash,name,phone,department,department_id,branch_id) VALUES(?,?,?,?,?,?,?)`);
  const lines = csv.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const no = i + 1;
    const line = lines[i].trim();
    if (!line || line.startsWith('#') || /^username\s*,/i.test(line)) continue;
    const fail = (reason) => errors.push({ no, line, reason });

    const [username = '', rawName = '', rawPhone = '', branch = '', department = '', pw = '']
      = line.split(',').map(x => x?.trim() ?? '');
    const name = cleanName(rawName);
    const phone = normalizePhone(rawPhone);

    if (!username) { fail('اسم المستخدم مطلوب'); continue; }
    if (!USERNAME_RE.test(username)) { fail('اسم المستخدم: 3–32 حرفاً لاتينياً أو أرقاماً أو . _ -'); continue; }
    if (!name) { fail('الاسم الكامل مطلوب'); continue; }
    if (!phone) { fail('رقم الهاتف مطلوب — الصيغة: username,الاسم,الهاتف,الفرع,القسم'); continue; }
    if (!validPhone(phone)) { fail(PHONE_INVALID); continue; }
    if (pw && pw.length < 8) { fail('كلمة المرور المزوّدة أقصر من ٨ أحرف'); continue; }

    const nk = name.toLowerCase();
    if (seenU.has(username.toLowerCase()) || db.prepare('SELECT 1 FROM employees WHERE username=?').get(username)) { fail('اسم المستخدم مكرر'); continue; }
    if (seenN.has(nk) || nameTakenBy(name)) { fail(NAME_TAKEN); continue; }
    if (seenP.has(phone) || phoneTakenBy(phone)) { fail(PHONE_TAKEN); continue; }

    const password = pw || genPassword();
    try {
      const bId = branchId(branch);
      const dep = resolveDepartment(bId, department);
      ins.run(username, hashPassword(password), name, phone, dep ? dep.name : cleanName(department), dep ? dep.id : null, bId);
      seenU.add(username.toLowerCase()); seenN.add(nk); seenP.add(phone);
      created.push({ username, name, phone, branch, department, password });
    } catch (e) {
      fail(constraintMessage(e) || 'خطأ قاعدة بيانات');
    }
  }
  audit(req, 'EMPLOYEES_IMPORTED', 'employee', '',
    `أُنشئ:${created.length} · أخطاء:${errors.length}${errors.length ? ' → أسطر ' + errors.map(e => e.no).join(',') : ''}`);
  res.json({ ok: true, created, errors });
});

r.post('/employees/bulk', (req, res) => {
  const op = req.body?.op;
  const ids = [...new Set((req.body?.ids || []).map(Number).filter(Number.isInteger))];
  if (!['enable', 'disable', 'delete', 'move'].includes(op)) return res.status(400).json({ error: 'عملية غير معروفة' });
  if (!ids.length) return res.status(400).json({ error: 'اختر موظفاً واحداً على الأقل' });
  const branch = op === 'move' ? String(req.body?.branch || '').trim() : null;
  if (op === 'move' && !branch) return res.status(400).json({ error: 'اختر الفرع الهدف' });

  const activeAdmins = () => db.prepare(`SELECT COUNT(*) c FROM employees WHERE role='admin' AND active=1`).get().c;
  const done = [], skipped = [];
  for (const id of ids) {
    const e = db.prepare('SELECT * FROM employees WHERE id=?').get(id);
    if (!e) { skipped.push({ id, name: `#${id}`, reason: 'غير موجود' }); continue; }
    if (op === 'delete') {
      if (e.id === req.user.id) { skipped.push({ id, name: e.name, reason: 'حسابك الحالي' }); continue; }
      if (e.role === 'admin' && e.active && activeAdmins() <= 1) { skipped.push({ id, name: e.name, reason: 'آخر إدارة نشطة' }); continue; }
      db.prepare('DELETE FROM employees WHERE id=?').run(e.id);
      audit(req, 'EMPLOYEE_DELETED', 'employee', e.id, `${e.username} · ${e.name}${e.phone ? ' · ' + e.phone : ''} (جماعي)`);
      done.push(id); continue;
    }
    if (op === 'disable') {
      if (e.id === req.user.id) { skipped.push({ id, name: e.name, reason: 'حسابك الحالي' }); continue; }
      if (e.role === 'admin' && e.active && activeAdmins() <= 1) { skipped.push({ id, name: e.name, reason: 'آخر إدارة نشطة' }); continue; }
      db.prepare('UPDATE employees SET active=0 WHERE id=?').run(e.id);
      if (e.active) createNotification({ type: 'system', title: 'تم إيقاف حسابك', body: 'حسابك موقوف مؤقتاً — راجع الإدارة للتفاصيل', priority: 'critical', target_type: 'employee', target_id: String(e.id) });
      done.push(id); continue;
    }
    if (op === 'enable') {
      db.prepare('UPDATE employees SET active=1 WHERE id=?').run(e.id);
      if (!e.active) createNotification({ type: 'system', title: 'تم تفعيل حسابك', body: 'أهلاً بعودتك — حسابك فعّال من جديد', priority: 'high', target_type: 'employee', target_id: String(e.id) });
      done.push(id); continue;
    }
    if (op === 'move') {
      const bId = branchId(branch);
      const dep = resolveDepartment(bId, e.department);
      db.prepare('UPDATE employees SET branch_id=?, department_id=?, department=? WHERE id=?')
        .run(bId, dep ? dep.id : null, dep ? dep.name : e.department, e.id);
      if (bId !== e.branch_id) createNotification({ type: 'system', title: 'نقل فرع', body: `فرعك الجديد: «${branchNameOf(bId) ?? '—'}»`, target_type: 'employee', target_id: String(e.id) });
      done.push(id); continue;
    }
  }
  if (op === 'delete' && done.length) {
    const { board } = recalcAll();
    broadcast('leaderboard', { top: board.slice(0, 10) });
  }
  audit(req, 'BULK_' + op.toUpperCase(), 'employee', '',
    JSON.stringify({ ids, done: done.length, skipped: skipped.map(s => `${s.name}:${s.reason}`), branch }));
  res.json({ ok: true, done: done.length, skipped });
});

r.delete('/employees/:id', (req, res) => {
  const e = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'الموظف غير موجود' });
  if (e.id === req.user.id) return res.status(400).json({ error: 'لا يمكنك حذف حسابك الحالي' });
  if (e.role === 'admin' && e.active) {
    const activeAdmins = db.prepare(`SELECT COUNT(*) c FROM employees WHERE role='admin' AND active=1`).get().c;
    if (activeAdmins <= 1) return res.status(400).json({ error: 'لا يمكن حذف آخر حساب إدارة نشط في النظام' });
  }
  db.prepare('DELETE FROM employees WHERE id=?').run(e.id); // التوقعات/الإنجازات تُحذف تتابعياً (FK CASCADE)
  const { board } = recalcAll();
  broadcast('leaderboard', { top: board.slice(0, 10) });
  audit(req, 'EMPLOYEE_DELETED', 'employee', e.id, `${e.username} · ${e.name}${e.phone ? ' · ' + e.phone : ''}`);
  res.json({ ok: true });
});

r.get('/branches', (_req, res) => res.json(db.prepare('SELECT id, name, active FROM branches ORDER BY active DESC, name').all()));
r.post('/branches', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'أدخل اسم الفرع' });
  const id = branchId(name);
  audit(req, 'BRANCH_CREATED', 'branch', id, name);
  res.json({ ok: true, id });
});

// ---------------------------------------------------------------- exports
function csvResponse(res, filename, headers, rows) {
  const esc = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const body = '\uFEFF' + [headers, ...rows].map(r => r.map(esc).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(body);
}

r.get('/export/leaderboard.csv', (req, res) => {
  const board = leaderboard();
  audit(req, 'EXPORT', 'leaderboard');
  csvResponse(res, 'ترتيب-تحدي-كاس-العالم.csv',
    ['المركز', 'الاسم', 'الفرع', 'القسم', 'النقاط', 'توقعات دقيقة', 'نسبة الدقة ٪', 'مكافأة البطل'],
    board.map(b => [b.rank, b.name, b.branch || '', b.department || '', b.points, b.exact_count, b.accuracy, b.champion_bonus]));
});

const USER_EXPORT_COLS = [
  ['الاسم الكامل', (e) => e.name],
  ['اسم المستخدم', (e) => e.username],
  ['رقم الهاتف', (e) => e.phone || ''],
  ['الفرع', (e) => e.branch || ''],
  ['الدور', (e) => e.role === 'admin' ? 'إدارة' : 'موظف'],
  ['الحالة', (e) => e.active ? 'فعّال' : 'موقوف'],
  ['تاريخ الإنشاء', (e) => e.created_at],
  ['آخر تسجيل دخول', (e) => e.last_login_at || ''],
  ['مرات الدخول', (e) => e.login_count],
];

function exportUsers(req) {
  const f = employeeFilter(req.query);
  return db.prepare(`${EMP_SELECT} ${f.wsql} ${f.order}`).all(...f.args);
}

r.get('/export/users.csv', (req, res) => {
  const rows = exportUsers(req);
  audit(req, 'EXPORT', 'users', '', `csv · ${rows.length} سجلاً`);
  csvResponse(res, 'موظفو-الحسني.csv',
    USER_EXPORT_COLS.map(c => c[0]),
    rows.map(e => USER_EXPORT_COLS.map(c => c[1](e))));
});

r.get('/export/users.xlsx', async (req, res) => {
  const rows = exportUsers(req);
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'الحسني هوم سنتر — تحدي كأس العالم';
  const ws = wb.addWorksheet('الموظفون', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
  ws.columns = USER_EXPORT_COLS.map(([header], i) => ({
    header, key: 'c' + i, width: [24, 16, 15, 14, 10, 10, 22, 22, 12][i],
  }));
  for (const e of rows) {
    ws.addRow(Object.fromEntries(USER_EXPORT_COLS.map(([, fn], i) => ['c' + i, fn(e)])));
  }
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFA51E2F' } };
  head.alignment = { vertical: 'middle' };
  head.height = 22;
  audit(req, 'EXPORT', 'users', '', `xlsx · ${rows.length} سجلاً`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('موظفو-الحسني.xlsx')}`);
  const buf = await wb.xlsx.writeBuffer();
  res.send(Buffer.from(buf));
});

r.get('/export/predictions.csv', (req, res) => {
  const rows = db.prepare(`
    SELECT e.name emp, b.name branch, m.round_no, m.stage_ar,
           th.name_ar home, ta.name_ar away,
           p.home_score, p.away_score, p.penalty_winner, p.joker, p.points_total, p.calc_reason, p.calc_multiplier, p.created_at
    FROM predictions p
    JOIN employees e ON e.id=p.employee_id
    LEFT JOIN branches b ON b.id=e.branch_id
    JOIN matches m ON m.id=p.match_id
    LEFT JOIN teams th ON th.code=m.home_team
    LEFT JOIN teams ta ON ta.code=m.away_team
    ORDER BY m.kickoff_utc, e.name`).all();
  audit(req, 'EXPORT', 'predictions');
  csvResponse(res, 'توقعات-الموظفين.csv',
    ['الموظف', 'الفرع', 'رقم المباراة', 'المرحلة', 'المضيف', 'الضيف', 'توقع المضيف', 'توقع الضيف', 'المتأهل بالترجيح', 'جوكر', 'النقاط', 'سبب الاحتساب', 'المضاعف', 'وقت التوقع'],
    rows.map(x => [x.emp, x.branch || '', x.round_no, x.stage_ar, x.home, x.away, x.home_score, x.away_score, x.penalty_winner || '', x.joker ? 'نعم' : '', x.points_total ?? '', x.calc_reason ?? '', x.calc_multiplier ?? '', x.created_at]));
});

// ---------------------------------------------------------------- notifications, audit, analytics
/** إرسال إشعار إداري مستهدف — التوافق الرجعي محفوظ: {title, body} فقط = عام/عادي. */
r.post('/notifications', (req, res) => {
  const title = String(req.body?.title || '').trim();
  const body = String(req.body?.body || '').trim();
  const priority = req.body?.priority ?? 'normal';
  const target_type = req.body?.target_type ?? 'all';
  if (!title) return res.status(400).json({ error: 'أدخل عنوان الإشعار' });
  if (title.length > 120) return res.status(400).json({ error: 'العنوان: 120 حرفاً كحد أقصى' });
  if (body.length > 2000) return res.status(400).json({ error: 'النص: 2000 حرف كحد أقصى' });
  if (!PRIORITIES.includes(priority)) return res.status(400).json({ error: 'الأولوية غير صحيحة' });
  const t = validateTarget(target_type, req.body?.target_id);
  if (t.error) return res.status(400).json({ error: t.error });

  const row = createNotification({ type: 'admin', title, body, priority,
    target_type, target_id: t.target_id, sender: req.user });
  const recips = recipientIds(target_type, t.target_id).length;
  audit(req, 'NOTIFICATION_SENT', 'notification', row.id, `«${title}» · ${priority} · ${t.label} · ${recips} مستلماً`);
  res.json({ ok: true, id: row.id, recipients: recips });
});

/** أرشيف المرسَل (إداري): ترقيم + بحث + فلاتر + عدادات قراءة/استلام. */
r.get('/notifications', (req, res) => {
  const where = [], args = [];
  const q = String(req.query.q || '').trim();
  if (q) {
    const like = '%' + q.replace(/[%_\\]/g, (m) => '\\' + m) + '%';
    where.push("(n.title LIKE ? ESCAPE '\\' OR n.body LIKE ? ESCAPE '\\')"); args.push(like, like);
  }
  if (req.query.type === 'system' || req.query.type === 'admin') { where.push('n.type = ?'); args.push(req.query.type); }
  if (['all', 'employee', 'branch', 'department', 'role'].includes(req.query.target_type)) {
    where.push('n.target_type = ?'); args.push(req.query.target_type);
  }
  const wsql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const per = Math.min(Math.max(Number(req.query.per) || 10, 1), 50);
  const total = db.prepare(`SELECT COUNT(*) c FROM notifications n ${wsql}`).get(...args).c;
  const pages = Math.max(Math.ceil(total / per), 1);
  const page = Math.min(Math.max(Number(req.query.page) || 1, 1), pages);
  const rows = db.prepare(`
    SELECT n.*, (SELECT COUNT(*) FROM notification_reads rd WHERE rd.notification_id = n.id) AS reads
    FROM notifications n ${wsql} ORDER BY n.id DESC LIMIT ? OFFSET ?`)
    .all(...args, per, (page - 1) * per)
    .map(n => {
      const t = validateTarget(n.target_type, n.target_id);
      return { ...n, target_label: t.error ? '— (هدف محذوف)' : t.label,
        recipients: t.error ? 0 : recipientIds(n.target_type, n.target_id).length };
    });
  res.json({ rows, total, page, per, pages });
});

r.delete('/notifications/:id', (req, res) => {
  const n = db.prepare('SELECT * FROM notifications WHERE id=?').get(req.params.id);
  if (!n) return res.status(404).json({ error: 'الإشعار غير موجود' });
  db.prepare('DELETE FROM notifications WHERE id=?').run(n.id); // القراءات/الإخفاءات تتابعياً
  broadcast('notifications_changed', { id: n.id });
  audit(req, 'NOTIFICATION_DELETED', 'notification', n.id, `«${n.title}»`);
  res.json({ ok: true });
});


// ---------------------------------------------------------------- audit log (قراءة فقط)
const AUDIT_RESULT_SQL = `COALESCE(a.result,
  CASE WHEN a.action LIKE '%FAILED%' OR a.action LIKE '%DENIED%' THEN 'failure' ELSE 'success' END)`;
const AUDIT_SORTS = { time: 'a.id', actor: 'a.actor_name', action: 'a.action', result: 'res' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function auditFilter(q) {
  const where = [], args = [];
  const text = String(q.q || '').trim();
  if (text) {
    const like = '%' + text.replace(/[%_\\]/g, (m) => '\\' + m) + '%';
    where.push(`(a.actor_name LIKE ? ESCAPE '\\' OR IFNULL(a.actor_username,'') LIKE ? ESCAPE '\\'
                 OR a.details LIKE ? ESCAPE '\\' OR a.entity_id LIKE ? ESCAPE '\\')`);
    args.push(like, like, like, like);
  }
  if (q.action) { where.push('a.action = ?'); args.push(String(q.action)); }
  if (q.actor) { where.push('a.actor_id = ?'); args.push(Number(q.actor)); }
  if (q.result === 'success' || q.result === 'failure') { where.push(`${AUDIT_RESULT_SQL} = ?`); args.push(q.result); }
  if (q.from) { where.push('a.created_at >= ?'); args.push(`${q.from}T00:00:00.000Z`); }
  if (q.to) { where.push('a.created_at <= ?'); args.push(`${q.to}T23:59:59.999Z`); }
  return { wsql: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}

const AUDIT_SELECT = `
  SELECT a.id, a.created_at, a.actor_id, a.actor_name, a.actor_username, a.actor_role,
         a.actor_branch, a.ip, a.user_agent, a.action, a.entity, a.entity_id, a.details,
         ${AUDIT_RESULT_SQL} AS res
  FROM audit_logs a`;

r.get('/audit', (req, res) => {
  for (const k of ['from', 'to']) {
    if (req.query[k] && !DATE_RE.test(String(req.query[k]))) {
      return res.status(400).json({ error: 'صيغة التاريخ غير صحيحة — المطلوب YYYY-MM-DD' });
    }
  }
  const f = auditFilter(req.query);
  const per = Math.min(Math.max(Number(req.query.per) || 15, 1), 200);
  const total = db.prepare(`SELECT COUNT(*) c FROM audit_logs a ${f.wsql}`).get(...f.args).c;
  const pages = Math.max(Math.ceil(total / per), 1);
  const page = Math.min(Math.max(Number(req.query.page) || 1, 1), pages);
  const sort = AUDIT_SORTS[req.query.sort] || 'a.id';
  const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';
  const rows = db.prepare(`${AUDIT_SELECT} ${f.wsql} ORDER BY ${sort} ${dir}, a.id DESC LIMIT ? OFFSET ?`)
    .all(...f.args, per, (page - 1) * per);
  res.json({ rows, total, page, per, pages });
});

r.get('/audit/meta', (_req, res) => {
  res.json({
    actions: db.prepare('SELECT DISTINCT action FROM audit_logs ORDER BY action').all().map(r => r.action),
    actors: db.prepare(`SELECT DISTINCT actor_id AS id, actor_name AS name FROM audit_logs
                        WHERE actor_id IS NOT NULL ORDER BY actor_name`).all(),
  });
});

const AUDIT_EXPORT_COLS = [
  ['التوقيت', (r) => r.created_at],
  ['المستخدم', (r) => r.actor_name],
  ['اسم المستخدم', (r) => r.actor_username || ''],
  ['الدور', (r) => r.actor_role === 'admin' ? 'إدارة' : (r.actor_role === 'employee' ? 'موظف' : '')],
  ['الفرع', (r) => r.actor_branch || ''],
  ['عنوان IP', (r) => r.ip || ''],
  ['User-Agent', (r) => r.user_agent || ''],
  ['الحركة', (r) => r.action],
  ['الهدف', (r) => r.entity ? `${r.entity}${r.entity_id ? '#' + r.entity_id : ''}` : ''],
  ['التفاصيل', (r) => r.details || ''],
  ['النتيجة', (r) => r.res === 'failure' ? 'فشل' : 'نجاح'],
];

function exportAudit(req) {
  const f = auditFilter(req.query);
  return db.prepare(`${AUDIT_SELECT} ${f.wsql} ORDER BY a.id DESC`).all(...f.args);
}

r.get('/export/audit.csv', (req, res) => {
  const rows = exportAudit(req);
  audit(req, 'EXPORT', 'audit', '', `csv · ${rows.length} سجلاً`);
  csvResponse(res, 'سجل-التدقيق.csv',
    AUDIT_EXPORT_COLS.map(c => c[0]),
    rows.map(r0 => AUDIT_EXPORT_COLS.map(c => c[1](r0))));
});

r.get('/export/audit.xlsx', async (req, res) => {
  const rows = exportAudit(req);
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'الحسني هوم سنتر — تحدي كأس العالم';
  const ws = wb.addWorksheet('سجل التدقيق', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
  ws.columns = AUDIT_EXPORT_COLS.map(([header], i) => ({
    header, key: 'c' + i, width: [22, 18, 14, 8, 12, 14, 28, 20, 16, 40, 8][i],
  }));
  for (const r0 of rows) ws.addRow(Object.fromEntries(AUDIT_EXPORT_COLS.map(([, fn], i) => ['c' + i, fn(r0)])));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFA51E2F' } };
  head.height = 22;
  audit(req, 'EXPORT', 'audit', '', `xlsx · ${rows.length} سجلاً`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('سجل-التدقيق.xlsx')}`);
  const buf = await wb.xlsx.writeBuffer();
  res.send(Buffer.from(buf));
});

r.get('/analytics', (_req, res) => {
  const board = leaderboard();
  const branches = branchLeaderboard();
  const employees = db.prepare(`SELECT COUNT(*) c FROM employees WHERE active=1 AND role!='admin'`).get().c;

  const perMatch = db.prepare(`
    SELECT m.id, m.round_no, m.stage_ar,
           COALESCE(th.name_ar, m.placeholder_home) home, COALESCE(ta.name_ar, m.placeholder_away) away,
           m.status, m.kickoff_utc,
           (SELECT COUNT(*) FROM predictions p WHERE p.match_id=m.id) preds,
           (SELECT COALESCE(SUM(is_exact),0) FROM predictions p WHERE p.match_id=m.id) exact
    FROM matches m
    LEFT JOIN teams th ON th.code=m.home_team
    LEFT JOIN teams ta ON ta.code=m.away_team
    ORDER BY m.kickoff_utc`).all()
    .map(x => ({ ...x, participation: employees ? Math.round(x.preds / employees * 100) : 0 }));

  const teamPulls = db.prepare(`
    SELECT t.name_ar name, COUNT(*) c FROM predictions p
    JOIN matches m ON m.id=p.match_id
    JOIN teams t ON t.code = CASE
      WHEN p.home_score>p.away_score THEN m.home_team
      WHEN p.away_score>p.home_score THEN m.away_team
      ELSE p.penalty_winner END
    GROUP BY t.code ORDER BY c DESC LIMIT 8`).all();

  const championVotes = db.prepare(`
    SELECT t.name_ar name, COUNT(*) c FROM employees e JOIN teams t ON t.code=e.champion_team
    WHERE e.active=1 AND e.role!='admin' GROUP BY t.code ORDER BY c DESC`).all();

  res.json({
    totals: {
      employees,
      predictions: db.prepare('SELECT COUNT(*) c FROM predictions').get().c,
      exact: db.prepare('SELECT COALESCE(SUM(is_exact),0) c FROM predictions').get().c,
      avg_points: board.length ? +(board.reduce((s, b) => s + b.points, 0) / board.length).toFixed(1) : 0,
    },
    per_match: perMatch,
    most_predicted: teamPulls,
    champion_votes: championVotes,
    branches,
    top10: board.slice(0, 10),
  });
});

// ---------------------------------------------------------------- scoring engine config
r.get('/scoring-config', (_req, res) => res.json(scoringConfig()));

r.post('/scoring-config', (req, res) => {
  if (isCompleted()) {
    return res.status(409).json({ error: 'البطولة مكتملة — تعديل التهيئة يغيّر النقاط التاريخية. أعد فتح البطولة أولاً', tournament_locked: true });
  }
  const cur = scoringConfig();
  const b = req.body || {};
  const intIn = (v, lo, hi) => Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi;

  const next = { ...cur };
  for (const k of ['exact', 'winner', 'draw', 'wrong', 'qualification', 'champion_bonus']) {
    if (b[k] === undefined) continue;
    if (!intIn(b[k], 0, 99)) return res.status(400).json({ error: `قيمة «${k}» غير صحيحة — عدد صحيح 0–99` });
    next[k] = Number(b[k]);
  }
  if (b.joker_multiplier !== undefined) {
    if (!intIn(b.joker_multiplier, 1, 10)) return res.status(400).json({ error: 'مضاعف الجوكر: عدد صحيح 1–10' });
    next.joker_multiplier = Number(b.joker_multiplier);
  }
  const changedStages = [];
  if (b.stage_multipliers) {
    next.stage_multipliers = { ...cur.stage_multipliers };
    for (const st of STAGE_KEYS) {
      if (b.stage_multipliers[st] === undefined) continue;
      if (!intIn(b.stage_multipliers[st], 1, 10)) {
        return res.status(400).json({ error: `مضاعف مرحلة ${st}: عدد صحيح 1–10` });
      }
      const v = Number(b.stage_multipliers[st]);
      if (v !== cur.stage_multipliers[st]) changedStages.push(st);
      next.stage_multipliers[st] = v;
    }
  }

  const LABELS = { exact: 'الدقيقة', winner: 'الفائز', draw: 'التعادل', wrong: 'الخاطئ',
    qualification: 'المتأهل', champion_bonus: 'مكافأة البطل', joker_multiplier: 'مضاعف الجوكر' };
  const diffs = [];
  for (const k of Object.keys(LABELS)) {
    if (next[k] !== cur[k]) diffs.push(`${LABELS[k]}: «${cur[k]}» ← «${next[k]}»`);
  }
  for (const st of changedStages) {
    diffs.push(`مضاعف ${st}: «${cur.stage_multipliers[st]}» ← «${next.stage_multipliers[st]}»`);
  }

  setSetting('scoring', JSON.stringify(next));
  const stageUpd = db.prepare('UPDATE matches SET multiplier = ? WHERE stage = ?');
  for (const st of changedStages) stageUpd.run(next.stage_multipliers[st], st);

  const { board, granted } = recalcAll({ trigger: 'config', actor: req.user.name });
  announceRecalc(req, board, granted);
  if (changedStages.length) broadcast('matches_changed', {});
  audit(req, 'SCORING_CONFIG_UPDATED', 'settings', '', diffs.length ? diffs.join(' · ') : 'بلا تغييرات');
  res.json({ ok: true, players: board.length, changed: diffs.length });
});

// ---------------------------------------------------------------- tournament administration
r.get('/tournament', (_req, res) => res.json(tournamentStatus()));

/** إعادة فتح البطولة — تأكيد نصي صريح إلزامي. */
r.post('/tournament/reopen', (req, res) => {
  if (!isCompleted()) return res.status(400).json({ error: 'البطولة ليست مكتملة' });
  if (String(req.body?.confirm || '') !== 'إعادة فتح') {
    return res.status(400).json({ error: 'أكّد بكتابة «إعادة فتح» حرفياً' });
  }
  reopenTournament(req);
  res.json({ ok: true, status: tournamentStatus() });
});

/** إعادة توليد الفائزين بأمان (حتمي — نفس البيانات = نفس الثلاثي والكؤوس). */
r.post('/tournament/regenerate-winners', (req, res) => {
  if (!isCompleted()) return res.status(400).json({ error: 'يتاح بعد اكتمال البطولة فقط' });
  const w = regenerateWinners();
  audit(req, 'WINNERS_GENERATED', 'tournament', TOURNAMENT,
    `إعادة توليد: 🥇 ${w.trio[0]?.name} · 🥈 ${w.trio[1]?.name ?? '—'} · 🥉 ${w.trio[2]?.name ?? '—'}`);
  if (w.trophyGrants.length) announceRecalc(req, leaderboard(), w.trophyGrants);
  broadcast('hall_updated', { tournament: TOURNAMENT });
  res.json({ ok: true, winners: w.trio.map(t => ({ id: t.id, name: t.name, points: t.points })) });
});

r.get('/settings', (_req, res) => res.json({
  champion_lock_utc: getSetting('champion_lock_utc'),
  scoring: JSON.parse(getSetting('scoring', '{}')),
}));

r.post('/settings', (req, res) => {
  const { champion_lock_utc, scoring } = req.body || {};
  if (champion_lock_utc) setSetting('champion_lock_utc', champion_lock_utc);
  if (scoring) setSetting('scoring', JSON.stringify(scoring));
  audit(req, 'SETTINGS_UPDATED', 'settings', '', JSON.stringify(req.body));
  res.json({ ok: true });
});

export default r;
