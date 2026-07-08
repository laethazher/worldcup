import { db, getSetting, setSetting } from './db.js';
import { broadcast } from './sse.js';
import { audit } from './audit.js';
import { createNotification } from './notify.js';
import { leaderboard, branchLeaderboard, departmentLeaderboard, championWinner, AWARD_META } from './scoring.js';

export const TOURNAMENT = 'مونديال 2026';
const TROPHIES = ['GOLD_TROPHY', 'SILVER_TROPHY', 'BRONZE_TROPHY'];

export const completedAt = () => getSetting('tournament_completed_at') || null;
export const isCompleted = () => !!completedAt();

/**
 * توليد الفائزين حتمياً من محرك الترتيب القائم (بكواسر تعادله كما هي):
 * يستبدل صف القاعة + يسحب كؤوس هذه البطولة ويمنحها للثلاثي الحالي — ترانزاكشن واحدة.
 * نفس البيانات = نفس المخرجات بايتاً ببايت. يعيد الكؤوس الممنوحة حديثاً للإعلان.
 */
export function regenerateWinners(board = leaderboard()) {
  const [c, r2, r3] = board;
  if (!c) return { trio: [], trophyGrants: [] };
  const bTop = branchLeaderboard()[0]?.branch ?? null;
  const dTop = departmentLeaderboard()[0]?.label ?? null;
  const when = completedAt() || new Date().toISOString();

  const snap = (x) => x ? [x.id, x.name, x.branch || null, x.department || null, x.points, x.accuracy, x.exact_count] : [null, null, null, null, null, null, null];
  const trophyGrants = [];

  db.transaction(() => {
    // upsert القاعة: صف واحد ثابت الهوية لكل بطولة — إعادة التوليد بلا تغيير = لا كتابة دلالية
    const exists = db.prepare('SELECT id FROM hall_of_fame WHERE tournament = ?').get(TOURNAMENT);
    const vals = [when, ...snap(c), ...snap(r2), ...snap(r3), bTop, dTop];
    if (exists) {
      db.prepare(`UPDATE hall_of_fame SET completed_at=?,
          champion_id=?, champion_name=?, champion_branch=?, champion_department=?, champion_points=?, champion_accuracy=?, champion_exact=?,
          runner_id=?, runner_name=?, runner_branch=?, runner_department=?, runner_points=?, runner_accuracy=?, runner_exact=?,
          third_id=?, third_name=?, third_branch=?, third_department=?, third_points=?, third_accuracy=?, third_exact=?,
          winning_branch=?, winning_department=?
        WHERE tournament = ?`).run(...vals, TOURNAMENT);
    } else {
      db.prepare(`INSERT INTO hall_of_fame(
          tournament, completed_at,
          champion_id, champion_name, champion_branch, champion_department, champion_points, champion_accuracy, champion_exact,
          runner_id, runner_name, runner_branch, runner_department, runner_points, runner_accuracy, runner_exact,
          third_id, third_name, third_branch, third_department, third_points, third_accuracy, third_exact,
          winning_branch, winning_department)
        VALUES(?, ?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?,?,?,?, ?,?)`)
        .run(TOURNAMENT, ...vals);
    }

    // كؤوس تفاضلية: يُسحب ويُمنح المتغيّر فقط — الحامل ذاته يحتفظ بكأسه وتاريخ منحه،
    // وإعادة التوليد على بيانات مطابقة = صفر منح جديد = صفر إعلانات مكررة
    const holder = db.prepare('SELECT employee_id FROM achievements WHERE code = ?');
    const revoke = db.prepare('DELETE FROM achievements WHERE code = ?');
    const ins = db.prepare('INSERT OR IGNORE INTO achievements(employee_id, code) VALUES(?,?)');
    for (const [w, code] of [[c, 'GOLD_TROPHY'], [r2, 'SILVER_TROPHY'], [r3, 'BRONZE_TROPHY']]) {
      const cur = holder.get(code)?.employee_id ?? null;
      const want = w?.id ?? null;
      if (cur === want) continue;
      revoke.run(code);
      if (want && ins.run(want, code).changes) trophyGrants.push({ employee_id: want, code });
    }
  })();

  return { trio: [c, r2, r3].filter(Boolean), trophyGrants, winning_branch: bTop, winning_department: dTop };
}

