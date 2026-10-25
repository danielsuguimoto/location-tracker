-- Adds webhook endpoint ownership. Run once against databases created before
-- this change (fresh databases already have the column via schema.sql):
--   wrangler d1 execute location-tracker-db --remote --file migrations/0001_webhooks_client_id.sql
ALTER TABLE webhooks ADD COLUMN client_id TEXT NOT NULL DEFAULT 'admin';
