package db

import (
	"database/sql"
	"fmt"
)

// ListInvites returns all invites ordered by creation time descending.
func (d *DB) ListInvites() ([]*Invite, error) {
	rows, err := d.sqlDB.Query(listInvitesBaseQuery + ` ORDER BY created_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("ListInvites: %w", err)
	}
	return scanInvites(rows, "ListInvites")
}

// ListInvitesByCreator returns invites created by the given user ordered by
// creation time descending.
func (d *DB) ListInvitesByCreator(createdBy int64) ([]*Invite, error) {
	rows, err := d.sqlDB.Query(
		listInvitesBaseQuery+` WHERE created_by = ? ORDER BY created_at DESC`,
		createdBy,
	)
	if err != nil {
		return nil, fmt.Errorf("ListInvitesByCreator: %w", err)
	}
	return scanInvites(rows, "ListInvitesByCreator")
}

const listInvitesBaseQuery = `SELECT id, code, created_by, max_uses, use_count, expires_at, revoked, created_at
		 FROM invites`

func scanInvites(rows *sql.Rows, op string) ([]*Invite, error) {
	defer rows.Close() //nolint:errcheck

	var invites []*Invite
	for rows.Next() {
		inv := &Invite{}
		var revoked int
		if err := rows.Scan(
			&inv.ID, &inv.Code, &inv.CreatedBy, &inv.MaxUses,
			&inv.Uses, &inv.ExpiresAt, &revoked, &inv.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("ListInvites scan: %w", err)
		}
		inv.Revoked = revoked != 0
		invites = append(invites, inv)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%s rows: %w", op, err)
	}
	if invites == nil {
		invites = []*Invite{}
	}
	return invites, nil
}
