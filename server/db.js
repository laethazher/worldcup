import Database from 'libsql';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';

/* ─── قاعدة البيانات: SQLite محلي، أو نسخة متزامنة مع Turso السحابية ───
   إذا ضُبط TURSO_DATABASE_URL نعمل بوضع «النسخة المتزامنة» (embedded replica):
   كل العمليات تجري على ملف SQLite محلي (سريع، وقيود المفاتيح و ON DELETE
   CASCADE تعمل بالكامل)، ثم تُزامَن مع قاعدة Turso الدائمة فلا تُفقد البيانات
   حتى لو أُعيد تشغيل الخادم. بلا هذا المتغير: SQLite محلي عادي (للتطوير). */
const TURSO_URL = process.env.TURSO_DATABASE_URL || '';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || '';
export const USING_TURSO = Boolean(TURSO_URL);

// حماية من النشر بلا تخزين دائم: على Render يجب ضبط Turso، وإلا نوقف برسالة واضحة
// (Render يضبط المتغيّر RENDER تلقائياً). محلياً بلا Turso يبقى العمل عادياً للتطوير.
if (process.env.RENDER && !USING_TURSO) {
  console.error('✗ لم يُضبط TURSO_DATABASE_URL على Render — بدونه تضيع البيانات عند كل إعادة تشغيل. أضِف متغيّري TURSO_DATABASE_URL و TURSO_AUTH_TOKEN ثم أعد النشر. إيقاف.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

// نوم متزامن قصير (لإعادة محاولة الاتصال بلا مكتبات async)
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ok */ } };

export const db = USING_TURSO
  ? new Database(config.dbPath, { syncUrl: TURSO_URL, authToken: TURSO_TOKEN, readYourWrites: true })
  : new Database(config.dbPath);

/* ضمان الحفظ الدائم: نعلّم القاعدة عند أي كتابة (dirty) ونزامنها مع Turso
   بشكل مستمر. syncNow() متزامنة (blocking) فنستدعيها بأمان عند الإغلاق أيضاً. */
let dirty = false;
let syncSuspended = 0;   // >0 يعني معاملة قيد التنفيذ — نُعلّق المزامنة كي لا تكسر المعاملة
export function syncNow() {
  if (!USING_TURSO) return;
  if (syncSuspended > 0) { dirty = true; return; }   // لا تُزامن وسط معاملة مفتوحة، أجّلها
  try { db.sync(); dirty = false; }
  catch (e) { console.error('⚠ فشلت مزامنة Turso:', e.message); }
}

if (USING_TURSO) {
  // سحب أحدث حالة من السحابة قبل أي شيء. الفشل هنا قاتل عمداً: حتى لا نبدأ
  // على قاعدة فارغة ونخاطر بازدواج البيانات — Render سيعيد التشغيل تلقائياً.
  let ok = false;
  for (let i = 1; i <= 5 && !ok; i++) {
    try { db.sync(); ok = true; }
    catch (e) {
      console.error(`⚠ محاولة الاتصال بـ Turso ${i}/5 فشلت: ${e.message}`);
      if (i < 5) sleepSync(1500);
    }
  }
  if (!ok) {
    console.error('✗ تعذّر الاتصال بقاعدة Turso — تحقّق من TURSO_DATABASE_URL و TURSO_AUTH_TOKEN. إيقاف التطبيق.');
    process.exit(1);
  }
  console.log('✓ Turso: تمت المزامنة الأولية (حُمِّلت الحالة من السحابة)');
  // مزامنة دورية للتغييرات غير المحفوظة كل ~1.5 ثانية — خفيفة، ولا تعمل وقت الخمول.
  const timer = setInterval(() => { if (dirty) syncNow(); }, 1500);
  timer.unref();
}

// pragmas على الملف المحلي (تعمل في الوضعين)، محميّة تحسّباً لأي اختلاف في وضع النسخة.
for (const _p of ['journal_mode = WAL', 'foreign_keys = ON', 'busy_timeout = 5000']) {
  try { db.pragma(_p); } catch (e) { console.warn(`تنبيه pragma (${_p}):`, e.message); }
}

