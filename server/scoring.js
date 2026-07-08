import { db, getSetting } from './db.js';

export const STAGE_KEYS = ['R16', 'QF', 'SF', 'THIRD', 'FINAL'];
const DEFAULT_STAGE_MULT = { R16: 1, QF: 1, SF: 2, THIRD: 2, FINAL: 3 };

/** التهيئة الكاملة — متوافقة رجعياً مع صيغة {direction} القديمة (تنشطر إلى فوز/تعادل). */
export function scoringConfig() {
  const raw = JSON.parse(getSetting('scoring', '{}'));
  const legacyDir = raw.direction ?? 2;
  return {
    exact: raw.exact ?? 5,
    winner: raw.winner ?? legacyDir,
    draw: raw.draw ?? legacyDir,
    wrong: raw.wrong ?? 0,
    qualification: raw.qualification ?? 2,
    champion_bonus: raw.champion_bonus ?? 10,
    joker_multiplier: raw.joker_multiplier ?? 2,
    stage_multipliers: { ...DEFAULT_STAGE_MULT, ...(raw.stage_multipliers || {}) },
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
  const preds = db.prepare('SELECT * FROM predictions WHERE match_id = ?').all(matchId);
  const upd = db.prepare(`UPDATE predictions SET points_base=?, points_qual=?, points_total=?, is_exact=?, is_direction=? WHERE id=?`);

  const upd2 = db.prepare(`UPDATE predictions SET calc_multiplier=?, calc_reason=?, calc_breakdown=? WHERE id=?`);
  for (const p of preds) {
    const exact = p.home_score === m.home_score && p.away_score === m.away_score;
    const actualSign = sign(m.home_score, m.away_score);
    const outcomeOk = sign(p.home_score, p.away_score) === actualSign;
    let base, kind;
    if (exact) { base = R.exact; kind = 'توقع دقيق'; }
    else if (outcomeOk && actualSign === 0) { base = R.draw; kind = 'تعادل صحيح'; }
    else if (outcomeOk) { base = R.winner; kind = 'فائز صحيح'; }
    else { base = R.wrong; kind = 'توقع خاطئ'; }
    const qual = (m.advancing_team && predictedAdvancer(p, m) === m.advancing_team) ? R.qualification : 0;
    const jokerMult = p.joker ? R.joker_multiplier : 1;
    const total = (base + qual) * m.multiplier * jokerMult;
    const reason = kind
      + (qual ? ' + متأهل' : '')
      + (m.multiplier !== 1 ? ` ×${m.multiplier} (${m.stage_ar || m.stage})` : '')
      + (p.joker ? ` ×${R.joker_multiplier} جوكر` : '');
    upd.run(base, qual, total, exact ? 1 : 0, outcomeOk ? 1 : 0, p.id);
    upd2.run(m.multiplier, reason,
      JSON.stringify({ kind, base, qual, stage_mult: m.multiplier, joker_mult: jokerMult, total }), p.id);
  }
}

/** Full recalculation: all finished matches → achievements → rank snapshot. Returns { board, granted }. */
export function recalcAll(ctx = {}) {
  db.prepare(`UPDATE predictions SET points_base=NULL, points_qual=NULL, points_total=NULL,
              is_exact=NULL, is_direction=NULL, calc_multiplier=NULL, calc_reason=NULL, calc_breakdown=NULL`).run();
  const finished = db.prepare(`SELECT id FROM matches WHERE status='finished' ORDER BY kickoff_utc`).all();
  for (const m of finished) scoreMatch(m.id);
  const granted = computeAchievements();
  const board = leaderboard();
  snapshotRanks(board);
  db.prepare(`INSERT INTO scoring_runs(trigger_type, match_id, players, total_points, granted, actor_name)
              VALUES(?,?,?,?,?,?)`)
    .run(ctx.trigger || 'manual', ctx.match_id ?? null, board.length,
         board.reduce((a, r) => a + r.points, 0), granted.length, ctx.actor ?? null);
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

  for (const r of rows) {
    r.champion_bonus = (champ && r.champion_team === champ) ? R.champion_bonus : 0;
    r.points += r.champion_bonus;
    r.accuracy = r.scored_count ? Math.round((r.direction_count / r.scored_count) * 100) : 0;
    r.streak = currentStreak(r.id);
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
    r.achievements = db.prepare('SELECT code FROM achievements WHERE employee_id=?').all(r.id).map(a => a.code);
  });
  return rows;
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
  const del = db.prepare('DELETE FROM rank_snapshots');
  const ins = db.prepare('INSERT INTO rank_snapshots(employee_id, rank) VALUES(?,?)');
  db.transaction(() => { del.run(); board.forEach(r => ins.run(r.id, r.rank)); })();
}

