package db

import "fmt"

// UpsertInviteSnapshot stores the latest remote invite snapshot locally so it
// can be listed and managed on this device as well.
func (d *DB) UpsertInviteSnapshot(inv *Invite) error {
	if inv == nil {
		return nil
	}

	_, err := d.sqlDB.Exec(
		`INSERT INTO invites (code, created_by, redeemed_by, max_uses, use_count, expires_at, created_at, revoked)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(code) DO UPDATE SET
		     created_by = excluded.created_by,
		     redeemed_by = COALESCE(excluded.redeemed_by, invites.redeemed_by),
		     max_uses = excluded.max_uses,
		     use_count = excluded.use_count,
		     expires_at = excluded.expires_at,
		     created_at = excluded.created_at,
		     revoked = excluded.revoked`,
		inv.Code,
		inv.CreatedBy,
		inv.RedeemedBy,
		inv.MaxUses,
		inv.Uses,
		inv.ExpiresAt,
		inv.CreatedAt,
		boolToSQLiteInt(inv.Revoked),
	)
	if err != nil {
		return fmt.Errorf("UpsertInviteSnapshot: %w", err)
	}
	return nil
}

func boolToSQLiteInt(v bool) int {
	if v {
		return 1
	}
	return 0
}
