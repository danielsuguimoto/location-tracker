-- Adds contextual geofence actions. Run once against databases created before
-- this change (fresh databases already have the table via schema.sql):
--   wrangler d1 execute location-tracker-db --remote --file migrations/0002_geofence_actions.sql
CREATE TABLE IF NOT EXISTS geofence_actions (
  id TEXT PRIMARY KEY,
  geofence_id TEXT NOT NULL REFERENCES geofences(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK (trigger IN ('enter', 'exit')),
  action_type TEXT NOT NULL DEFAULT 'remind',
  message TEXT NOT NULL,
  schedule_type TEXT NOT NULL CHECK (schedule_type IN ('once', 'always', 'until')),
  expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'expired')),
  last_triggered_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_geofence_actions_geofence ON geofence_actions(geofence_id, status);