// ------------------------------------------------------------------ achievements
/** كتالوج الإنجازات: الأكواد السبعة الأصلية محفوظة كما هي + ١١ جديداً.
    metric/target → إنجازات قائمة على التقدم؛ hidden → لا تظهر قبل فتحها. */
const AWARDS = {
  // توقعات
  PERFECT:    { name: 'توقع مثالي',     desc: 'نتيجة دقيقة ١٠٠٪',                icon: '🎯', category: 'prediction',    rarity: 'rare',      metric: 'exact', target: 1 },
  SNIPER:     { name: 'القنّاص',        desc: 'نتيجتان دقيقتان أو أكثر',          icon: '🏹', category: 'prediction',    rarity: 'epic',      metric: 'exact', target: 2 },
  SNIPER5:    { name: 'عين الصقر',      desc: '٥ نتائج دقيقة في البطولة',         icon: '💥', category: 'prediction',    rarity: 'legendary', metric: 'exact', target: 5 },
  JOKER_HIT:  { name: 'ضربة الجوكر',    desc: 'الجوكر على نتيجة دقيقة',           icon: '🃏', category: 'prediction',    rarity: 'epic' },
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
           COALESCE(SUM(CASE WHEN joker=1 AND is_exact=1 THEN 1 ELSE 0 END),0) jhit,
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

  for (const e of emps) {
    const st = achStats(e.id);
    if (st.n_all >= 1) grant(e.id, 'FIRST_PRED', granted);
    if (st.n_all >= 5) grant(e.id, 'PART5', granted);
    if (st.qf >= 4) grant(e.id, 'ALL_QF', granted);
    if (st.exact >= 1) grant(e.id, 'PERFECT', granted);
    if (st.exact >= 2) grant(e.id, 'SNIPER', granted);
    if (st.exact >= 5) grant(e.id, 'SNIPER5', granted);
    if (st.scored >= 4 && st.accuracy >= 70) grant(e.id, 'EXPERT', granted);
    if (st.jhit >= 1) grant(e.id, 'JOKER_HIT', granted);
    if (st.ghost >= 1) grant(e.id, 'GHOST_DRAW', granted);
    if (st.streak >= 3) grant(e.id, 'STREAK3', granted);
    if (st.streak >= 5) grant(e.id, 'STREAK5', granted);
    if (st.points >= 10) grant(e.id, 'PTS10', granted);
    if (st.points >= 25) grant(e.id, 'PTS25', granted);
    if (st.points >= 50) grant(e.id, 'PTS50', granted);
    if (st.quals >= 3) grant(e.id, 'QUAL3', granted);
    const was = prevRank.get(e.id);
    if (was && was - (curRank.get(e.id) ?? was) >= 3) grant(e.id, 'COMEBACK', granted);
    if (finalDone && e.champion_team === champ) grant(e.id, 'CHAMPION', granted);
  }
  if (finalDone) {
    const top = leaderboardTopId();
    if (top) grant(top, 'LEGEND', granted);
  }
  return granted;
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
