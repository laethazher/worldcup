import { Router } from 'express';
import { db, getSetting, nowISO } from '../db.js';
import { VIS_SQL, visParams } from '../notify.js';
import { authRequired } from '../auth.js';
import { audit } from '../audit.js';
import { broadcast } from '../sse.js';
import { AWARD_META, achievementState } from '../scoring.js';
import { isCompleted, tournamentStatus } from '../tournament.js';

const r = Router();
r.use(authRequired);

const teamName = (code) => code ? db.prepare('SELECT name_ar FROM teams WHERE code=?').get(code)?.name_ar : null;
const isLocked = (m) => new Date(m.kickoff_utc) <= new Date() || m.status === 'finished';

function matchView(m, userId) {
  const locked = isLocked(m);
  const pred = db.prepare('SELECT * FROM predictions WHERE employee_id=? AND match_id=?').get(userId, m.id);
  const out = {
    id: m.id, round_no: m.round_no, stage: m.stage, stage_ar: m.stage_ar,
    home_team: m.home_team, away_team: m.away_team,
    home_name: teamName(m.home_team) || m.placeholder_home,
    away_name: teamName(m.away_team) || m.placeholder_away,
    teams_set: !!(m.home_team && m.away_team),
    kickoff_utc: m.kickoff_utc, multiplier: m.multiplier,
    status: m.status, locked,
    home_score: m.home_score, away_score: m.away_score, advancing_team: m.advancing_team,
    my_prediction: pred ? {
      home_score: pred.home_score, away_score: pred.away_score,
      penalty_winner: pred.penalty_winner, joker: !!pred.joker,
      points_total: pred.points_total, points_base: pred.points_base, points_qual: pred.points_qual,
      is_exact: pred.is_exact, is_direction: pred.is_direction,
    } : null,
  };
  if (locked) {
    const total = db.prepare('SELECT COUNT(*) c FROM predictions WHERE match_id=?').get(m.id).c;
    const home = db.prepare('SELECT COUNT(*) c FROM predictions WHERE match_id=? AND home_score>away_score').get(m.id).c;
    const away = db.prepare('SELECT COUNT(*) c FROM predictions WHERE match_id=? AND away_score>home_score').get(m.id).c;
    const draw = total - home - away;
    const topScores = db.prepare(`SELECT home_score||'-'||away_score s, COUNT(*) c FROM predictions WHERE match_id=? GROUP BY s ORDER BY c DESC LIMIT 3`).all(m.id);
    out.stats = { total, home, draw, away, top_scores: topScores };
  }
  return out;
}

r.get('/matches', (req, res) => {
  const rows = db.prepare('SELECT * FROM matches ORDER BY kickoff_utc').all();
  res.json(rows.map(m => matchView(m, req.user.id)));
});

