import { describeError, TIMEOUT_MS } from './util.js';

const MAX_BODY = 2 * 1024 * 1024;

/** Sprawdza, czy kod HTTP mieści się w specyfikacji np. "200-399" lub "200,301". */
export function codeMatches(spec, code) {
  return String(spec || '200-399').split(',').some((part) => {
    const [a, b] = part.split('-').map(Number);
    return b ? code >= a && code <= b : code === a;
  });
}

async function readLimited(res) {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  while (size < MAX_BODY) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  reader.cancel().catch(() => {});
  return Buffer.concat(chunks).toString('utf8');
}

export async function checkHttp(monitor, { fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const start = performance.now();
  let res;
  try {
    res = await fetch(monitor.target, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'S7-Monitor/1.0 (+uptime check)', accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
    });
  } catch (err) {
    return { status: 'down', error: describeError(err) };
  }
  const latency = Math.round(performance.now() - start);
  const data = { code: res.status, finalUrl: res.url !== monitor.target ? res.url : undefined };
  try {
    if (!codeMatches(monitor.expectedCodes, res.status)) {
      res.body?.cancel().catch(() => {});
      return { status: 'down', latency, error: `HTTP ${res.status}`, data };
    }
    if (monitor.keyword) {
      const body = await readLimited(res);
      if (!body.includes(monitor.keyword)) return { status: 'down', latency, error: 'brak słowa kluczowego', data };
    } else {
      res.body?.cancel().catch(() => {});
    }
  } catch (err) {
    return { status: 'down', latency, error: describeError(err), data };
  }
  return { status: 'up', latency, data };
}
