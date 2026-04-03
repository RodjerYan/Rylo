package db

import "fmt"

// HasProcessedSyncEvent reports whether a remote event path has already been imported.
func (d *DB) HasProcessedSyncEvent(remotePath string) (bool, error) {
	var path string
	err := d.sqlDB.QueryRow(
		`SELECT remote_path FROM sync_events WHERE remote_path = ?`,
		remotePath,
	).Scan(&path)
	if err != nil {
		return false, nil
	}
	return true, nil
}

// MarkSyncEventProcessed records a successfully imported remote event.
func (d *DB) MarkSyncEventProcessed(remotePath, eventID string) error {
	_, err := d.sqlDB.Exec(
		`INSERT OR REPLACE INTO sync_events (remote_path, event_id, processed_at)
		 VALUES (?, ?, datetime('now'))`,
		remotePath, eventID,
	)
	if err != nil {
		return fmt.Errorf("MarkSyncEventProcessed: %w", err)
	}
	return nil
}

// DeleteAttachmentRecord removes an attachment row by ID.
func (d *DB) DeleteAttachmentRecord(id string) error {
	_, err := d.sqlDB.Exec(`DELETE FROM attachments WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("DeleteAttachmentRecord: %w", err)
	}
	return nil
}
