import { db, getSetting } from './db.js';

/** التهيئة الكاملة — متوافقة رجعياً مع صيغة {direction} القديمة (تنشطر إلى فوز/تعادل). */
export function scoringConfig() {
  const raw = JSON.parse(getSetting('scoring', '{}'));
  const legacyDir = raw.direction ?? 2;
  return {
    exact: raw.exact ?? 5,
    winner: raw.winner ?? legacyDir,   // الاتجاه الصحيح (فائز أو تعادل) — حالة واحدة
    wrong: raw.wrong ?? 0,
    qualification: raw.qualification ?? 2,
    champion_bonus: raw.champion_bonus ?? 10,
  };
}
const RULES = scoringConfig;

const sign = (a, b) => Math.sign(a - b); // 1 home, 0 draw, -1 away

export function predictedAdvancer(pred, match) {
  if (pred.home_score > pred.away_score) return match.home_team;
  if (pred.away_score > pred.home_score) return match.away_team;
  return pred.penalty_winner || null;
}

/** Score every prediction of one finished match. */
export function scoreMatch(matchId) {
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
  if (!m || m.status !== 'finished') return;
  const R = RULES();
  const preds = db.prepare('SELECT id, home_score, away_score, penalty_winner FROM predictions WHERE match_id = ?').all(matchId);
  if (!preds.length) return;

  // النقاط ٥ / ٢ / ٠ فقط — بلا نقاط «متأهل» منفصلة.
  const matchIsDraw = m.home_score === m.away_score; // انتهت بالتعادل ⇒ حُسمت بركلات الترجيح
  const rows = [];
  for (const p of preds) {
    let base, kind, isExact, isDir;

    if (!matchIsDraw) {
      // مباراة لها فائز: النتيجة بالضبط=٥ ، الفائز صح والنتيجة غلط=٢ ، غير ذلك=٠
      const exactScore = p.home_score === m.home_score && p.away_score === m.away_score;
      const winnerOk   = sign(p.home_score, p.away_score) === sign(m.home_score, m.away_score);
      if (exactScore)    { base = R.exact;  kind = 'توقع دقيق'; isExact = 1; isDir = 1; }
      else if (winnerOk) { base = R.winner; kind = 'فائز صحيح'; isExact = 0; isDir = 1; }
      else               { base = R.wrong;  kind = 'توقع خاطئ'; isExact = 0; isDir = 0; }
    } else {
      // انتهت بالتعادل: عدد أهداف التعادل لا يفرق — المهم توقّع «تعادل» + الفائز بالركلات.
      // تعادل + ترجيح صح=٥ (يُعتبر دقيق) ، تعادل + ترجيح غلط=٢ ، توقّع فوز=٠
      const predictedDraw = p.home_score === p.away_score;
      const penaltyOk = predictedDraw && !!p.penalty_winner && p.penalty_winner === m.advancing_team;
      if (penaltyOk)          { base = R.exact;  kind = 'توقع دقيق (تعادل + الفائز بالركلات)'; isExact = 1; isDir = 1; }
      else if (predictedDraw) { base = R.winner; kind = 'تعادل صحيح'; isExact = 0; isDir = 1; }
      else                    { base = R.wrong;  kind = 'توقع خاطئ'; isExact = 0; isDir = 0; }
    }
    rows.push({ id: p.id, base, ex: isExact, dir: isDir, kind, brk: JSON.stringify({ kind, base, total: base }) });
  }

  // كتابة دفعة واحدة بدل UPDATE صف-صف: نُجهّز الحسابات في جدول مؤقت محلي (سريع، بلا شبكة)،
  // ثم نحدّث كل توقعات المباراة بكتابة واحدة عن بُعد (UPDATE...FROM) — نفس النتائج تماماً.
  db.exec('CREATE TEMP TABLE IF NOT EXISTS _score_tmp(id INTEGER PRIMARY KEY, base INT, ex INT, dir INT, reason TEXT, brk TEXT)');
  db.prepare('DELETE FROM _score_tmp').run();
  const CHUNK = 150;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const ph = slice.map(() => '(?,?,?,?,?,?)').join(',');
    const params = [];
    for (const r of slice) { params.push(r.id, r.base, r.ex, r.dir, r.kind, r.brk); }
    db.prepare(`INSERT INTO _score_tmp(id,base,ex,dir,reason,brk) VALUES ${ph}`).run(...params);
  }
  db.prepare(`UPDATE predictions SET
      points_base = _score_tmp.base, points_qual = 0, points_total = _score_tmp.base,
      is_exact = _score_tmp.ex, is_direction = _score_tmp.dir, calc_multiplier = 1,
      calc_reason = _score_tmp.reason, calc_breakdown = _score_tmp.brk
      FROM _score_tmp WHERE _score_tmp.id = predictions.id`).run();
}