/* توأمة سلوك better-sqlite3 + إصلاح توافق تورسو البعيد:
   - libsql 0.5.x يكسر ربط المعاملات المسمّاة (@name) على مسار الكتابة البعيد (Hrana).
     لذا نحوّل كل @name إلى ? ترتيبية عند التحضير، ونعيد ترتيب قيم الكائن حسب ترتيب
     ظهور الأسماء (مع تكرار الاسم المستعمل أكثر من مرة) — يشتغل بنفس النتيجة محلياً وعلى تورسو.
   - إزالة حقل _metadata الذي تضيفه libsql إلى نتائج get()/all() (كي لا يتسرّب لردود الـAPI).
   - تعليم القاعدة "dirty" عند أي كتابة (run/exec) لتُزامن مع Turso. */
{
  const _prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const names = [];
    const psql = sql.replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, n) => { names.push(n); return '?'; });
    const st = _prepare(psql);
    const _get = st.get.bind(st), _all = st.all.bind(st), _run = st.run.bind(st);
    const toArgs = (a) =>
      (names.length && a.length === 1 && a[0] && typeof a[0] === 'object' && !Array.isArray(a[0]))
        ? names.map(n => a[0][n]) : a;
    st.get = (...a) => { const r = _get(...toArgs(a)); if (r && typeof r === 'object') delete r._metadata; return r; };
    st.all = (...a) => { const rs = _all(...toArgs(a)); if (Array.isArray(rs)) for (const r of rs) { if (r && typeof r === 'object') delete r._metadata; } return rs; };
    st.run = (...a) => { const info = _run(...toArgs(a)); dirty = true; return info; };
    return st;
  };
  const _exec = db.exec.bind(db);
  db.exec = (sql) => { const r = _exec(sql); dirty = true; return r; };

  // إصلاح تعطّل الخادم على تورسو (Hrana): "cannot rollback - no transaction is active".
  // في وضع النسخة المتزامنة، لو تخلّل db.sync() معاملةً مفتوحة (BEGIN..COMMIT) تُلغى المعاملة
  // فيفشل COMMIT/ROLLBACK ويسقط الطلب (٥٠٠) وقد يدخل الخادم حلقة إعادة تشغيل (٥٠٢).
  // الحل: تغليف db.transaction لتعليق المزامنة طوال المعاملة ثم استئنافها ومزامنة ما تراكم.
  if (typeof db.transaction === 'function') {
    const _transaction = db.transaction.bind(db);
    db.transaction = (fn) => {
      const wrapped = _transaction(fn);
      return (...args) => {
        syncSuspended++;
        try { return wrapped(...args); }
        finally { syncSuspended = Math.max(0, syncSuspended - 1); if (dirty) syncNow(); }
      };
    };
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  department TEXT DEFAULT '',
  branch_id INTEGER REFERENCES branches(id),
  role TEXT NOT NULL DEFAULT 'employee' CHECK(role IN ('employee','admin')),
  photo_url TEXT DEFAULT '',
  champion_team TEXT DEFAULT NULL,
  champion_at TEXT DEFAULT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS teams (
  code TEXT PRIMARY KEY,
  name_ar TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_no INTEGER NOT NULL,               -- FIFA match number (97..104)
  stage TEXT NOT NULL,                     -- QF | SF | BRONZE | FINAL
  stage_ar TEXT NOT NULL,
  home_team TEXT REFERENCES teams(code),
  away_team TEXT REFERENCES teams(code),
  placeholder_home TEXT DEFAULT '',
  placeholder_away TEXT DEFAULT '',
  kickoff_utc TEXT NOT NULL,
  multiplier INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','finished')),
  home_score INTEGER DEFAULT NULL,
  away_score INTEGER DEFAULT NULL,
  advancing_team TEXT DEFAULT NULL,        -- who qualified / won (after pens if needed)
  finished_at TEXT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  home_score INTEGER NOT NULL,
  away_score INTEGER NOT NULL,
  penalty_winner TEXT DEFAULT NULL,        -- team code, required when draw predicted
  points_base INTEGER DEFAULT NULL,
  points_qual INTEGER DEFAULT NULL,
  points_total INTEGER DEFAULT NULL,
  is_exact INTEGER DEFAULT NULL,
  is_direction INTEGER DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(employee_id, match_id)
);

CREATE TABLE IF NOT EXISTS achievements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  awarded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(employee_id, code)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,
  actor_name TEXT,
  action TEXT NOT NULL,
  entity TEXT DEFAULT '',
  entity_id TEXT DEFAULT '',
  details TEXT DEFAULT '',
  ip TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS notification_reads (
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  PRIMARY KEY (employee_id, notification_id)
);

CREATE TABLE IF NOT EXISTS rank_snapshots (
  employee_id INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pred_match ON predictions(match_id);
CREATE INDEX IF NOT EXISTS idx_pred_emp ON predictions(employee_id);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(created_at DESC);
`);

/* ─── الهجرة: فرادة أسماء الموظفين (قيد على مستوى قاعدة البيانات) ───
   قواعد قديمة فيها أسماء مكررة: تتوقف الهجرة ويُطبع تقرير بالسجلات
   المتعارضة حرفياً — لا يُعدَّل أي سجل تلقائياً ولا يُنشأ القيد. */
// تطبيع الاسم داخل SQL: قص الأطراف + طي أي سلسلة فراغات داخلية إلى فراغ واحد
// (خمسة REPLACE متداخلة تغطي سلاسل حتى ~64 فراغاً — أبعد من أي حالة واقعية)
export const NAME_NORM = (col) =>
  `TRIM(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${col},'  ',' '),'  ',' '),'  ',' '),'  ',' '),'  ',' '))`;

function migrateUniqueEmployeeNames() {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_emp_name_unique'").get();
  if (row && row.sql.includes('REPLACE')) return; // النسخة المقوّاة موجودة

  const dups = db.prepare(`
    SELECT ${NAME_NORM('name')} AS n, COUNT(*) AS c,
           GROUP_CONCAT('[' || id || ':' || username || ']', ' · ') AS recs
    FROM employees
    GROUP BY ${NAME_NORM('name')} COLLATE NOCASE
    HAVING c > 1`).all();

  if (dups.length) {
    const lines = dups.map(d => `   الاسم «${d.n}» مكرر ${d.c} مرات → ${d.recs}`);
    console.error([
      '',
      '✗ توقفت هجرة قاعدة البيانات: توجد أسماء موظفين مكررة — لن يُعدَّل أي سجل تلقائياً.',
      ...lines,
      '',
      '   الحل: عدّل الأسماء المتعارضة أعلاه ثم أعد التشغيل. مثال:',
      `   sqlite3 ${config.dbPath} "UPDATE employees SET name='الاسم الجديد' WHERE id=<id>;"`,
      '',
    ].join('\n'));
    process.exit(1);
  }

  if (row) db.exec('DROP INDEX idx_emp_name_unique'); // ترقية النسخة الأولى بمكانها
  db.exec(`CREATE UNIQUE INDEX idx_emp_name_unique ON employees(${NAME_NORM('name')} COLLATE NOCASE)`);
}
migrateUniqueEmployeeNames();

/* ─── هجرة 3.1: عمود الهاتف (فريد لغير الفارغ) + آخر تسجيل دخول ───
   - ALTER ADD COLUMN لا يمس أي بيانات موجودة.
   - الفهرس جزئي: NULL/الفارغ مسموح بالتعدد → الحسابات القديمة بلا هاتف
     تستمر بالعمل كما هي. أي رقم مُدخل يجب أن يكون فريداً.
   - لو وُجد عمود هاتف قديم فيه تكرارات: توقف + تقرير، صفر تعديل صامت. */
function migrateAccounts31() {
  const cols = db.prepare('PRAGMA table_info(employees)').all().map(c => c.name);
  if (!cols.includes('phone')) db.exec('ALTER TABLE employees ADD COLUMN phone TEXT');
  if (!cols.includes('last_login_at')) db.exec('ALTER TABLE employees ADD COLUMN last_login_at TEXT');

  const idx = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_emp_phone_unique'").get();
  if (idx) return;

  const dups = db.prepare(`
    SELECT phone AS n, COUNT(*) AS c,
           GROUP_CONCAT('[' || id || ':' || username || ']', ' · ') AS recs
    FROM employees
    WHERE phone IS NOT NULL AND TRIM(phone) != ''
    GROUP BY phone
    HAVING c > 1`).all();

  if (dups.length) {
    const lines = dups.map(d => `   الرقم «${d.n}» مكرر ${d.c} مرات → ${d.recs}`);
    console.error(['',
      '✗ توقفت هجرة قاعدة البيانات: أرقام هواتف مكررة — لن يُعدَّل أي سجل تلقائياً.',
      ...lines, '',
      `   الحل: صحّح الأرقام أعلاه ثم أعد التشغيل.`, ''].join('\n'));
    process.exit(1);
  }

  db.exec(`CREATE UNIQUE INDEX idx_emp_phone_unique ON employees(phone)
           WHERE phone IS NOT NULL AND phone != ''`);
}
migrateAccounts31();

/* ─── هجرة 3.2: عداد مرات الدخول + نسخة الجلسات (لإبطالها عند تغيير كلمة المرور) ─── */
function migrateAccounts32() {
  const cols = db.prepare('PRAGMA table_info(employees)').all().map(c => c.name);
  if (!cols.includes('login_count')) db.exec('ALTER TABLE employees ADD COLUMN login_count INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('token_version')) db.exec('ALTER TABLE employees ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0');
}
migrateAccounts32();

/* ─── هجرة 3.4: الفروع والأقسام ككيانات حقيقية ───
   - branches.active (إيقاف/تفعيل).
   - departments: كيان مرتبط بفرع، فريد داخل فرعه (تطبيع كامل بالفهرس).
   - employees.department_id (FK, ON DELETE SET NULL) — والعمود النصي القديم
     يبقى كمرآة متزامنة: صفر كسر لأي ميزة قائمة، وصفر فقدان بيانات.
   - backfill يعمل مع كل إقلاع (idempotent): أي موظف بنص قسم بلا رابط يُربط. */
function migrateOrgs34() {
  const bcols = db.prepare('PRAGMA table_info(branches)').all().map(c => c.name);
  if (!bcols.includes('active')) db.exec('ALTER TABLE branches ADD COLUMN active INTEGER NOT NULL DEFAULT 1');

  db.exec(`CREATE TABLE IF NOT EXISTS departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);

  const ecols = db.prepare('PRAGMA table_info(employees)').all().map(c => c.name);
  if (!ecols.includes('department_id')) {
    db.exec('ALTER TABLE employees ADD COLUMN department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL');
  }

  // فرادة اسم الفرع بالتطبيع الكامل (فوق UNIQUE الحرفي القديم) — توقف+تقرير لو تعارض قديم
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_branch_name_unique'").get()) {
    const dups = db.prepare(`
      SELECT ${NAME_NORM('name')} n, COUNT(*) c, GROUP_CONCAT('[' || id || ':' || name || ']', ' · ') recs
      FROM branches GROUP BY ${NAME_NORM('name')} COLLATE NOCASE HAVING c > 1`).all();
    if (dups.length) {
      console.error(['', '✗ توقفت الهجرة: أسماء فروع متطابقة بعد التطبيع — لن يُعدَّل شيء تلقائياً.',
        ...dups.map(d => `   «${d.n}» → ${d.recs}`), ''].join('\n'));
      process.exit(1);
    }
    db.exec(`CREATE UNIQUE INDEX idx_branch_name_unique ON branches(${NAME_NORM('name')} COLLATE NOCASE)`);
  }
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_dept_unique'").get()) {
    db.exec(`CREATE UNIQUE INDEX idx_dept_unique ON departments(branch_id, ${NAME_NORM('name')} COLLATE NOCASE)`);
  }
  backfillDepartments();
}

