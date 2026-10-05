/**
 * Scheduler: co `tickMs` wybiera monitory, którym minął interwał, i odpala
 * sprawdzenia z limitem równoległości.
 */
export function createScheduler({ store, engine, tickMs = 5000, concurrency = 8, now = Date.now, log = console }) {
  const lastRun = new Map();
  const running = new Set();
  const queue = [];
  let timer = null;

  function pump() {
    while (running.size < concurrency && queue.length) {
      const id = queue.shift();
      running.add(id);
      engine.check(id)
        .catch((err) => log.error?.(`[scheduler] Błąd monitora ${id}:`, err))
        .finally(() => { running.delete(id); pump(); });
    }
  }

  function tick() {
    const t = now();
    for (const m of store.list()) {
      if (m.paused || running.has(m.id) || queue.includes(m.id)) continue;
      const last = lastRun.get(m.id) ?? 0;
      if (t - last >= m.intervalS * 1000) {
        lastRun.set(m.id, t);
        queue.push(m.id);
      }
    }
    pump();
  }

  return {
    start() {
      if (timer) return;
      tick();
      timer = setInterval(tick, tickMs);
      timer.unref?.();
    },
    stop() { clearInterval(timer); timer = null; },
    tick,
    /** Wymusza sprawdzenie przy najbliższym ticku (np. po edycji/wznowieniu). */
    reset(id) { lastRun.delete(id); },
    get running() { return running.size; },
    get queued() { return queue.length; },
  };
}
