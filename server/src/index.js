import { loadDotEnv, createConfig } from './config.js';
import { createServices } from './services.js';

const envFile = loadDotEnv();
const config = createConfig();

if (!config.password) {
  console.error('[start] Brak APP_PASSWORD w .env — logowanie będzie niemożliwe. Ustaw hasło i zrestartuj.');
}
if (!config.ptero.enabled) {
  console.warn('[start] PTERO_URL/PTERO_KEY nie ustawione — monitory Pterodactyl będą DOWN.');
}

const services = createServices(config);
const server = services.app.listen(config.port, config.host, () => {
  console.log(`[start] S7 Monitor działa na http://${config.host}:${config.port} (dane: ${config.dataDir}${envFile ? `, env: ${envFile}` : ''})`);
  services.start();
});

function shutdown(sig) {
  console.log(`[stop] ${sig} — zamykanie...`);
  services.stop();
  server.closeAllConnections?.();
  server.close(() => { services.db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