/** Full recalculation: all finished matches → achievements → rank snapshot. Returns { board, granted }.
 *  كل الكتابات داخل معاملة واحدة: ذرية (تكتمل كلها أو تتراجع كلها — لا حالة نصفية عند أي فشل)،
 *  ومزامنة تورسو تحصل مرة واحدة بعدها بدل عشرات المرات. */
export function recalcAll(ctx = {}) {
  let board, granted;
  db.transaction(() => {
    db.prepare(`UPDATE predictions SET points_base=NULL, points_qual=NULL, points_total=NULL,
                is_exact=NULL, is_direction=NULL, calc_multiplier=NULL, calc_reason=NULL, calc_breakdown=NULL`).run();
    const finished = db.prepare(`SELECT id FROM matches WHERE status='finished' ORDER BY kickoff_utc`).all();
    for (const m of finished) scoreMatch(m.id);
    granted = computeAchievements();
    board = leaderboard();
    snapshotRanks(board);
    db.prepare(`INSERT INTO scoring_runs(trigger_type, match_id, players, total_points, granted, actor_name)
                VALUES(?,?,?,?,?,?)`)
      .run(ctx.trigger || 'manual', ctx.match_id ?? null, board.length,
           board.reduce((a, r) => a + r.points, 0), granted.length, ctx.actor ?? null);
  })();
  return { board, granted };
}

export function championWinner() {
  const final = db.prepare(`SELECT * FROM matches WHERE stage='FINAL' AND status='finished'`).get();
  return final?.advancing_team ?? null;
}

/** Leaderboard with tie-breakers: total ↓, exact ↓, earliest first prediction ↑ */
export function leaderboard(opts = {}) {
  const R = RULES();
  const champ = championWinner();
  const rows = db.prepare(`
    SELECT e.id, e.name, e.username, e.department, e.photo_url, e.champion_team,
           b.name AS branch,
           COALESCE(SUM(p.points_total), 0) AS points,
           COALESCE(SUM(p.is_exact), 0) AS exact_count,
           COALESCE(SUM(p.is_direction), 0) AS direction_count,
           COUNT(p.points_total) AS scored_count,
           MIN(p.created_at) AS first_pred_at
    FROM employees e
    LEFT JOIN branches b ON b.id = e.branch_id
    LEFT JOIN predictions p ON p.employee_id = e.id
    WHERE e.active = 1 AND e.role = COALESCE(?, e.role) AND (? IS NOT NULL OR e.role != 'admin')
    GROUP BY e.id
  `).all(opts.role ?? null, opts.role ?? null);

  // خرائط مجمّعة بدل استعلامين لكل موظف (نفس النتائج تماماً، لكن ~٢ استعلام بدل ٢×عدد الموظفين)
  const streakMap = currentStreakAll();
  const achMap = new Map();
  for (const a of db.prepare('SELECT employee_id, code FROM achievements').all()) {
    let arr = achMap.get(a.employee_id);
    if (!arr) { arr = []; achMap.set(a.employee_id, arr); }
    arr.push(a.code);
  }

  for (const r of rows) {
    r.champion_bonus = (champ && r.champion_team === champ) ? R.champion_bonus : 0;
    r.points += r.champion_bonus;
    r.accuracy = r.scored_count ? Math.round((r.direction_count / r.scored_count) * 100) : 0;
    r.streak = streakMap.get(r.id) ?? 0;
  }

  rows.sort((a, b) =>
    b.points - a.points ||
    b.exact_count - a.exact_count ||
    String(a.first_pred_at || '9').localeCompare(String(b.first_pred_at || '9')) ||
    a.id - b.id // كاسر تعادل مطلق: ترتيب حتمي مستقر مهما تطابق كل شيء
  );

  const prev = new Map(db.prepare('SELECT employee_id, rank FROM rank_snapshots').all().map(r => [r.employee_id, r.rank]));
  rows.forEach((r, i) => {
    r.rank = i + 1;
    const was = prev.get(r.id);
    r.prev_rank = was ?? null;
    r.delta = was ? was - r.rank : 0;
    r.achievements = achMap.get(r.id) ?? [];
  });
  return rows;
}

