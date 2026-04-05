package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/rylo/server/api"
	"github.com/rylo/server/auth"
	"github.com/rylo/server/config"
	"github.com/rylo/server/db"
)

// buildInviteRouter returns a chi router with invite routes and auth middleware.
func buildInviteRouter(database *db.DB, limiter *auth.RateLimiter) http.Handler {
	return buildInviteRouterWithReplicator(database, limiter, nil)
}

func buildInviteRouterWithReplicator(database *db.DB, limiter *auth.RateLimiter, replicator *inviteReplicatorStub) http.Handler {
	r := chi.NewRouter()
	api.MountAuthRoutes(r, database, limiter, nil, nil, config.RegistrationConfig{})
	if replicator != nil {
		api.MountInviteRoutes(r, database, replicator)
	} else {
		api.MountInviteRoutes(r, database, nil)
	}
	return r
}

type inviteReplicatorStub struct {
	enabled bool
	sync    func(context.Context) error
	mirror  func(context.Context, *db.Invite) error
	revoke  func(context.Context, string) error
}

func (s *inviteReplicatorStub) Enabled() bool {
	if s == nil {
		return false
	}
	return s.enabled
}

func (s *inviteReplicatorStub) SyncInviteCache(ctx context.Context) error {
	if s == nil {
		return nil
	}
	if s.sync == nil {
		return nil
	}
	return s.sync(ctx)
}

func (s *inviteReplicatorStub) MirrorInvite(ctx context.Context, inv *db.Invite) error {
	if s == nil {
		return nil
	}
	if s.mirror == nil {
		return nil
	}
	return s.mirror(ctx, inv)
}

func (s *inviteReplicatorStub) RevokeInvite(ctx context.Context, code string) error {
	if s == nil {
		return nil
	}
	if s.revoke == nil {
		return nil
	}
	return s.revoke(ctx, code)
}

// loginAndGetToken creates a user with a known password and returns their session token.
func loginAndGetToken(t *testing.T, _ http.Handler, database *db.DB, username string, roleID int) string {
	t.Helper()
	hash, _ := auth.HashPassword("Password1!")
	uid, _ := database.CreateUser(username, hash, roleID)
	token, _ := auth.GenerateToken()
	_, _ = database.CreateSession(uid, auth.HashToken(token), "test", "127.0.0.1")
	return token
}

// ─── POST /api/v1/invites ─────────────────────────────────────────────────────

func TestCreateInvite_Success(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	// Admin role (id=2) has MANAGE_INVITES (0x4000000) set.
	token := loginAndGetToken(t, router, database, "invitecreator", 2)

	rr := postJSONWithToken(t, router, "/api/v1/invites", token, map[string]any{
		"max_uses":         5,
		"expires_in_hours": 48,
	})

	if rr.Code != http.StatusCreated {
		t.Errorf("CreateInvite status = %d, want 201; body = %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	if resp["code"] == nil {
		t.Error("CreateInvite response missing code")
	}
}

func TestCreateInvite_Unauthorized(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	rr := postJSON(t, router, "/api/v1/invites", map[string]any{
		"max_uses": 5,
	})

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("CreateInvite no auth status = %d, want 401", rr.Code)
	}
}

func TestCreateInvite_MemberForbidden(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	token := loginAndGetToken(t, router, database, "memberuser", 4)

	rr := postJSONWithToken(t, router, "/api/v1/invites", token, map[string]any{
		"max_uses": 1,
	})

	if rr.Code != http.StatusCreated {
		t.Errorf("CreateInvite member status = %d, want 201; body = %s", rr.Code, rr.Body.String())
	}
}

func TestCreateInvite_Unlimited(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	token := loginAndGetToken(t, router, database, "adminuser2", 2)

	rr := postJSONWithToken(t, router, "/api/v1/invites", token, map[string]any{})

	if rr.Code != http.StatusCreated {
		t.Errorf("CreateInvite unlimited status = %d, want 201", rr.Code)
	}
}

// ─── GET /api/v1/invites ──────────────────────────────────────────────────────

