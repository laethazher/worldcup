import { db, setSetting, backfillDepartments, syncNow } from './db.js';
import { hashPassword } from './auth.js';

const teams = [
  ['FRA', 'فرنسا'], ['MAR', 'المغرب'], ['ESP', 'إسبانيا'], ['BEL', 'بلجيكا'],
  ['NOR', 'النرويج'], ['ENG', 'إنكلترا'], ['ARG', 'الأرجنتين'], ['SUI', 'سويسرا'],
];

// Real remaining FIFA World Cup 2026 fixtures (UTC) — as of 8 July 2026.
const matches = [
  { round_no: 97,  stage: 'QF',     stage_ar: 'ربع النهائي',        home: 'FRA', away: 'MAR', kickoff: '2026-07-09T20:00:00Z', mult: 1 },
  { round_no: 98,  stage: 'QF',     stage_ar: 'ربع النهائي',        home: 'ESP', away: 'BEL', kickoff: '2026-07-10T19:00:00Z', mult: 1 },
  { round_no: 99,  stage: 'QF',     stage_ar: 'ربع النهائي',        home: 'NOR', away: 'ENG', kickoff: '2026-07-11T21:00:00Z', mult: 1 },
  { round_no: 100, stage: 'QF',     stage_ar: 'ربع النهائي',        home: 'ARG', away: 'SUI', kickoff: '2026-07-12T01:00:00Z', mult: 1 },
  { round_no: 101, stage: 'SF',     stage_ar: 'نصف النهائي',        ph: 'الفائز من المباراة ٩٧', pa: 'الفائز من المباراة ٩٨', kickoff: '2026-07-14T19:00:00Z', mult: 2 },
  { round_no: 102, stage: 'SF',     stage_ar: 'نصف النهائي',        ph: 'الفائز من المباراة ٩٩', pa: 'الفائز من المباراة ١٠٠', kickoff: '2026-07-15T19:00:00Z', mult: 2 },
  { round_no: 103, stage: 'BRONZE', stage_ar: 'مباراة المركز الثالث', ph: 'خاسر نصف النهائي الأول', pa: 'خاسر نصف النهائي الثاني', kickoff: '2026-07-18T21:00:00Z', mult: 2 },
  { round_no: 104, stage: 'FINAL',  stage_ar: 'المباراة النهائية',   ph: 'الفائز من نصف النهائي الأول', pa: 'الفائز من نصف النهائي الثاني', kickoff: '2026-07-19T19:00:00Z', mult: 3 },
];

const insTeam = db.prepare('INSERT OR IGNORE INTO teams(code, name_ar) VALUES(?,?)');
teams.forEach(t => insTeam.run(...t));

const insMatch = db.prepare(`INSERT INTO matches
  (round_no, stage, stage_ar, home_team, away_team, placeholder_home, placeholder_away, kickoff_utc, multiplier)
  VALUES (@round_no, @stage, @stage_ar, @home, @away, @ph, @pa, @kickoff, @mult)`);

const existing = db.prepare('SELECT COUNT(*) AS c FROM matches').get().c;
if (existing === 0) {
  for (const m of matches) {
    insMatch.run({ round_no: m.round_no, stage: m.stage, stage_ar: m.stage_ar,
      home: m.home ?? null, away: m.away ?? null, ph: m.ph ?? '', pa: m.pa ?? '',
      kickoff: m.kickoff, mult: m.mult });
  }
  console.log('✓ 8 matches seeded (QF → Final)');
}

// Champion pick locks at first QF kickoff
setSetting('champion_lock_utc', '2026-07-09T20:00:00Z');
setSetting('scoring', JSON.stringify({ exact: 5, direction: 2, qualification: 2, champion_bonus: 10 }));

// Branches
const branchNames = ['المنصور', 'الكرادة', 'زيونة', 'الإدارة العامة'];
const insBranch = db.prepare('INSERT OR IGNORE INTO branches(name) VALUES(?)');
branchNames.forEach(b => insBranch.run(b));

// Admin account
const adminExists = db.prepare("SELECT 1 FROM employees WHERE role='admin' LIMIT 1").get();
if (!adminExists) {
  const hq = db.prepare('SELECT id FROM branches WHERE name=?').get('الإدارة العامة');
  db.prepare(`INSERT INTO employees(username,password_hash,name,department,branch_id,role)
              VALUES(?,?,?,?,?,'admin')`)
    .run('laethalkawaz', hashPassword('laethalkawaz'), 'مدير النظام', 'تقنية المعلومات', hq.id);
  console.log('✓ laethalkawaz / laethalkawaz  (غيّر كلمة المرور بعد أول دخول)');
}

// Demo employees (safe to delete from admin panel)
if (process.argv.includes('--demo')) {
  const demo = [
    ['ali.h', 'علي حسين', 'المبيعات', 'المنصور'],
    ['sara.k', 'سارة كريم', 'المحاسبة', 'الكرادة'],
    ['omar.j', 'عمر جاسم', 'اللوجستيك', 'زيونة'],
  ];
  const insEmp = db.prepare(`INSERT OR IGNORE INTO employees(username,password_hash,name,department,branch_id)
                             VALUES(?,?,?,?,(SELECT id FROM branches WHERE name=?))`);
  demo.forEach(d => insEmp.run(d[0], hashPassword('123456'), d[1], d[2], d[3]));
  console.log('✓ 3 demo employees (password: 123456)');
}

backfillDepartments();
syncNow();   // دفع بيانات البذر إلى Turso قبل الخروج
console.log('✓ Seed complete');