/** أطول-متتالية حالية لكل الموظفين دفعة واحدة — نفس منطق currentStreak بالضبط، باستعلام واحد. */
function currentStreakAll() {
  const map = new Map();
  let curEmp = null, streak = 0, counting = true;
  for (const r of db.prepare(`
    SELECT p.employee_id AS id, p.is_direction AS d
    FROM predictions p JOIN matches mm ON mm.id = p.match_id
    WHERE mm.status='finished'
    ORDER BY p.employee_id, mm.kickoff_utc DESC`).all()) {
    if (r.id !== curEmp) { if (curEmp !== null) map.set(curEmp, streak); curEmp = r.id; streak = 0; counting = true; }
    if (counting) { if (r.d) streak++; else counting = false; }
  }
  if (curEmp !== null) map.set(curEmp, streak);
  return map;
}

function currentStreak(empId) {
  const seq = db.prepare(`
    SELECT p.is_direction FROM predictions p
    JOIN matches m ON m.id = p.match_id
    WHERE p.employee_id = ? AND m.status='finished'
    ORDER BY m.kickoff_utc DESC`).all(empId);
  let s = 0;
  for (const r of seq) { if (r.is_direction) s++; else break; }
  return s;
}

/** لوحة الأقسام: نفس اشتقاق الفروع — التجميع بالقسم داخل فرعه. */
export function departmentLeaderboard() {
  const board = leaderboard();
  const map = new Map();
  for (const r of board) {
    const key = r.department ? `${r.department} — ${r.branch || 'بدون فرع'}` : 'بدون قسم';
    if (!map.has(key)) map.set(key, { label: key, department: r.department || null, branch: r.branch || null, points: 0, members: 0, exact: 0 });
    const d = map.get(key);
    d.points += r.points; d.members++; d.exact += r.exact_count;
  }
  const arr = [...map.values()].map(d => ({ ...d, avg: d.members ? +(d.points / d.members).toFixed(1) : 0 }));
  arr.sort((a, b) => b.avg - a.avg || b.points - a.points || a.label.localeCompare(b.label, 'ar'));
  arr.forEach((d, i) => d.rank = i + 1);
  return arr;
}

export function branchLeaderboard() {
  const board = leaderboard();
  const map = new Map();
  for (const r of board) {
    const key = r.branch || 'بدون فرع';
    if (!map.has(key)) map.set(key, { branch: key, points: 0, members: 0, exact: 0 });
    const b = map.get(key);
    b.points += r.points; b.members++; b.exact += r.exact_count;
  }
  const arr = [...map.values()].map(b => ({ ...b, avg: b.members ? +(b.points / b.members).toFixed(1) : 0 }));
  arr.sort((a, b) => b.avg - a.avg || b.points - a.points);
  arr.forEach((b, i) => b.rank = i + 1);
  return arr;
}