r.post('/matches/:id/prediction', (req, res) => {
  const m = db.prepare('SELECT * FROM matches WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'المباراة غير موجودة' });
  if (isCompleted()) return res.status(423).json({ error: 'اكتملت البطولة — التوقعات مُقفلة نهائياً 🏁' });
  if (isLocked(m)) return res.status(423).json({ error: 'أُغلق التوقع — بدأت المباراة' });
  if (!m.home_team || !m.away_team) return res.status(400).json({ error: 'التوقع يُفتح بعد تحديد الفريقين' });

  let { home_score, away_score, penalty_winner = null, joker = false } = req.body || {};
  home_score = Number(home_score); away_score = Number(away_score);
  const validScore = (n) => Number.isInteger(n) && n >= 0 && n <= 15;
  if (!validScore(home_score) || !validScore(away_score)) {
    return res.status(400).json({ error: 'أدخل نتيجة صحيحة بين ٠ و ١٥' });
  }
  if (home_score === away_score) {
    if (![m.home_team, m.away_team].includes(penalty_winner)) {
      return res.status(400).json({ error: 'عند التعادل اختر المتأهل بركلات الترجيح' });
    }
  } else penalty_winner = null;

  joker = joker ? 1 : 0;
  if (joker) {
    const burned = db.prepare(`
      SELECT 1 FROM predictions p JOIN matches mm ON mm.id = p.match_id
      WHERE p.employee_id=? AND p.joker=1 AND p.match_id != ? AND mm.kickoff_utc <= ?
      LIMIT 1`).get(req.user.id, m.id, nowISO());
    if (burned) return res.status(400).json({ error: 'استخدمت الجوكر في مباراة سابقة' });
    // free the joker from any other open match
    db.prepare(`UPDATE predictions SET joker=0 WHERE employee_id=? AND match_id!=? AND joker=1`).run(req.user.id, m.id);
  }

  db.prepare(`
    INSERT INTO predictions(employee_id, match_id, home_score, away_score, penalty_winner, joker)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(employee_id, match_id) DO UPDATE SET
      home_score=excluded.home_score, away_score=excluded.away_score,
      penalty_winner=excluded.penalty_winner, joker=excluded.joker,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
    .run(req.user.id, m.id, home_score, away_score, penalty_winner, joker);

  audit(req, 'PREDICTION_SAVED', 'match', m.id, `${home_score}-${away_score}${penalty_winner ? ' pen:' + penalty_winner : ''}${joker ? ' joker' : ''}`);
  res.json({ ok: true, match: matchView(db.prepare('SELECT * FROM matches WHERE id=?').get(m.id), req.user.id) });
});

r.get('/joker', (req, res) => {
  const j = db.prepare(`
    SELECT p.match_id, mm.kickoff_utc FROM predictions p JOIN matches mm ON mm.id=p.match_id
    WHERE p.employee_id=? AND p.joker=1`).get(req.user.id);
  res.json({ used_on: j?.match_id ?? null, consumed: j ? new Date(j.kickoff_utc) <= new Date() : false });
});

r.post('/champion', (req, res) => {
  const lock = getSetting('champion_lock_utc');
  if (lock && new Date(lock) <= new Date()) return res.status(423).json({ error: 'أُغلق توقع البطل' });
  const { team } = req.body || {};
  if (!db.prepare('SELECT 1 FROM teams WHERE code=?').get(team)) return res.status(400).json({ error: 'اختر منتخباً صحيحاً' });
  db.prepare(`UPDATE employees SET champion_team=?, champion_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(team, req.user.id);
  audit(req, 'CHAMPION_PICKED', 'team', team);
  res.json({ ok: true, team });
});

r.get('/teams', (_req, res) => res.json(db.prepare('SELECT * FROM teams').all()));

// ------------------------------------------------------------------ dashboard aggregate
r.get('/dashboard', (req, res) => {
  const uid = req.user.id;
  const matches = db.prepare('SELECT * FROM matches ORDER BY kickoff_utc').all().map(m => matchView(m, uid));
  const next = matches.find(m => m.status === 'scheduled' && !m.locked) || matches.find(m => m.status === 'scheduled') || null;
  const recent = matches.filter(m => m.status === 'finished').slice(-3).reverse();

  const my = db.prepare(`
    SELECT COALESCE(SUM(points_total),0) pts, COALESCE(SUM(is_exact),0) ex,
           COALESCE(SUM(is_direction),0) dir, COUNT(points_total) n
    FROM predictions WHERE employee_id=?`).get(uid);

  const board = db.prepare(`
    SELECT e.id, COALESCE(SUM(p.points_total),0) pts, COALESCE(SUM(p.is_exact),0) ex, MIN(p.created_at) f
    FROM employees e LEFT JOIN predictions p ON p.employee_id=e.id
    WHERE e.active=1 AND e.role!='admin' GROUP BY e.id ORDER BY pts DESC, ex DESC, f ASC`).all();
  const rank = board.findIndex(b => b.id === uid) + 1;

  const awards = db.prepare('SELECT code, awarded_at FROM achievements WHERE employee_id=? ORDER BY awarded_at DESC').all(uid)
    .map(a => ({ code: a.code, ...AWARD_META[a.code] }));

  const company = {
    employees: db.prepare(`SELECT COUNT(*) c FROM employees WHERE active=1 AND role!='admin'`).get().c,
    predictions: db.prepare('SELECT COUNT(*) c FROM predictions').get().c,
    exact_total: db.prepare('SELECT COALESCE(SUM(is_exact),0) c FROM predictions').get().c,
  };

  const vp = visParams(req.user);
  const notifications = db.prepare(`
    SELECT n.*, CASE WHEN r.notification_id IS NULL THEN 0 ELSE 1 END AS read
    FROM notifications n LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.employee_id = @eid
    WHERE ${VIS_SQL}
      AND NOT EXISTS(SELECT 1 FROM notification_hidden h WHERE h.notification_id = n.id AND h.employee_id = @eid)
    ORDER BY n.id DESC LIMIT 10`).all(vp);

  const championLock = getSetting('champion_lock_utc');
  res.json({
    user: { ...req.user, branch: req.user.branch_id ? db.prepare('SELECT name FROM branches WHERE id=?').get(req.user.branch_id)?.name : '' },
    next_match: next, matches, recent,
    my_stats: { points: my.pts, rank: rank || null, total_players: board.length, exact: my.ex, accuracy: my.n ? Math.round(my.dir / my.n * 100) : null, scored: my.n },
    achievements: awards, company, notifications,
    champion: { picked: req.user.champion_team, lock_utc: championLock, locked: championLock ? new Date(championLock) <= new Date() : false },
  });
});

/** قاعة المجد: اللقطة الدائمة + إنجازات الفائزين الحالية — متاحة لكل مسجَّل. */
r.get('/hall', (req, res) => {
  const st = tournamentStatus();
  const codesOf = (id) => id
    ? db.prepare('SELECT code FROM achievements WHERE employee_id=? ORDER BY awarded_at').all(id).map(x => x.code)
    : [];
  res.json({
    tournament: st.tournament,
    completed_at: st.completed_at,
    reopened: !st.completed_at && !!st.hall,
    hall: st.hall ? { ...st.hall,
      champion_achievements: codesOf(st.hall.champion_id),
      runner_achievements: codesOf(st.hall.runner_id),
      third_achievements: codesOf(st.hall.third_id) } : null,
    award_meta: AWARD_META,
  });
});

/** مركز إنجازاتي: الكتالوج بحالتي — تقدم للمقفول، تاريخ فتح للمفتوح، الخفي محجوب حتى يُفتح. */
r.get('/achievements', (req, res) => {
  res.json(achievementState(req.user.id));
});

export default r;
