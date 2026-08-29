import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

// .env simples (sem dependências): KEY=VALUE, # comenta a linha.
function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
loadDotEnv();

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  dbPath: process.env.OUTFOOD_DB || path.join(ROOT, 'data', 'outfood.db'),
  secret: process.env.OUTFOOD_SECRET || 'outfood-dev-secret',
  origin: process.env.OUTFOOD_ORIGIN || '',
  publicDir: path.join(ROOT, 'public'),
  legacyDir: path.join(ROOT, 'legacy'),
  admin: {
    name: process.env.OUTFOOD_ADMIN_NAME || 'Administrador',
    email: process.env.OUTFOOD_ADMIN_EMAIL || 'admin@outfood.local',
    password: process.env.OUTFOOD_ADMIN_PASSWORD || 'outfood123',
  },
  sessionDays: Number(process.env.OUTFOOD_SESSION_DAYS || 14),
  isProd: process.env.NODE_ENV === 'production',
};

if (config.isProd && config.secret === 'outfood-dev-secret') {
  console.warn('[outfood] AVISO: defina OUTFOOD_SECRET em produção.');
}
