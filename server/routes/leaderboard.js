import { Router } from 'express';
import { db } from '../db.js';
import { authRequired } from '../auth.js';
import { leaderboard, branchLeaderboard, departmentLeaderboard, championWinner, AWARD_META } from '../scoring.js';

const r = Router();
r.use(authRequired);

r.get('/leaderboard', (_req, res) => res.json(leaderboard()));
r.get('/leaderboard/branches', (_req, res) => res.json(branchLeaderboard()));
r.get('/leaderboard/departments', (_req, res) => res.json(departmentLeaderboard()));
r.get('/leaderboard/admins', (_req, res) => res.json(leaderboard({ role: 'admin' })));

r.get('/ceremony', (req, res) => {
  const champ = championWinner();
  const preview = req.query.preview === '1' && req.user.role === 'admin';
  if (!champ && !preview) return res.status(400).json({ error: 'الحفل يُفتح بعد المباراة النهائية' });
  const board = leaderboard();
  const champName = champ ? db.prepare('SELECT name_ar FROM teams WHERE code=?').get(champ)?.name_ar : null;
  res.json({
    world_champion: champ ? { code: champ, name: champName } : null,
    podium: board.slice(0, 3),
    hall_of_fame: board,
    award_meta: AWARD_META,
    preview: !champ,
  });
});

export default r;