function snapshotRanks(board) {
  // recalcAll يلفّ العملية كلها بمعاملة واحدة، فنكتب مباشرة بلا معاملة داخلية (نتجنّب التداخل).
  // إدراج دفعة واحدة (multi-row) بدل صف-صف: نفس البيانات بالضبط، لكن كتابة واحدة بدل ~عدد الموظفين
  // (يقلّل زمن حجب حلقة الأحداث أثناء إعادة الاحتساب). نُقسّم تحسّباً لحد متغيّرات SQLite.
  db.prepare('DELETE FROM rank_snapshots').run();
  const CHUNK = 400;
  for (let i = 0; i < board.length; i += CHUNK) {
    const slice = board.slice(i, i + CHUNK);
    const ph = slice.map(() => '(?,?)').join(',');
    const params = [];
    for (const r of slice) { params.push(r.id, r.rank); }
    db.prepare(`INSERT INTO rank_snapshots(employee_id, rank) VALUES ${ph}`).run(...params);
  }
}

// ------------------------------------------------------------------ achievements
/** كتالوج الإنجازات: الأكواد السبعة الأصلية محفوظة كما هي + ١١ جديداً.
    metric/target → إنجازات قائمة على التقدم؛ hidden → لا تظهر قبل فتحها. */
const AWARDS = {
  // توقعات
  PERFECT:    { name: 'توقع مثالي',     desc: 'نتيجة دقيقة ١٠٠٪',                icon: '🎯', category: 'prediction',    rarity: 'rare',      metric: 'exact', target: 1 },
  SNIPER:     { name: 'القنّاص',        desc: 'نتيجتان دقيقتان أو أكثر',          icon: '🏹', category: 'prediction',    rarity: 'epic',      metric: 'exact', target: 2 },
  SNIPER5:    { name: 'عين الصقر',      desc: '٥ نتائج دقيقة في البطولة',         icon: '💥', category: 'prediction',    rarity: 'legendary', metric: 'exact', target: 5 },
  GHOST_DRAW: { name: 'شبح التعادل',    desc: 'توقع دقيق لمباراة انتهت بالتعادل', icon: '👻', category: 'prediction',    rarity: 'rare',      hidden: true },
  // سلاسل
  STREAK3:    { name: 'سلسلة ساخنة',    desc: '٣ توقعات صحيحة متتالية',           icon: '🔥', category: 'streak',        rarity: 'rare',      metric: 'streak', target: 3 },
  STREAK5:    { name: 'لهيب لا يهدأ',   desc: '٥ توقعات صحيحة متتالية',           icon: '🌋', category: 'streak',        rarity: 'epic',      metric: 'streak', target: 5 },
  // دقة
  EXPERT:     { name: 'خبير كرة القدم', desc: 'دقة ٧٠٪ فأكثر (٤ مباريات محتسبة على الأقل)', icon: '🦅', category: 'accuracy', rarity: 'epic', metric: 'accuracy', target: 70 },
  // مشاركة
  FIRST_PRED: { name: 'أول خطوة',       desc: 'سجّلت أول توقع لك',                icon: '⚽', category: 'participation', rarity: 'common',    metric: 'n_all', target: 1 },
  PART5:      { name: 'حاضر دائماً',    desc: '٥ توقعات مسجّلة',                  icon: '🗓', category: 'participation', rarity: 'common',    metric: 'n_all', target: 5 },
  ALL_QF:     { name: 'ربع كامل',       desc: 'توقعت مباريات ربع النهائي الأربع', icon: '🧩', category: 'participation', rarity: 'rare',      metric: 'qf', target: 4 },
  // محطات
  PTS10:      { name: 'انطلاقة',        desc: '١٠ نقاط توقعات',                   icon: '🎖', category: 'milestone',     rarity: 'common',    metric: 'points', target: 10 },
  PTS25:      { name: 'صاعد بقوة',      desc: '٢٥ نقطة توقعات',                   icon: '🏵', category: 'milestone',     rarity: 'rare',      metric: 'points', target: 25 },
  PTS50:      { name: 'نصف المئوية',    desc: '٥٠ نقطة توقعات',                   icon: '💠', category: 'milestone',     rarity: 'epic',      metric: 'points', target: 50 },
  COMEBACK:   { name: 'العنقاء',        desc: 'قفزت ٣ مراكز أو أكثر دفعة واحدة',  icon: '🐦‍🔥', category: 'milestone',   rarity: 'epic',      hidden: true },
  // البطولة
  QUAL3:      { name: 'بوصلة التأهل',   desc: '٣ توقعات متأهل صحيحة',             icon: '🧭', category: 'tournament',    rarity: 'rare',      metric: 'quals', target: 3 },
  GOLD_TROPHY:   { name: 'كأس البطولة',   desc: 'بطل تحدي كأس العالم — المركز الأول', icon: '🏆', category: 'tournament', rarity: 'legendary' },
  SILVER_TROPHY: { name: 'الكأس الفضية',  desc: 'وصافة التحدي — المركز الثاني',        icon: '🥈', category: 'tournament', rarity: 'epic' },
  BRONZE_TROPHY: { name: 'الكأس البرونزية', desc: 'برونزية التحدي — المركز الثالث',    icon: '🥉', category: 'tournament', rarity: 'rare' },
  CHAMPION:   { name: 'عرّاف البطل',    desc: 'توقع بطل كأس العالم',              icon: '🔮', category: 'tournament',    rarity: 'legendary' },
  LEGEND:     { name: 'الأسطورة',       desc: 'المركز الأول في التحدي',           icon: '👑', category: 'tournament',    rarity: 'legendary' },
};
export const CATEGORY_LABELS = {
  prediction: 'التوقعات', streak: 'السلاسل', accuracy: 'الدقة',
  participation: 'المشاركة', milestone: 'المحطات', tournament: 'البطولة',
};
export const AWARD_META = AWARDS;

