// Runs once on first boot: seeds teams, matches, branches and the admin
// account ONLY when the database is empty. On every later restart it finds
// the matches already there and does nothing — so it never overwrites data
// you or the admin panel have changed.
import { db, syncNow } from './db.js';

const count = db.prepare('SELECT COUNT(*) AS c FROM matches').get().c;
if (count === 0) {
  console.log('⚙  قاعدة بيانات جديدة — تهيئة أولية (بذر)…');
  await import('./seed.js');
} else {
  console.log(`✓ قاعدة البيانات مهيّأة مسبقاً (${count} مباريات) — تخطّي البذر`);
}
syncNow();   // تثبيت أي تغييرات في Turso قبل الخروج
