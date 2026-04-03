-- Migration 011: Stable sync identifiers for cross-device message replication.

ALTER TABLE messages ADD COLUMN sync_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_sync_id ON messages(sync_id);