/** ربط أي موظف عنده نص قسم + فرع لكن بلا department_id — يعمل بكل إقلاع. */
export function backfillDepartments() {
  const rows = db.prepare(`
    SELECT id, branch_id, TRIM(department) dept FROM employees
    WHERE department_id IS NULL AND branch_id IS NOT NULL AND TRIM(IFNULL(department,'')) != ''`).all();
  const find = db.prepare(`SELECT id, name FROM departments
    WHERE branch_id = ? AND ${NAME_NORM('name')} = ${NAME_NORM('?')} COLLATE NOCASE`);
  const ins = db.prepare('INSERT INTO departments(branch_id, name) VALUES(?, ?)');
  const link = db.prepare('UPDATE employees SET department_id = ?, department = ? WHERE id = ?');
  for (const r of rows) {
    let d = find.get(r.branch_id, r.dept);
    if (!d) d = { id: ins.run(r.branch_id, r.dept).lastInsertRowid, name: r.dept };
    link.run(d.id, d.name, r.id);
  }
  return rows.length;
}
migrateOrgs34();

/* ─── هجرة 3.5: إثراء سجل التدقيق ───
   أعمدة جديدة كلها NULLABLE بلا DEFAULT: السجلات التاريخية لا تُمس ولا
   تُعاد كتابتها — الحقول غير الملتقطة سابقاً تبقى فارغة بصدق.
   + قفل قراءة-فقط بمستوى القاعدة: أي UPDATE/DELETE على audit_logs يُرفض. */
