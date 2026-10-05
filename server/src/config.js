import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Wczytuje .env (jeśli istnieje) z katalogu server/ lub z katalogu głównego repo. */
export function loadDotEnv() {
  for (const p of [path.join(SERVER_ROOT, '.env'), path.join(SERVER_ROOT, '..', '.env')]) {
    if (fs.existsSync(p)) {
      try { process.loadEnvFile(p); } catch (e) { console.warn(`[config] Nie udało się wczytać ${p}: ${e.message}`); }
      return p;
    }
  }
  return null;
}

function int(v, def) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

/**
 * Buduje konfigurację z obiektu env. APP_SECRET jest generowany i zapisywany
 * w katalogu data, jeśli nie podano go w zmiennych środowiskowych.
 */
export function createConfig(env = process.env) {
  const dataDir = path.resolve(env.DATA_DIR || path.join(SERVER_ROOT, 'data'));
  fs.mkdirSync(dataDir, { recursive: true });

  let secret = env.APP_SECRET;
  if (!secret) {
    const file = path.join(dataDir, 'secret.key');
    if (fs.existsSync(file)) {
      secret = fs.readFileSync(file, 'utf8').trim();
    } else {
      secret = crypto.randomBytes(48).toString('base64url');
      fs.writeFileSync(file, secret, { mode: 0o600 });
      console.log('[config] Wygenerowano nowy APP_SECRET (data/secret.key)');
    }
  }

  const pteroUrl = (env.PTERO_URL || '').replace(/\/+$/, '');
  return {
    port: int(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    dataDir,
    dbFile: path.join(dataDir, 's7monitor.db'),
    password: env.APP_PASSWORD || '',
    secret,
    tokenTtlMs: 30 * 24 * 3600 * 1000,
    ptero: { url: pteroUrl, key: env.PTERO_KEY || '', enabled: Boolean(pteroUrl && env.PTERO_KEY) },
    agent: { socket: env.S7_AGENT_SOCKET || '', url: env.S7_AGENT_URL || '' },
    vapidSubject: env.VAPID_SUBJECT || 'mailto:admin@example.com',
    publicDir: path.join(SERVER_ROOT, 'public'),
    tickMs: int(env.TICK_MS, 5000),
    concurrency: int(env.CHECK_CONCURRENCY, 8),
    retentionDays: int(env.RETENTION_DAYS, 30),
    trustProxy: env.TRUST_PROXY ?? 'loopback, uniquelocal',
  };
}
