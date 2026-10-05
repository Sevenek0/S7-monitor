import { checkHttp } from './http.js';
import { checkFivem } from './fivem.js';
import { checkPterodactyl, fetchPteroInfo } from './pterodactyl.js';

export const CHECKERS = { http: checkHttp, fivem: checkFivem, pterodactyl: checkPterodactyl };

/**
 * Uruchamia sprawdzenie monitora. Jeśli monitor nie jest typu pterodactyl, ale ma
 * pteroServerId, dokładamy zasoby (CPU/RAM) z panelu — błąd panelu nie zmienia statusu.
 */
export async function runChecker(monitor, ctx) {
  const fn = (ctx.checkers || CHECKERS)[monitor.type];
  if (!fn) return { status: 'down', error: `nieznany typ ${monitor.type}` };
  let result;
  try {
    result = await fn(monitor, ctx);
  } catch (err) {
    result = { status: 'down', error: err.message || 'błąd sprawdzania' };
  }
  if (monitor.type !== 'pterodactyl' && monitor.pteroServerId && ctx.ptero?.enabled) {
    try {
      const { info } = await fetchPteroInfo(ctx.ptero, monitor.pteroServerId);
      result.data = { ...(result.data || {}), ptero: info };
      result.cpu = info.cpu;
      result.mem = info.mem;
    } catch { /* ignorujemy */ }
  }
  return result;
}
