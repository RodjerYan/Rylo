package db

import (
	"database/sql"
	"fmt"
)

// ListInvites returns all invites ordered by creation time descending.
func (d *DB) ListInvites() ([]*Invite, error) {
	rows, err := d.sqlDB.Query(listInvitesBaseQuery + ` ORDER BY i.created_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("ListInvites: %w", err)
	}
	return scanInvites(rows, "ListInvites")
}

// ListInvitesByCreator returns invites created by the given user ordered by
// creation time descending.
func (d *DB) ListInvitesByCreator(createdBy int64) ([]*Invite, error) {
	rows, err := d.sqlDB.Query(
		listInvitesBaseQuery+` WHERE i.created_by = ? ORDER BY i.created_at DESC`,
		createdBy,
	)
	if err != nil {
		return nil, fmt.Errorf("ListInvitesByCreator: %w", err)
	}
	return scanInvites(rows, "ListInvitesByCreator")
}

const listInvitesBaseQuery = `SELECT i.id, i.code, i.created_by,
		 cu.username AS created_by_username,
		 i.redeemed_by,
		 ru.username AS redeemed_by_username,
		 i.max_uses, i.use_count, i.expires_at, i.revoked, i.created_at
		 FROM invites i
		 LEFT JOIN users cu ON cu.id = i.created_by
		 LEFT JOIN users ru ON ru.id = i.redeemed_by`

func scanInvites(rows *sql.Rows, op string) ([]*Invite, error) {
	defer rows.Close() //nolint:errcheck

	var invites []*Invite
	for rows.Next() {
		inv := &Invite{}
		var revoked int
		if err := rows.Scan(
			&inv.ID, &inv.Code, &inv.CreatedBy, &inv.CreatedByUsername,
			&inv.RedeemedBy, &inv.RedeemedByUsername, &inv.MaxUses,
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