function grant(empId, code, granted) {
  const r = db.prepare('INSERT OR IGNORE INTO achievements(employee_id, code) VALUES(?,?)').run(empId, code);
  if (r.changes) granted.push({ employee_id: empId, code });
}

/** إحصاءات إنجازات موظف — مصدر واحد للحساب ولأشرطة التقدم. */
export function achStats(empId) {
  const s = db.prepare(`
    SELECT COALESCE(SUM(is_exact),0) exact,
           COALESCE(SUM(is_direction),0) dir,
           COUNT(points_total) scored,
           COUNT(*) n_all,
           COALESCE(SUM(points_total),0) points,
           COALESCE(SUM(CASE WHEN points_qual>0 THEN 1 ELSE 0 END),0) quals
    FROM predictions WHERE employee_id=?`).get(empId);
  s.qf = db.prepare(`SELECT COUNT(*) c FROM predictions p JOIN matches m ON m.id=p.match_id
                     WHERE p.employee_id=? AND m.stage='QF'`).get(empId).c;
  s.ghost = db.prepare(`SELECT COUNT(*) c FROM predictions p JOIN matches m ON m.id=p.match_id
                        WHERE p.employee_id=? AND p.is_exact=1 AND m.home_score=m.away_score
                        AND m.status='finished'`).get(empId).c;
  s.streak = maxStreak(empId);
  s.accuracy = s.scored ? Math.round((s.dir / s.scored) * 100) : 0;
  return s;
}