func TestListInvites_Success(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	token := loginAndGetToken(t, router, database, "listuser", 2)

	// Create a couple of invites.
	postJSONWithToken(t, router, "/api/v1/invites", token, map[string]any{"max_uses": 1})
	postJSONWithToken(t, router, "/api/v1/invites", token, map[string]any{"max_uses": 5})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/invites", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("ListInvites status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}

	var resp []any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	if len(resp) < 2 {
		t.Errorf("ListInvites returned %d items, want >= 2", len(resp))
	}
}

func TestListInvites_MemberSeesOwnInvitesOnly(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	memberToken := loginAndGetToken(t, router, database, "memberlist", 4)
	otherToken := loginAndGetToken(t, router, database, "othermember", 4)

	postJSONWithToken(t, router, "/api/v1/invites", memberToken, map[string]any{"max_uses": 1})
	postJSONWithToken(t, router, "/api/v1/invites", otherToken, map[string]any{"max_uses": 1})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/invites", nil)
	req.Header.Set("Authorization", "Bearer "+memberToken)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("ListInvites member status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}

	var resp []map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	if len(resp) != 1 {
		t.Fatalf("ListInvites member count = %d, want 1", len(resp))
	}
}

func TestListInvites_Unauthorized(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/invites", nil)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("ListInvites no auth status = %d, want 401", rr.Code)
	}
}

// ─── DELETE /api/v1/invites/:code ─────────────────────────────────────────────

func TestRevokeInvite_Success(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	token := loginAndGetToken(t, router, database, "revoker", 2)

	// Create invite via API.
	rr := postJSONWithToken(t, router, "/api/v1/invites", token, map[string]any{})
	if rr.Code != http.StatusCreated {
		t.Fatalf("Create invite for revoke test: status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var created map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&created)
	codeVal, ok := created["code"]
	if !ok || codeVal == nil {
		t.Fatalf("Create invite response missing code field; body parsed as %v", created)
	}
	code := codeVal.(string)

	// Revoke it.
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/invites/"+code, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr2 := httptest.NewRecorder()
	router.ServeHTTP(rr2, req)

	if rr2.Code != http.StatusNoContent {
		t.Errorf("RevokeInvite status = %d, want 204; body = %s", rr2.Code, rr2.Body.String())
	}

	// Verify invite is revoked.
	inv, _ := database.GetInvite(code)
	if inv == nil || !inv.Revoked {
		t.Error("Invite not revoked in database after DELETE")
	}
}

func TestRevokeInvite_NotFound(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	token := loginAndGetToken(t, router, database, "revoker2", 2)

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/invites/doesnotexist", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Errorf("RevokeInvite not found status = %d, want 404", rr.Code)
	}
}

func TestRevokeInvite_MemberForbiddenForForeignInvite(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	adminToken := loginAndGetToken(t, router, database, "admin3", 2)
	memberToken := loginAndGetToken(t, router, database, "member3", 4)

	// Admin creates invite.
	rr := postJSONWithToken(t, router, "/api/v1/invites", adminToken, map[string]any{})
	var created map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&created)
	code := created["code"].(string)

	// Member tries to revoke.
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/invites/"+code, nil)
	req.Header.Set("Authorization", "Bearer "+memberToken)
	req.RemoteAddr = "127.0.0.1:9999"
	rr2 := httptest.NewRecorder()
	router.ServeHTTP(rr2, req)

	if rr2.Code != http.StatusForbidden {
		t.Errorf("RevokeInvite member status = %d, want 403", rr2.Code)
	}
}

func TestRevokeInvite_MemberCanRevokeOwnInvite(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	memberToken := loginAndGetToken(t, router, database, "memberrevoke", 4)

	rr := postJSONWithToken(t, router, "/api/v1/invites", memberToken, map[string]any{})
	if rr.Code != http.StatusCreated {
		t.Fatalf("Create invite for member revoke test: status = %d, body = %s", rr.Code, rr.Body.String())
	}

	var created map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&created)
	code := created["code"].(string)

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/invites/"+code, nil)
	req.Header.Set("Authorization", "Bearer "+memberToken)
	req.RemoteAddr = "127.0.0.1:9999"
	rr2 := httptest.NewRecorder()
	router.ServeHTTP(rr2, req)

	if rr2.Code != http.StatusNoContent {
		t.Fatalf("RevokeInvite own member status = %d, want 204; body = %s", rr2.Code, rr2.Body.String())
	}
}

