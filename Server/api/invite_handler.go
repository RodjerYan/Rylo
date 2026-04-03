package api

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/rylo/server/db"
	"github.com/rylo/server/permissions"
	"github.com/rylo/server/replication"
)

// createInviteRequest is the JSON body for POST /api/v1/invites.
type createInviteRequest struct {
	MaxUses        int `json:"max_uses"`
	ExpiresInHours int `json:"expires_in_hours"`
}

// inviteResponse is the API shape for an invite.
type inviteResponse struct {
	ID         int64        `json:"id"`
	Code       string       `json:"code"`
	MaxUses    *int         `json:"max_uses"`
	Uses       int          `json:"uses"`
	UseCount   int          `json:"use_count"`
	ExpiresAt  *string      `json:"expires_at"`
	Revoked    bool         `json:"revoked"`
	Status     string       `json:"status"`
	CreatedBy  *inviteActor `json:"created_by,omitempty"`
	RedeemedBy *inviteActor `json:"redeemed_by,omitempty"`
	CreatedAt  string       `json:"created_at"`
}

type inviteActor struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
}

// MountInviteRoutes registers invite endpoints on the given router.
// All routes require authentication. Any authenticated user can create invites,
// while elevated users can manage every invite on the server.
func MountInviteRoutes(r chi.Router, database *db.DB, replicator *replication.Replicator) {
	r.Route("/api/v1/invites", func(r chi.Router) {
		r.Use(AuthMiddleware(database))

		r.Post("/", handleCreateInvite(database, replicator))
		r.Get("/", handleListInvites(database))
		r.Delete("/{code}", handleRevokeInvite(database, replicator))
	})
}

// handleCreateInvite processes POST /api/v1/invites.
func handleCreateInvite(database *db.DB, replicator *replication.Replicator) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req createInviteRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			// An empty body is valid (all fields optional), but malformed
			// JSON must be rejected so callers notice typos.
			if err != io.EOF {
				writeJSON(w, http.StatusBadRequest, errorResponse{
					Error:   "BAD_REQUEST",
					Message: "malformed JSON body",
				})
				return
			}
			req = createInviteRequest{}
		}

		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "not authenticated",
			})
			return
		}

		var expiresAt *time.Time
		if req.MaxUses <= 0 {
			req.MaxUses = 1
		}
		if req.ExpiresInHours > 0 {
			t := time.Now().Add(time.Duration(req.ExpiresInHours) * time.Hour)
			expiresAt = &t
		}

		code, err := database.CreateInvite(user.ID, req.MaxUses, expiresAt)
		if err != nil {
			slog.Error("handleCreateInvite CreateInvite", "err", err, "user_id", user.ID)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to create invite",
			})
			return
		}

		inv, err := database.GetInvite(code)
		if err != nil || inv == nil {
			slog.Error("handleCreateInvite GetInvite", "err", err, "code", code)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to retrieve invite",
			})
			return
		}
		if replicator != nil && replicator.Enabled() {
			if err := replicator.MirrorInvite(r.Context(), inv); err != nil {
				_ = database.RevokeInvite(code)
				slog.Error("handleCreateInvite MirrorInvite", "err", err, "code", code)
				writeJSON(w, http.StatusInternalServerError, errorResponse{
					Error:   "SERVER_ERROR",
					Message: "failed to replicate invite to Yandex Disk",
				})
				return
			}
		}

		writeJSON(w, http.StatusCreated, toInviteResponse(inv))
	}
}

// handleListInvites processes GET /api/v1/invites.
func handleListInvites(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "not authenticated",
			})
			return
		}

		role, _ := r.Context().Value(RoleKey).(*db.Role)

		var (
			invites []*db.Invite
			err     error
		)
		if canManageAnyInvites(role) {
			invites, err = database.ListInvites()
		} else {
			invites, err = database.ListInvitesByCreator(user.ID)
		}
		if err != nil {
			slog.Error("handleListInvites ListInvites", "err", err)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to list invites",
			})
			return
		}

		resp := make([]inviteResponse, 0, len(invites))
		for _, inv := range invites {
			resp = append(resp, toInviteResponse(inv))
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

// handleRevokeInvite processes DELETE /api/v1/invites/:code.
func handleRevokeInvite(database *db.DB, replicator *replication.Replicator) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		code := chi.URLParam(r, "code")
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "not authenticated",
			})
			return
		}
		role, _ := r.Context().Value(RoleKey).(*db.Role)

		inv, err := database.GetInvite(code)
		if err != nil {
			slog.Error("handleRevokeInvite GetInvite", "err", err, "code", code)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to look up invite",
			})
			return
		}
		if inv == nil {
			writeJSON(w, http.StatusNotFound, errorResponse{
				Error:   "NOT_FOUND",
				Message: "invite not found",
			})
			return
		}
		if !canManageAnyInvites(role) && inv.CreatedBy != user.ID {
			writeJSON(w, http.StatusForbidden, errorResponse{
				Error:   "FORBIDDEN",
				Message: "insufficient permissions",
			})
			return
		}

		if err := database.RevokeInvite(code); err != nil {
			slog.Error("handleRevokeInvite RevokeInvite", "err", err, "code", code)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to revoke invite",
			})
			return
		}
		if replicator != nil && replicator.Enabled() {
			if err := replicator.RevokeInvite(r.Context(), code); err != nil {
				slog.Error("handleRevokeInvite RevokeInvite remote", "err", err, "code", code)
			}
		}

		w.WriteHeader(http.StatusNoContent)
	}
}

func canManageAnyInvites(role *db.Role) bool {
	if role == nil {
		return false
	}
	if permissions.HasAdmin(role.Permissions) {
		return true
	}
	return permissions.HasPerm(role.Permissions, permissions.ManageInvites)
}

// toInviteResponse converts a db.Invite to the API response shape.
func toInviteResponse(inv *db.Invite) inviteResponse {
	var maxUses *int
	if inv.MaxUses != nil {
		v := *inv.MaxUses
		maxUses = &v
	}
	var createdBy *inviteActor
	if inv.CreatedByUsername != nil {
		createdBy = &inviteActor{
			ID:       inv.CreatedBy,
			Username: *inv.CreatedByUsername,
		}
	}
	var redeemedBy *inviteActor
	if inv.RedeemedBy != nil && inv.RedeemedByUsername != nil {
		redeemedBy = &inviteActor{
			ID:       *inv.RedeemedBy,
			Username: *inv.RedeemedByUsername,
		}
	}

	status := "active"
	if inv.ExpiresAt != nil {
		if expiresAt, err := parseInviteTime(*inv.ExpiresAt); err == nil && !expiresAt.After(time.Now().UTC()) {
			status = "expired"
		}
	}
	if inv.Uses > 0 && inv.Revoked {
		status = "used"
	} else if inv.Revoked {
		status = "revoked"
	}

	return inviteResponse{
		ID:         inv.ID,
		Code:       inv.Code,
		MaxUses:    maxUses,
		Uses:       inv.Uses,
		UseCount:   inv.Uses,
		ExpiresAt:  inv.ExpiresAt,
		Revoked:    inv.Revoked,
		Status:     status,
		CreatedBy:  createdBy,
		RedeemedBy: redeemedBy,
		CreatedAt:  inv.CreatedAt,
	}
}

func parseInviteTime(v string) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339, v); err == nil {
		return t, nil
	}
	return time.Parse("2006-01-02 15:04:05", v)
}
