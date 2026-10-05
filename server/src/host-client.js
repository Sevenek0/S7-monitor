import http from 'node:http';

/**
 * Klient S7 Agenta (agent/s7-agent.mjs) — pomocnika działającego na VPS-ie.
 * Łączy się przez gniazdo uniksowe (S7_AGENT_SOCKET) albo adres HTTP (S7_AGENT_URL, testy).
 */
export function createHostClient({ socketPath = '', url = '', timeoutMs = 20_000 } = {}) {
  const enabled = Boolean(socketPath || url);
  const base = url ? new URL(url) : null;
  const target = (path) => (base
    ? { host: base.hostname, port: base.port, path }
    : { socketPath, path });

  function request(method, path) {
    return new Promise((resolve, reject) => {
      if (!enabled) { reject(Object.assign(new Error('Agent serwera nie jest skonfigurowany'), { status: 503 })); return; }
      const req = http.request({ ...target(path), method, timeout: timeoutMs }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          let data = null;
          try { data = JSON.parse(body); } catch { /* brak treści */ }
          if (res.statusCode >= 400) { reject(Object.assign(new Error(data?.error || `agent: HTTP ${res.statusCode}`), { status: res.statusCode })); return; }
          resolve(data);
        });
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('Agent serwera nie odpowiada (timeout)'), { status: 504 })));
      req.on('error', (err) => reject(Object.assign(new Error(err.status ? err.message : 'Agent serwera nie odpowiada'), { status: err.status || 503 })));
      req.end();
    });
  }

  /** Strumień NDJSON: wywołuje onEntry dla każdej linii. Zwraca funkcję zamykającą. */
  function stream(path, { onEntry, onEnd }) {
    let done = false;
    const finish = (err) => { if (!done) { done = true; onEnd?.(err); } };
    const req = http.request({ ...target(path), method: 'GET' }, (res) => {
      if (res.statusCode !== 200) { res.resume(); finish(Object.assign(new Error(`agent: HTTP ${res.statusCode}`), { status: res.statusCode })); return; }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line) continue;
          try { onEntry(JSON.parse(line)); } catch { /* uszkodzona linia */ }
        }
      });
      res.on('end', () => finish());
      res.on('error', finish);
    });
    req.on('error', (err) => finish(Object.assign(new Error('Agent serwera nie odpowiada'), { status: 503, cause: err })));
    req.end();
    return () => { done = true; req.destroy(); };
  }

  return {
    enabled,
    get: (path) => request('GET', path),
    post: (path) => request('POST', path),
    stream,
  };
}