// TestListInvites_IncludesRevokedAndActive checks the list endpoint returns
// correct data for both revoked and active invites.
func TestListInvites_IncludesRevokedAndActive(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	token := loginAndGetToken(t, router, database, "listall", 2)

	// Create and revoke one invite.
	rr := postJSONWithToken(t, router, "/api/v1/invites", token, map[string]any{})
	if rr.Code != http.StatusCreated {
		t.Fatalf("Create invite for list test: status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var created map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&created)
	code := created["code"].(string)

	delReq := httptest.NewRequest(http.MethodDelete, "/api/v1/invites/"+code, nil)
	delReq.Header.Set("Authorization", "Bearer "+token)
	delReq.RemoteAddr = "127.0.0.1:9999"
	httptest.NewRecorder() // discard
	router.ServeHTTP(httptest.NewRecorder(), delReq)

	// Create one active invite.
	postJSONWithToken(t, router, "/api/v1/invites", token, map[string]any{})

	// List should include both.
	req := httptest.NewRequest(http.MethodGet, "/api/v1/invites", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr2 := httptest.NewRecorder()
	router.ServeHTTP(rr2, req)

	if rr2.Code != http.StatusOK {
		t.Errorf("ListInvites status = %d, want 200", rr2.Code)
	}
}

func TestListInvites_SyncsRemoteCacheBeforeQuery(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	var ownerID int64
	replicator := &inviteReplicatorStub{
		enabled: true,
		sync: func(context.Context) error {
			return database.UpsertInviteSnapshot(&db.Invite{
				Code:      "remote1234",
				CreatedBy: ownerID,
				MaxUses:   intPtr(1),
				Uses:      0,
				Revoked:   false,
				CreatedAt: "2026-04-05T10:00:00Z",
			})
		},
	}
	router := buildInviteRouterWithReplicator(database, limiter, replicator)

	token := loginAndGetToken(t, router, database, "syncedowner", 4)
	owner, err := database.GetUserByUsername("syncedowner")
	if err != nil || owner == nil {
		t.Fatalf("GetUserByUsername syncedowner: %v", err)
	}
	ownerID = owner.ID

	req := httptest.NewRequest(http.MethodGet, "/api/v1/invites", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("ListInvites synced status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}

	var resp []inviteResponseDTO
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("Decode synced invites response: %v", err)
	}
	if len(resp) != 1 {
		t.Fatalf("ListInvites synced count = %d, want 1", len(resp))
	}
	if resp[0].Code != "remote1234" {
		t.Fatalf("ListInvites synced code = %q, want %q", resp[0].Code, "remote1234")
	}
}

func TestRevokeInvite_SyncsRemoteCacheBeforeDelete(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	var ownerID int64
	var remoteRevokeCode string
	replicator := &inviteReplicatorStub{
		enabled: true,
		sync: func(context.Context) error {
			return database.UpsertInviteSnapshot(&db.Invite{
				Code:      "remote-revoke",
				CreatedBy: ownerID,
				MaxUses:   intPtr(1),
				Uses:      0,
				Revoked:   false,
				CreatedAt: "2026-04-05T10:00:00Z",
			})
		},
		revoke: func(_ context.Context, code string) error {
			remoteRevokeCode = code
			return nil
		},
	}
	router := buildInviteRouterWithReplicator(database, limiter, replicator)

	token := loginAndGetToken(t, router, database, "revokeowner", 4)
	owner, err := database.GetUserByUsername("revokeowner")
	if err != nil || owner == nil {
		t.Fatalf("GetUserByUsername revokeowner: %v", err)
	}
	ownerID = owner.ID

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/invites/remote-revoke", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusNoContent {
		t.Fatalf("RevokeInvite synced status = %d, want 204; body = %s", rr.Code, rr.Body.String())
	}

	inv, err := database.GetInvite("remote-revoke")
	if err != nil {
		t.Fatalf("GetInvite remote-revoke: %v", err)
	}
	if inv == nil || !inv.Revoked {
		t.Fatal("remote invite was not revoked locally after sync")
	}
	if remoteRevokeCode != "remote-revoke" {
		t.Fatalf("remote revoke code = %q, want %q", remoteRevokeCode, "remote-revoke")
	}
}

type inviteResponseDTO struct {
	Code string `json:"code"`
}

func intPtr(v int) *int {
	return &v
}
