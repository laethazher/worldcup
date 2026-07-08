import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..');

// Load .env from project root if present.
// Native Node (≥20.12) — no dotenv dependency. Existing process env always wins.
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* .env is optional */ }

const bool = (v, fallback) => v === undefined ? fallback
  : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

export const config = {
  env: process.env.NODE_ENV || 'production',
  port: Number(process.env.PORT) || 3000,
  dbPath: process.env.DB_PATH || path.join(ROOT, 'data', 'worldcup.db'),
  jwtSecret: process.env.JWT_SECRET || null, // null → generated once and persisted in DB settings
  cookieSecure: bool(process.env.COOKIE_SECURE, false),
  trustProxy: bool(process.env.TRUST_PROXY, true),
};

export const isProd = config.env === 'production';
