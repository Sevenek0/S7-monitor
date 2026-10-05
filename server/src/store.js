/**
 * Warstwa dostępu do monitorów i ich bieżącego stanu.
 */
export const TYPES = ['http', 'fivem', 'pterodactyl'];
export const DEFAULT_CODES = '200-399';

const PUBLIC_FIELDS = (row) => ({
  id: row.id,
  name: row.name,
  type: row.type,
  target: row.target,
  intervalS: row.interval_s,
  failThreshold: row.fail_threshold,
  paused: Boolean(row.paused),
  pteroServerId: row.ptero_server_id || null,
  expectedCodes: row.expected_codes || null,
  keyword: row.keyword || null,
  sort: row.sort,
  createdAt: row.created_at,
  status: row.paused ? 'paused' : (row.status || 'pending'),
  failCount: row.fail_count ?? 0,
  lastCheck: row.last_check ?? null,
  lastChange: row.last_change ?? null,
  lastError: row.last_error ?? null,
  lastLatency: row.last_latency ?? null,
  data: row.data ? JSON.parse(row.data) : null,
});

export class ValidationError extends Error {}

/** Normalizuje adres FiveM do postaci http://host:port (bez końcowego ukośnika). */
export function normalizeFivemTarget(t) {
  let s = String(t || '').trim();
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  const u = new URL(s);
  if (!u.port && u.protocol === 'http:') u.port = '30120';
  return `${u.protocol}//${u.host}`;
}

/** Waliduje i normalizuje dane monitora z formularza. `partial` = edycja. */
export function validateMonitorInput(input, existing = null) {
  const src = { ...(existing || {}), ...(input || {}) };
  const out = {};
  const name = String(src.name ?? '').trim();
  if (!name || name.length > 80) throw new ValidationError('Nazwa jest wymagana (max 80 znaków)');
  out.name = name;

  if (!TYPES.includes(src.type)) throw new ValidationError('Nieznany typ monitora');
  out.type = src.type;

  const interval = Number(src.intervalS ?? 30);
  if (!Number.isInteger(interval) || interval < 10 || interval > 3600) throw new ValidationError('Interwał musi mieć 10–3600 s');
  out.interval_s = interval;

  const thr = Number(src.failThreshold ?? 2);
  if (!Number.isInteger(thr) || thr < 1 || thr > 20) throw new ValidationError('Próg awarii musi mieć 1–20');
  out.fail_threshold = thr;

  const ptero = src.pteroServerId ? String(src.pteroServerId).trim() : '';
  if (ptero && !/^[a-zA-Z0-9-]{1,64}$/.test(ptero)) throw new ValidationError('Niepoprawne ID serwera Pterodactyl');
  out.ptero_server_id = ptero || null;

  let target = String(src.target ?? '').trim();
  if (out.type === 'http') {
    let u;
    try { u = new URL(target); } catch { throw new ValidationError('Podaj pełny adres strony, np. https://example.com'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw new ValidationError('Adres musi zaczynać się od http:// lub https://');
    target = u.toString();
  } else if (out.type === 'fivem') {
    try { target = normalizeFivemTarget(target); } catch { throw new ValidationError('Podaj adres serwera FiveM, np. http://1.2.3.4:30120'); }
  } else {
    if (!out.ptero_server_id) throw new ValidationError('Monitor Pterodactyl wymaga ID serwera');
    target = '';
  }
  out.target = target;

  const codes = src.expectedCodes ? String(src.expectedCodes).replace(/\s+/g, '') : '';
  if (codes && !/^\d{3}(-\d{3})?(,\d{3}(-\d{3})?)*$/.test(codes)) throw new ValidationError('Kody HTTP w formacie np. 200-399 lub 200,301');
  out.expected_codes = out.type === 'http' && codes ? codes : null;

  const kw = src.keyword ? String(src.keyword) : '';
  if (kw.length > 200) throw new ValidationError('Słowo kluczowe może mieć max 200 znaków');
  out.keyword = out.type === 'http' && kw ? kw : null;

  out.sort = Number.isInteger(Number(src.sort)) ? Number(src.sort) : 0;
  return out;
}

export function createStore(db) {
  const q = {
    all: db.prepare(`SELECT m.*, s.status, s.fail_count, s.last_check, s.last_change, s.last_error, s.last_latency, s.data
                     FROM monitors m LEFT JOIN monitor_state s ON s.monitor_id = m.id ORDER BY m.sort, m.id`),
    one: db.prepare(`SELECT m.*, s.status, s.fail_count, s.last_check, s.last_change, s.last_error, s.last_latency, s.data
                     FROM monitors m LEFT JOIN monitor_state s ON s.monitor_id = m.id WHERE m.id = ?`),
    insert: db.prepare(`INSERT INTO monitors (name, type, target, interval_s, fail_threshold, paused, ptero_server_id, expected_codes, keyword, sort, created_at)
                        VALUES (@name, @type, @target, @interval_s, @fail_threshold, @paused, @ptero_server_id, @expected_codes, @keyword, @sort, @created_at)`),
    insertState: db.prepare(`INSERT INTO monitor_state (monitor_id, status, last_change) VALUES (?, ?, ?)`),
    update: db.prepare(`UPDATE monitors SET name=@name, type=@type, target=@target, interval_s=@interval_s, fail_threshold=@fail_threshold,
                        ptero_server_id=@ptero_server_id, expected_codes=@expected_codes, keyword=@keyword, sort=@sort WHERE id=@id`),
    del: db.prepare(`DELETE FROM monitors WHERE id = ?`),
    setPaused: db.prepare(`UPDATE monitors SET paused = ? WHERE id = ?`),
    saveState: db.prepare(`UPDATE monitor_state SET status=@status, fail_count=@fail_count, last_check=@last_check, last_change=@last_change,
                           last_error=@last_error, last_latency=@last_latency, data=@data WHERE monitor_id=@monitor_id`),
    resetState: db.prepare(`UPDATE monitor_state SET status=?, fail_count=0, last_change=?, last_error=NULL WHERE monitor_id=?`),
  };

  return {
    list: () => q.all.all().map(PUBLIC_FIELDS),
    get(id) {
      const row = q.one.get(id);
      return row ? PUBLIC_FIELDS(row) : null;
    },
    create(input, now = Date.now()) {
      const v = validateMonitorInput(input);
      const paused = input.paused ? 1 : 0;
      const id = db.transaction(() => {
        const info = q.insert.run({ ...v, paused, created_at: now });
        q.insertState.run(info.lastInsertRowid, paused ? 'paused' : 'pending', now);
        return Number(info.lastInsertRowid);
      })();
      return this.get(id);
    },
    update(id, input) {
      const cur = this.get(id);
      if (!cur) return null;
      const v = validateMonitorInput(input, cur);
      q.update.run({ ...v, id });
      // Zmiana typu / celu → zaczynamy stan od nowa.
      if (v.type !== cur.type || v.target !== cur.target || v.ptero_server_id !== cur.pteroServerId) {
        if (!cur.paused) q.resetState.run('pending', Date.now(), id);
      }
      return this.get(id);
    },
    remove: (id) => q.del.run(id).changes > 0,
    setPaused(id, paused, now = Date.now()) {
      q.setPaused.run(paused ? 1 : 0, id);
      q.resetState.run(paused ? 'paused' : 'pending', now, id);
      return this.get(id);
    },
    saveState: (state) => q.saveState.run(state),
  };
}
