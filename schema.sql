CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device TEXT,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  acc REAL,
  alt REAL,
  vel REAL,
  cog REAL,
  batt REAL,
  trigger TEXT,
  tst INTEGER NOT NULL,
  received_at INTEGER NOT NULL DEFAULT (unixepoch()),
  raw TEXT
);

CREATE INDEX IF NOT EXISTS idx_locations_id_desc ON locations(id DESC);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

INSERT OR IGNORE INTO meta (key, value) VALUES ('last_tst', 0);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  token TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS geofences (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  radius_m REAL NOT NULL,
  on_enter INTEGER NOT NULL DEFAULT 1,
  on_exit INTEGER NOT NULL DEFAULT 1,
  webhook_id TEXT NOT NULL REFERENCES webhooks(id),
  last_state TEXT,
  last_fired_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_geofences_client ON geofences(client_id);

CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  geofence_id TEXT NOT NULL,
  event TEXT NOT NULL,
  payload TEXT,
  http_status INTEGER,
  error TEXT,
  attempted_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_deliveries_geofence ON deliveries(geofence_id, id DESC);
