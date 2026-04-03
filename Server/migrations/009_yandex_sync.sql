-- Migration 009: Tracking table for imported Yandex Disk events.

CREATE TABLE IF NOT EXISTS sync_events (
    remote_path  TEXT PRIMARY KEY,
    event_id     TEXT NOT NULL,
    processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_events_event_id ON sync_events(event_id);