export function computeAchievements() {
  const granted = [];
  const champ = championWinner();
  const finalDone = !!champ;
  const emps = db.prepare(`SELECT id, champion_team FROM employees WHERE active=1 AND role!='admin'`).all();

  // ترتيب خفيف حالي مقابل اللقطة السابقة — لإنجاز «العنقاء» الخفي
  const light = db.prepare(`
    SELECT e.id, COALESCE(SUM(p.points_total),0) pts, COALESCE(SUM(p.is_exact),0) ex, MIN(p.created_at) f
    FROM employees e LEFT JOIN predictions p ON p.employee_id=e.id
    WHERE e.active=1 AND e.role!='admin' GROUP BY e.id
    ORDER BY pts DESC, ex DESC, f ASC, e.id ASC`).all();
  const curRank = new Map(light.map((r, i) => [r.id, i + 1]));
  const prevRank = new Map(db.prepare('SELECT employee_id, rank FROM rank_snapshots').all().map(r => [r.employee_id, r.rank]));

  // إحصاءات كل الموظفين دفعة واحدة (بدل achStats لكل موظف) — قيم مطابقة تماماً
  const stats = bulkStats();
  const EMPTY = { exact:0, dir:0, scored:0, n_all:0, points:0, quals:0, qf:0, ghost:0, streak:0, accuracy:0 };
  // الإنجازات الممنوحة سابقاً: نتجنّب آلاف محاولات الإدراج الفارغة، ونمنح الجديد فقط (نفس النتيجة)
  const have = new Set(db.prepare('SELECT employee_id, code FROM achievements').all().map(r => r.employee_id + '|' + r.code));
  // نجمع المنح الجديدة فقط (نفس الحُرّاس)، ونُدرجها دفعة واحدة في النهاية — بدل INSERT لكل منح.
  const give = (empId, code) => {
    const key = empId + '|' + code;
    if (have.has(key)) return;
    have.add(key);
    granted.push({ employee_id: empId, code });
  };

  for (const e of emps) {
    const st = stats.get(e.id) || EMPTY;
    if (st.n_all >= 1) give(e.id, 'FIRST_PRED');
    if (st.n_all >= 5) give(e.id, 'PART5');
    if (st.qf >= 4) give(e.id, 'ALL_QF');
    if (st.exact >= 1) give(e.id, 'PERFECT');
    if (st.exact >= 2) give(e.id, 'SNIPER');
    if (st.exact >= 5) give(e.id, 'SNIPER5');
    if (st.scored >= 4 && st.accuracy >= 70) give(e.id, 'EXPERT');
    if (st.ghost >= 1) give(e.id, 'GHOST_DRAW');
    if (st.streak >= 3) give(e.id, 'STREAK3');
    if (st.streak >= 5) give(e.id, 'STREAK5');
    if (st.points >= 10) give(e.id, 'PTS10');
    if (st.points >= 25) give(e.id, 'PTS25');
    if (st.points >= 50) give(e.id, 'PTS50');
    if (st.quals >= 3) give(e.id, 'QUAL3');
    const was = prevRank.get(e.id);
    if (was && was - (curRank.get(e.id) ?? was) >= 3) give(e.id, 'COMEBACK');
    if (finalDone && e.champion_team === champ) give(e.id, 'CHAMPION');
  }
  if (finalDone) {
    const top = leaderboardTopId();
    if (top) give(top, 'LEGEND');
  }
  // إدراج كل الإنجازات الجديدة دفعة واحدة (multi-row INSERT OR IGNORE) — نفس النتيجة، كتابة واحدة بدل المئات.
  const CHUNK = 300;
  for (let i = 0; i < granted.length; i += CHUNK) {
    const slice = granted.slice(i, i + CHUNK);
    const ph = slice.map(() => '(?,?)').join(',');
    const params = [];
    for (const g of slice) { params.push(g.employee_id, g.code); }
    db.prepare(`INSERT OR IGNORE INTO achievements(employee_id, code) VALUES ${ph}`).run(...params);
  }
  return granted;
}

