import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS monitors (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,
  type            TEXT    NOT NULL CHECK (type IN ('http','fivem','pterodactyl')),
  target          TEXT    NOT NULL DEFAULT '',
  interval_s      INTEGER NOT NULL DEFAULT 30,
  fail_threshold  INTEGER NOT NULL DEFAULT 2,
  paused          INTEGER NOT NULL DEFAULT 0,
  ptero_server_id TEXT,
  expected_codes  TEXT,
  keyword         TEXT,
  sort            INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS monitor_state (
  monitor_id     INTEGER PRIMARY KEY REFERENCES monitors(id) ON DELETE CASCADE,
  status         TEXT    NOT NULL DEFAULT 'pending',
  fail_count     INTEGER NOT NULL DEFAULT 0,
  last_check     INTEGER,
  last_change    INTEGER,
  last_error     TEXT,
  last_latency   INTEGER,
  data           TEXT
);

CREATE TABLE IF NOT EXISTS checks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id  INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  ts          INTEGER NOT NULL,
  ok          INTEGER NOT NULL,
  latency_ms  INTEGER,
  players     INTEGER,
  cpu         REAL,
  mem_bytes   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_checks_monitor_ts ON checks (monitor_id, ts);

CREATE TABLE IF NOT EXISTS incidents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id  INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  reason      TEXT
);
CREATE INDEX IF NOT EXISTS idx_incidents_monitor ON incidents (monitor_id, started_at);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint    TEXT PRIMARY KEY,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  user_agent  TEXT,
  created_at  INTEGER NOT NULL
);
`;

export function openDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
