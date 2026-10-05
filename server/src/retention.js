/** Sprzątanie starych pomiarów (domyślnie 30 dni), raz na dobę. */
export function createRetention({ db, days = 30, log = console }) {
  const delChecks = db.prepare('DELETE FROM checks WHERE ts < ?');
  const delIncidents = db.prepare('DELETE FROM incidents WHERE ended_at IS NOT NULL AND ended_at < ?');
  let timer = null;

  function run(now = Date.now()) {
    const cutoff = now - days * 24 * 3600e3;
    const c = delChecks.run(cutoff).changes;
    const i = delIncidents.run(now - 3 * days * 24 * 3600e3).changes;
    if (c || i) log.log?.(`[retencja] Usunięto ${c} pomiarów i ${i} incydentów`);
    return { checks: c, incidents: i };
  }

  return {
    run,
    start() {
      run();
      timer = setInterval(run, 24 * 3600e3);
      timer.unref?.();
    },
    stop() { clearInterval(timer); },
  };
}
