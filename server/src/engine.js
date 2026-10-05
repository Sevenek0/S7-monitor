import { runChecker } from './checkers/index.js';

/**
 * Silnik stanów: zapisuje pomiary, liczy porażki z rzędu, otwiera/zamyka incydenty
 * i emituje zdarzenia na szynę:
 *   'monitor'    — nowy stan monitora (po każdym sprawdzeniu)
 *   'check'      — surowy pomiar {monitorId, ts, ok, latency, players, cpu, mem}
 *   'transition' — przejście UP↔DOWN {monitor, from, to, reason, downtimeMs}
 */
export function createEngine({ db, store, bus, ctx = {} }) {
  const q = {
    insertCheck: db.prepare(`INSERT INTO checks (monitor_id, ts, ok, latency_ms, players, cpu, mem_bytes)
                             VALUES (?, ?, ?, ?, ?, ?, ?)`),
    openIncident: db.prepare(`SELECT * FROM incidents WHERE monitor_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`),
    startIncident: db.prepare(`INSERT INTO incidents (monitor_id, started_at, reason) VALUES (?, ?, ?)`),
    endIncident: db.prepare(`UPDATE incidents SET ended_at = ? WHERE id = ?`),
    endAllOpen: db.prepare(`UPDATE incidents SET ended_at = ? WHERE monitor_id = ? AND ended_at IS NULL`),
  };

  /** Stosuje wynik sprawdzenia do stanu monitora. Zwraca zaktualizowany monitor. */
  const applyResult = db.transaction((monitor, result, ts) => {
    const ok = result.status !== 'down';
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    q.insertCheck.run(monitor.id, ts, ok ? 1 : 0, ok ? num(result.latency) : null, num(result.players), num(result.cpu), num(result.mem));

    const prev = monitor.status;
    let status = prev;
    let failCount = monitor.failCount;
    let transition = null;
    const reason = result.error || null;

    if (!ok) {
      failCount += 1;
      if (prev !== 'down' && failCount >= monitor.failThreshold) {
        status = 'down';
        if (!q.openIncident.get(monitor.id)) q.startIncident.run(monitor.id, ts, reason);
        transition = { from: prev, to: 'down', reason };
      }
    } else {
      failCount = 0;
      status = result.status; // 'up' lub 'warn'
      if (status === 'up') {
        const inc = q.openIncident.get(monitor.id);
        if (inc) {
          q.endIncident.run(ts, inc.id);
          transition = { from: prev, to: 'up', reason: null, downtimeMs: ts - inc.started_at };
        }
      }
    }

    // Dane szczegółowe: przy porażce zachowujemy ostatnie dobre (np. limity), ale czyścimy listę graczy.
    let data = result.data ?? null;
    if (!ok && !data && monitor.data) data = { ...monitor.data, stale: true, players: [] };

    store.saveState({
      monitor_id: monitor.id,
      status,
      fail_count: failCount,
      last_check: ts,
      last_change: status !== prev ? ts : monitor.lastChange,
      last_error: ok && status === 'up' ? null : reason,
      last_latency: ok ? num(result.latency) : null,
      data: data ? JSON.stringify(data) : null,
    });
    return { transition };
  });

  async function check(monitorId) {
    const monitor = store.get(monitorId);
    if (!monitor || monitor.paused) return null;
    const result = await runChecker(monitor, ctx);
    const ts = (ctx.now || Date.now)();
    // Monitor mógł zostać usunięty lub wstrzymany w trakcie sprawdzania.
    const fresh = store.get(monitorId);
    if (!fresh || fresh.paused) return null;
    const { transition } = applyResult(fresh, result, ts);
    const updated = store.get(monitorId);
    bus?.emit('check', {
      monitorId, ts, ok: result.status !== 'down', status: updated.status,
      latency: result.latency ?? null, players: result.players ?? null, cpu: result.cpu ?? null, mem: result.mem ?? null,
    });
    bus?.emit('monitor', updated);
    if (transition) bus?.emit('transition', { monitor: updated, ...transition, ts });
    return { monitor: updated, result, transition };
  }

  function closeIncidents(monitorId, ts = Date.now()) {
    q.endAllOpen.run(ts, monitorId);
  }

  return { check, applyResult, closeIncidents };
}
