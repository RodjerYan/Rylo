package db

import (
	"fmt"
	"strings"
)

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

// DeleteInvitesExcept removes local invite snapshots that no longer exist in
// Yandex Disk. When invite replication is enabled, the cloud folder is the
// source of truth for deleted invites.
func (d *DB) DeleteInvitesExcept(codes []string) error {
	normalized := make([]string, 0, len(codes))
	seen := make(map[string]struct{}, len(codes))
	for _, code := range codes {
		code = strings.TrimSpace(code)
		if code == "" {
			continue
		}
		if _, ok := seen[code]; ok {
			continue
		}
		seen[code] = struct{}{}
		normalized = append(normalized, code)
	}

	if len(normalized) == 0 {
		if _, err := d.sqlDB.Exec(`DELETE FROM invites`); err != nil {
			return fmt.Errorf("DeleteInvitesExcept empty: %w", err)
		}
		return nil
	}

	placeholders := strings.TrimRight(strings.Repeat("?,", len(normalized)), ",")
	args := make([]any, len(normalized))
	for i, code := range normalized {
		args[i] = code
	}
	if _, err := d.sqlDB.Exec(`DELETE FROM invites WHERE code NOT IN (`+placeholders+`)`, args...); err != nil {
		return fmt.Errorf("DeleteInvitesExcept: %w", err)
	}
	return nil
}
