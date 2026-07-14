import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, isProd } from './config.js';
import { db, syncNow } from './db.js';
import authRoutes from './routes/auth.js';
import matchRoutes from './routes/matches.js';
import boardRoutes from './routes/leaderboard.js';
import adminRoutes from './routes/admin.js';
import profileRoutes from './routes/profile.js';
import orgsRoutes from './routes/orgs.js';
import notificationRoutes from './routes/notifications.js';
import { authRequired } from './auth.js';
import { sseHandler, closeAllStreams } from './sse.js';
import { recalcAll } from './scoring.js';

/* شفاء ذاتي عند الإقلاع: نتيجة معتمدة بلا نقاط محتسبة تعني تعطّلاً سابقاً بين حفظ
   النتيجة وإعادة الاحتساب (الحفظ يلتزم أولاً في مسار الاعتماد) — فتبقى لوحة الترتيب
   ناقصة نقاط مباراة معتمدة حتى تدخّل يدوي. نكشف الحالة ونعيد الاحتساب بنفس المحرك
   القائم (حتمي ومتكرر النتيجة، ولا يعمل إطلاقاً حين تكون النقاط سليمة). */
try {
  if (db.prepare(`SELECT 1 FROM predictions p JOIN matches m ON m.id = p.match_id
                  WHERE m.status = 'finished' AND p.points_total IS NULL LIMIT 1`).get()) {
    const { board } = recalcAll({ trigger: 'boot' });
    console.log(`✓ شفاء ذاتي عند الإقلاع: أُعيد احتساب نقاط نتيجة معتمدة لم تُحتسب (${board.length} مشاركاً)`);
  }
} catch (e) {
  console.error('⚠ تعذّر الشفاء الذاتي عند الإقلاع:', e.message);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy ? 1 : false);

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.use('/api', authRoutes);
app.use('/api', matchRoutes);
app.use('/api', boardRoutes);
app.use('/api', notificationRoutes);
app.use('/api', profileRoutes);
app.use('/api/admin', orgsRoutes);
app.use('/api/admin', adminRoutes);
app.get('/api/stream', authRequired, sseHandler);

app.use(express.static(path.join(__dirname, '..', 'public'), {
  extensions: ['html'],
  maxAge: '1h',
  setHeaders(res, filePath) {
    // html + js + css بلا تخزين: أي تحديث ننشره يظهر فوراً للجميع (الخطوط وحدها تبقى مخزّنة)
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
    if (filePath.includes('/fonts/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  },
}));

// not-found fallback
app.use((req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'غير موجود' });
  res.status(404).sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

// ─── central error handler (must stay the last middleware) ───────────
const BODY_ERRORS = {
  'entity.parse.failed': [400, 'صيغة الطلب غير صحيحة'],
  'entity.too.large': [413, 'حجم الطلب أكبر من المسموح'],
};
app.use((err, req, res, _next) => {
  const mapped = BODY_ERRORS[err.type];
  const status = mapped ? mapped[0] : Number(err.status || err.statusCode) || 500;
  const message = mapped ? mapped[1]
    : status >= 500 ? 'حدث خطأ داخلي، حاول مرة أخرى'
    : err.message || 'حدث خطأ';
  if (status >= 500) {
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} →`, err);
  }
  if (res.headersSent) return;
  res.status(status).json(isProd ? { error: message } : { error: message, detail: String(err.stack || err) });
});

const server = app.listen(config.port, () =>
  console.log(`⚽ Al-Hasani World Cup Challenge → http://localhost:${config.port} (${config.env})`));

// ─── graceful shutdown (systemd / docker friendly) ───────────────────
let closing = false;
function shutdown(signal, code = 0) {
  if (closing) return;
  closing = true;
  console.log(`⏻ ${signal} — إيقاف آمن للتطبيق…`);
  closeAllStreams();
  server.close(() => {
    try { syncNow(); } catch { /* best effort */ }   // آخر مزامنة قبل الإغلاق
    try { db.close(); } catch { /* already closed */ }
    console.log('✓ أُغلقت الاتصالات وقاعدة البيانات بأمان');
    process.exit(code);
  });
  setTimeout(() => process.exit(code), 8000).unref(); // hard stop if a socket hangs
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => console.error('unhandledRejection:', reason));
process.on('uncaughtException', (err) => { console.error('uncaughtException:', err); shutdown('uncaughtException', 1); });