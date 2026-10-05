/**
 * Agregacja historii w SQL do kubełków czasowych.
 */
export const RANGES = {
  '24h': { span: 24 * 3600e3, bucket: 5 * 60e3 },
  '7d': { span: 7 * 24 * 3600e3, bucket: 3600e3 },
  '30d': { span: 30 * 24 * 3600e3, bucket: 6 * 3600e3 },
};

export function createHistory(db) {
  const q = {
    buckets: db.prepare(`
      SELECT (ts / CAST(@bucket AS INTEGER)) * CAST(@bucket AS INTEGER) AS t,
             COUNT(*)            AS n,
             AVG(ok)             AS up,
             AVG(latency_ms)     AS lat,
             MAX(players)        AS pl,
             AVG(cpu)            AS cpu,
             AVG(mem_bytes)      AS mem
      FROM checks WHERE monitor_id = @id AND ts >= @from
      GROUP BY t ORDER BY t`),
    summary: db.prepare(`SELECT COUNT(*) AS n, AVG(ok) AS up, AVG(latency_ms) AS lat, MAX(players) AS pl, AVG(cpu) AS cpu, MAX(mem_bytes) AS mem
                         FROM checks WHERE monitor_id = @id AND ts >= @from`),
    spark: db.prepare(`
      SELECT monitor_id AS id, (ts / CAST(@bucket AS INTEGER)) * CAST(@bucket AS INTEGER) AS t, AVG(ok) AS up, AVG(latency_ms) AS lat, MAX(players) AS pl, AVG(cpu) AS cpu
      FROM checks WHERE ts >= @from GROUP BY monitor_id, t ORDER BY monitor_id, t`),
    uptimeAll: db.prepare(`SELECT monitor_id AS id, AVG(ok) AS up FROM checks WHERE ts >= @from GROUP BY monitor_id`),
    incidents: db.prepare(`SELECT id, started_at, ended_at, reason FROM incidents WHERE monitor_id = ? ORDER BY started_at DESC LIMIT ?`),
    recentIncidents: db.prepare(`SELECT i.id, i.monitor_id, m.name, i.started_at, i.ended_at, i.reason FROM incidents i
                                 JOIN monitors m ON m.id = i.monitor_id ORDER BY i.started_at DESC LIMIT ?`),
  };

  const round = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
  const pct = (v) => (v == null ? null : Math.round(v * 10000) / 100);

  return {
    get(id, range = '24h', now = Date.now()) {
      const r = RANGES[range];
      if (!r) throw new Error('Nieznany zakres');
      const from = Math.floor((now - r.span) / r.bucket) * r.bucket;
      const rows = q.buckets.all({ id, from, bucket: r.bucket });
      const s = q.summary.get({ id, from });
      return {
        range, bucketMs: r.bucket, from, to: now,
        summary: { checks: s.n, uptime: pct(s.up), avgLatency: round(s.lat, 0), maxPlayers: s.pl, avgCpu: round(s.cpu), maxMem: s.mem },
        buckets: rows.map((b) => ({ t: b.t, n: b.n, up: pct(b.up), lat: round(b.lat, 0), pl: b.pl, cpu: round(b.cpu), mem: b.mem == null ? null : Math.round(b.mem) })),
      };
    },
    /** Sparkline (24 h, kubełki 30 min) i uptime 24 h dla wszystkich monitorów naraz. */
    overview(now = Date.now()) {
      const bucket = 30 * 60e3;
      const from = Math.floor((now - 24 * 3600e3) / bucket) * bucket;
      const out = {};
      for (const r of q.uptimeAll.all({ from })) out[r.id] = { uptime: pct(r.up), spark: [] };
      for (const r of q.spark.all({ from, bucket })) {
        (out[r.id] ||= { uptime: null, spark: [] }).spark.push({ t: r.t, up: pct(r.up), lat: round(r.lat, 0), pl: r.pl, cpu: round(r.cpu) });
      }
      return { from, bucketMs: bucket, monitors: out };
    },
    incidents(id, limit = 20, now = Date.now()) {
      return q.incidents.all(id, limit).map((i) => ({
        id: i.id, startedAt: i.started_at, endedAt: i.ended_at, reason: i.reason,
        durationMs: (i.ended_at ?? now) - i.started_at, ongoing: i.ended_at == null,
      }));
    },
    recentIncidents(limit = 10, now = Date.now()) {
      return q.recentIncidents.all(limit).map((i) => ({
        id: i.id, monitorId: i.monitor_id, name: i.name, startedAt: i.started_at, endedAt: i.ended_at, reason: i.reason,
        durationMs: (i.ended_at ?? now) - i.started_at, ongoing: i.ended_at == null,
      }));
    },
  };
}