/** إحصاءات إنجازات كل الموظفين دفعة واحدة — نفس مخرجات achStats بالضبط، بعدد ثابت من الاستعلامات. */
function bulkStats() {
  const m = new Map();
  const g = (id) => {
    let s = m.get(id);
    if (!s) { s = { exact:0, dir:0, scored:0, n_all:0, points:0, quals:0, qf:0, ghost:0, streak:0, accuracy:0 }; m.set(id, s); }
    return s;
  };
  for (const r of db.prepare(`
    SELECT employee_id AS id,
           COALESCE(SUM(is_exact),0) exact, COALESCE(SUM(is_direction),0) dir,
           COUNT(points_total) scored, COUNT(*) n_all,
           COALESCE(SUM(points_total),0) points,
           COALESCE(SUM(CASE WHEN points_qual>0 THEN 1 ELSE 0 END),0) quals
    FROM predictions GROUP BY employee_id`).all()) {
    const s = g(r.id);
    s.exact = r.exact; s.dir = r.dir; s.scored = r.scored; s.n_all = r.n_all; s.points = r.points; s.quals = r.quals;
  }
  for (const r of db.prepare(`SELECT p.employee_id AS id, COUNT(*) c
                              FROM predictions p JOIN matches mm ON mm.id=p.match_id
                              WHERE mm.stage='QF' GROUP BY p.employee_id`).all())
    g(r.id).qf = r.c;
  for (const r of db.prepare(`SELECT p.employee_id AS id, COUNT(*) c
                              FROM predictions p JOIN matches mm ON mm.id=p.match_id
                              WHERE p.is_exact=1 AND mm.home_score=mm.away_score AND mm.status='finished'
                              GROUP BY p.employee_id`).all())
    g(r.id).ghost = r.c;
  // أطول متتالية (maxStreak) لكل موظف من تسلسل مرتّب واحد (نفس منطق maxStreak)
  let curEmp = null, best = 0, cur = 0;
  const flush = () => { if (curEmp !== null) g(curEmp).streak = best; };
  for (const r of db.prepare(`
    SELECT p.employee_id AS id, p.is_direction AS d
    FROM predictions p JOIN matches mm ON mm.id=p.match_id
    WHERE mm.status='finished' ORDER BY p.employee_id, mm.kickoff_utc`).all()) {
    if (r.id !== curEmp) { flush(); curEmp = r.id; best = 0; cur = 0; }
    cur = r.d ? cur + 1 : 0; if (cur > best) best = cur;
  }
  flush();
  for (const s of m.values()) s.accuracy = s.scored ? Math.round((s.dir / s.scored) * 100) : 0;
  return m;
}

/** حالة إنجازات موظف للواجهة: المفتوح بتاريخه + المقفول بتقدمه — الخفي المقفول لا يظهر. */
export function achievementState(empId) {
  const st = achStats(empId);
  const mine = new Map(db.prepare('SELECT code, awarded_at FROM achievements WHERE employee_id=?')
    .all(empId).map(r => [r.code, r.awarded_at]));
  const items = [];
  let hiddenLocked = 0;
  for (const [code, a] of Object.entries(AWARDS)) {
    const unlocked = mine.has(code);
    if (a.hidden && !unlocked) { hiddenLocked++; continue; }
    let progress = null;
    if (a.metric && a.target) {
      const current = Math.min(Number(st[a.metric] ?? 0), a.target);
      let pct = Math.round((current / a.target) * 100);
      // EXPERT بشرطين (دقة ٧٠ + ٤ محتسبة): النسبة تعكس القيد الرابط لا الأسهل
      if (code === 'EXPERT') pct = Math.min(pct, Math.round((Math.min(st.scored, 4) / 4) * 100));
      progress = { current, target: a.target, pct };
    }
    items.push({ code, name: a.name, desc: a.desc, icon: a.icon, category: a.category,
      rarity: a.rarity, hidden: !!a.hidden, unlocked, awarded_at: mine.get(code) ?? null, progress });
  }
  return {
    unlocked: mine.size,
    total_visible: items.length,
    hidden_locked: hiddenLocked,
    items,
  };
}

function maxStreak(empId) {
  const seq = db.prepare(`
    SELECT p.is_direction d FROM predictions p JOIN matches m ON m.id=p.match_id
    WHERE p.employee_id=? AND m.status='finished' ORDER BY m.kickoff_utc`).all(empId);
  let best = 0, cur = 0;
  for (const r of seq) { cur = r.d ? cur + 1 : 0; if (cur > best) best = cur; }
  return best;
}

function leaderboardTopId() {
  // lightweight: reuse leaderboard() top entry without infinite recursion on achievements
  const rows = db.prepare(`
    SELECT e.id, COALESCE(SUM(p.points_total),0) pts, COALESCE(SUM(p.is_exact),0) ex, MIN(p.created_at) f
    FROM employees e LEFT JOIN predictions p ON p.employee_id=e.id
    WHERE e.active=1 AND e.role!='admin' GROUP BY e.id
    ORDER BY pts DESC, ex DESC, f ASC LIMIT 1`).get();
  return rows?.id ?? null;
}