/** اكتمال البطولة: قفل + فائزون + كؤوس + قاعة + إشعارات + بث + تدقيق — مرة واحدة لكل اكتمال. */
export function completeTournament(req, board) {
  if (isCompleted()) return null;
  setSetting('tournament_completed_at', new Date().toISOString());

  const w = regenerateWinners(board);
  const [c, r2, r3] = w.trio;
  const champ = championWinner();

  audit(req, 'TOURNAMENT_COMPLETED', 'tournament', TOURNAMENT, `البطل العالمي: ${champ} · اكتمل النهائي وقُفلت البطولة`);
  audit(req, 'WINNERS_GENERATED', 'tournament', TOURNAMENT,
    `🥇 ${c.name} (${c.points}) · 🥈 ${r2?.name ?? '—'} (${r2?.points ?? '—'}) · 🥉 ${r3?.name ?? '—'} (${r3?.points ?? '—'})`);
  audit(req, 'AWARDS_ASSIGNED', 'tournament', TOURNAMENT,
    w.trophyGrants.map(g => `${AWARD_META[g.code].icon} ← ${w.trio.find(t => t.id === g.employee_id)?.name}`).join(' · ') || '—');

  const medal = [['🏆 أنت بطل التحدي!', `توّجت بالمركز الأول بـ ${c.points} نقطة — كأس البطولة لك`, 'high', c],
    ['🥈 وصافة مستحقة', `المركز الثاني بـ ${r2?.points} نقطة — الكأس الفضية لك`, 'high', r2],
    ['🥉 برونزية التحدي', `المركز الثالث بـ ${r3?.points} نقطة — الكأس البرونزية لك`, 'normal', r3]];
  for (const [title, body, priority, who] of medal) {
    if (who) createNotification({ type: 'system', title, body, priority, target_type: 'employee', target_id: String(who.id) });
  }
  createNotification({ type: 'system', title: '🏁 اكتملت بطولة التحدي',
    body: `توّج ${c.name} بطلاً لتحدي كأس العالم بـ ${c.points} نقطة. شاهد قاعة المجد والاحتفال الختامي 🎉`,
    priority: 'high', target_type: 'all', target_id: null });

  setSetting('ceremony_done_at', new Date().toISOString());
  audit(req, 'CEREMONY_TRIGGERED', 'tournament', TOURNAMENT, 'احتفال ذهبي + بوديوم — بث حي لمرة واحدة');
  broadcast('tournament_finished', {
    tournament: TOURNAMENT, champion: c.name, runner: r2?.name ?? null, third: r3?.name ?? null, points: c.points });
  broadcast('hall_updated', { tournament: TOURNAMENT });

  return w;
}

/** إعادة الفتح (بتأكيد صريح): يرفع القفل ويصفّر علم الاحتفال — القاعة تبقى موسومة قيد المراجعة. */
export function reopenTournament(req) {
  setSetting('tournament_completed_at', '');
  setSetting('ceremony_done_at', '');
  audit(req, 'TOURNAMENT_REOPENED', 'tournament', TOURNAMENT, 'رُفع القفل — النتائج قابلة للتعديل وسيُعاد توليد الفائزين عند الإكمال');
  broadcast('hall_updated', { tournament: TOURNAMENT, reopened: true });
}

/** حالة البطولة + صف القاعة الحالي (للإدارة وصفحة القاعة). */
export function tournamentStatus() {
  const hall = db.prepare('SELECT * FROM hall_of_fame WHERE tournament = ?').get(TOURNAMENT) ?? null;
  return { tournament: TOURNAMENT, completed_at: completedAt(), ceremony_done_at: getSetting('ceremony_done_at') || null, hall };
}
