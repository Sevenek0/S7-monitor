/** Zamienia błąd sieci na krótki opis po polsku (używany w powiadomieniach). */
export function describeError(err) {
  if (!err) return 'nieznany błąd';
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout';
  const code = err.cause?.code || err.cause?.errors?.[0]?.code || err.code;
  switch (code) {
    case 'ECONNREFUSED': return 'połączenie odrzucone';
    case 'ENOTFOUND':
    case 'EAI_AGAIN': return 'nie znaleziono hosta';
    case 'ECONNRESET':
    case 'UND_ERR_SOCKET':
    case 'UND_ERR_CLOSED': return 'połączenie zerwane';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH': return 'host nieosiągalny';
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'ETIMEDOUT': return 'timeout';
    case 'CERT_HAS_EXPIRED': return 'certyfikat SSL wygasł';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE': return 'błąd certyfikatu SSL';
  }
  if (err.reason) return err.reason;
  if (err.message === 'fetch failed' && err.cause?.message) return err.cause.message;
  return err.message || 'błąd';
}

/** Usuwa kody kolorów FiveM (^0–^9). */
export function stripColors(s) {
  return String(s ?? '').replace(/\^[0-9]/g, '').trim();
}

export const TIMEOUT_MS = 10_000;