function migrateAudit35() {
  const cols = db.prepare('PRAGMA table_info(audit_logs)').all().map(c => c.name);
  for (const [col, ddl] of [
    ['actor_username', 'actor_username TEXT'],
    ['actor_role', 'actor_role TEXT'],
    ['actor_branch', 'actor_branch TEXT'],
    ['user_agent', 'user_agent TEXT'],
    ['result', 'result TEXT'],
  ]) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE audit_logs ADD COLUMN ${ddl}`);
  }
  const trg = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('audit_no_update','audit_no_delete')").all().map(t => t.name);
  if (!trg.includes('audit_no_update')) {
    db.exec(`CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_logs
             BEGIN SELECT RAISE(ABORT, 'سجل التدقيق للقراءة فقط'); END`);
  }
  if (!trg.includes('audit_no_delete')) {
    db.exec(`CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_logs
             BEGIN SELECT RAISE(ABORT, 'سجل التدقيق للقراءة فقط'); END`);
  }
}
migrateAudit35();

/* ─── هجرة 3.6: مركز الإشعارات ───
   القيم الافتراضية للسجلات القديمة صادقة تاريخياً: كانت إشعارات إدارية
   عامة بأولوية عادية (type=admin, target=all, priority=normal) — لا يُعاد
   كتابة أي صف. الحذف من طرف الموظف = إخفاء شخصي (الصف يبقى للأرشيف الإداري). */
function migrateNotifications36() {
  const cols = db.prepare('PRAGMA table_info(notifications)').all().map(c => c.name);
  for (const [col, ddl] of [
    ['type', "type TEXT NOT NULL DEFAULT 'admin'"],
    ['priority', "priority TEXT NOT NULL DEFAULT 'normal'"],
    ['sender_id', 'sender_id INTEGER'],
    ['sender_name', 'sender_name TEXT'],
    ['target_type', "target_type TEXT NOT NULL DEFAULT 'all'"],
    ['target_id', 'target_id TEXT'],
  ]) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE notifications ADD COLUMN ${ddl}`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS notification_hidden (
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    PRIMARY KEY (employee_id, notification_id)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_notif_target ON notifications(target_type, target_id)');
}
migrateNotifications36();

/* ─── هجرة 3.7: تاريخ الاحتساب الكامل ───
   طوابع لكل توقع (سبب/مضاعف/تفصيل JSON) تُكتب مع كل احتساب — والسجلات
   القديمة NULL حتى أول إعادة احتساب (ذاتية التعبئة). scoring_runs سجل
   إلحاقي لكل تشغيل للمحرك (المحفّز/اللاعبون/المجموع/المنفّذ). */
function migrateScoring37() {
  const cols = db.prepare('PRAGMA table_info(predictions)').all().map(c => c.name);
  for (const [col, ddl] of [
    ['calc_multiplier', 'calc_multiplier REAL'],
    ['calc_reason', 'calc_reason TEXT'],
    ['calc_breakdown', 'calc_breakdown TEXT'],
  ]) if (!cols.includes(col)) db.exec(`ALTER TABLE predictions ADD COLUMN ${ddl}`);

  db.exec(`CREATE TABLE IF NOT EXISTS scoring_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    trigger_type TEXT NOT NULL,
    match_id INTEGER,
    players INTEGER NOT NULL,
    total_points INTEGER NOT NULL,
    granted INTEGER NOT NULL DEFAULT 0,
    actor_name TEXT
  )`);
}
migrateScoring37();

/* ─── هجرة 3.10: قاعة المجد ───
   لقطة دائمة لحظة اكتمال البطولة — مستقلة عن أي تعديل لاحق على الموظفين.
   الصف يُستبدل بمفتاح البطولة عند إعادة التوليد (حتمي: نفس البيانات = نفس الصف). */
function migrateHall310() {
  db.exec(`CREATE TABLE IF NOT EXISTS hall_of_fame (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament TEXT NOT NULL UNIQUE,
    completed_at TEXT NOT NULL,
    champion_id INTEGER, champion_name TEXT NOT NULL, champion_branch TEXT, champion_department TEXT,
    champion_points INTEGER NOT NULL, champion_accuracy INTEGER NOT NULL, champion_exact INTEGER NOT NULL,
    runner_id INTEGER, runner_name TEXT, runner_branch TEXT, runner_department TEXT,
    runner_points INTEGER, runner_accuracy INTEGER, runner_exact INTEGER,
    third_id INTEGER, third_name TEXT, third_branch TEXT, third_department TEXT,
    third_points INTEGER, third_accuracy INTEGER, third_exact INTEGER,
    winning_branch TEXT, winning_department TEXT
  )`);
}
migrateHall310();

/* ─── صيانة معزولة (v1.0.1): تدوير بيانات حساب الإدارة الافتراضي ───
   إن وُجد حساب إدارة باسم المستخدم القديم 'admin' (قواعد إنتاج قائمة):
   يُحدَّث حقلان فقط — username و password_hash (بنفس آلية scrypt حرفياً؛
   منسوخة هنا عمداً لتفادي دوران استيراد db↔auth). كل شيء آخر يبقى كما هو:
   id، الدور، token_version، إحصاءات الدخول، التدقيق، الإشعارات، وكل الـFKs.
   idempotent: بعد أول تنفيذ لا يوجد 'admin' فلا يُمس شيء بأي إقلاع لاحق.
   تعارض الاسم الهدف مع موظف آخر → توقف وتقرير، صفر تعديل صامت. */
function migrateDefaultAdminCreds() {
  const oldAdmin = db.prepare(`SELECT id FROM employees WHERE username = 'admin' AND role = 'admin'`).get();
  if (!oldAdmin) return;
  const clash = db.prepare(`SELECT id, name FROM employees WHERE username = 'laethalkawaz' AND id != ?`).get(oldAdmin.id);
  if (clash) {
    console.error(['',
      '✗ توقفت هجرة تدوير حساب الإدارة: اسم المستخدم الهدف «laethalkawaz» محجوز',
      `   لموظف آخر [${clash.id}:${clash.name}] — عالج التعارض يدوياً ثم أعد التشغيل.`, ''].join('\n'));
    process.exit(1);
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync('laethalkawaz', salt, 64).toString('hex'); // نفس auth.hashPassword حرفياً
  db.prepare(`UPDATE employees SET username = 'laethalkawaz', password_hash = ? WHERE id = ?`)
    .run(`${salt}:${hash}`, oldAdmin.id);
  console.log('✓ هجرة الصيانة: حساب الإدارة الافتراضي → laethalkawaz (نفس id وكل السجلات محفوظة)');
}
migrateDefaultAdminCreds();

// دفع الهيكل/الهجرات إلى Turso مرة واحدة عند الإقلاع (لا يؤثر في الوضع المحلي).
syncNow();

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}

export const nowISO = () => new Date().toISOString();