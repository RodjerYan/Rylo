package api

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/microcosm-cc/bluemonday"
	"github.com/rylo/server/auth"
	"github.com/rylo/server/config"
	"github.com/rylo/server/db"
	"github.com/rylo/server/permissions"
	"github.com/rylo/server/replication"
)

// sanitizer strips all HTML from user-supplied strings before storage.
var sanitizer = bluemonday.StrictPolicy()

// genericAuthError is returned for all login/register failures to avoid
// revealing whether a username exists.
var genericAuthError = errorResponse{
	Error:   "INVALID_CREDENTIALS",
	Message: "invalid invite or credentials",
}

// registerRequest is the JSON body for POST /api/v1/auth/register.
type registerRequest struct {
	Username   string `json:"username"`
	Password   string `json:"password"`
	InviteCode string `json:"invite_code"`
	Email      string `json:"email"`
	AdminCode  string `json:"admin_code"`
}

// loginRequest is the JSON body for POST /api/v1/auth/login.
type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type verifyTotpRequest struct {
	Code string `json:"code"`
}

type passwordConfirmationRequest struct {
	Password string `json:"password"`
}

type totpConfirmationRequest struct {
	Password string `json:"password"`
	Code     string `json:"code"`
}

type updateProfileRequest struct {
	Username *string `json:"username"`
	Avatar   *string `json:"avatar"`
	Banner   *string `json:"banner"`
}

// userResponse is the user shape included in auth responses.
type userResponse struct {
	ID          int64  `json:"id"`
	ProfileID   int64  `json:"profile_id"`
	Username    string `json:"username"`
	Avatar      string `json:"avatar,omitempty"`
	Banner      string `json:"banner,omitempty"`
	Status      string `json:"status"`
	RoleID      int64  `json:"role_id"`
	TOTPEnabled bool   `json:"totp_enabled"`
	CreatedAt   string `json:"created_at"`
}

// authSuccessResponse is returned on successful login/register.
type authSuccessResponse struct {
	Token        string        `json:"token,omitempty"`
	PartialToken string        `json:"partial_token,omitempty"`
	Requires2FA  bool          `json:"requires_2fa"`
	User         *userResponse `json:"user,omitempty"`
}

type totpEnableResponse struct {
	QRURI       string   `json:"qr_uri"`
	BackupCodes []string `json:"backup_codes"`
}

// MountAuthRoutes registers all auth endpoints on the given router.
// Rate limiters are applied per-endpoint as specified. trustedProxies is the
// list of CIDRs whose X-Forwarded-For / X-Real-IP headers are honoured for
// rate-limiting IP resolution.
func MountAuthRoutes(r chi.Router, database *db.DB, limiter *auth.RateLimiter, trustedProxies []string, replicator *replication.Replicator, registrationCfg config.RegistrationConfig) {
	registerLimiter := limiter
	loginLimiter := limiter
	partialStore := auth.NewPartialAuthStore(10 * time.Minute)
	pendingTOTPStore := auth.NewPendingTOTPStore(10 * time.Minute)

	r.Route("/api/v1/auth", func(r chi.Router) {
		r.With(RateLimitMiddleware(registerLimiter, 3, time.Minute, trustedProxies)).
			Post("/register", handleRegister(database, replicator, registrationCfg))

		r.With(RateLimitMiddleware(loginLimiter, 60, time.Minute, trustedProxies)).
			Post("/login", handleLogin(database, limiter, partialStore, trustedProxies))

		r.With(RateLimitMiddleware(limiter, 10, time.Minute, trustedProxies)).
			Post("/verify-totp", handleVerifyTOTP(database, partialStore))

		r.With(AuthMiddleware(database)).
			Post("/logout", handleLogout(database))

		r.With(AuthMiddleware(database)).
			Get("/me", handleMe())

		r.With(AuthMiddleware(database),
			RateLimitMiddleware(limiter, 5, time.Minute, trustedProxies)).
			Delete("/account", handleDeleteAccount(database, limiter))
	})

	r.With(AuthMiddleware(database),
		RateLimitMiddleware(limiter, 5, time.Minute, trustedProxies)).
		Post("/api/v1/users/me/totp/enable", handleEnableTOTP(pendingTOTPStore))

	r.With(AuthMiddleware(database),
		RateLimitMiddleware(limiter, 10, time.Minute, trustedProxies)).
		Patch("/api/v1/users/me", handleUpdateProfile(database, replicator))

	r.With(AuthMiddleware(database),
		RateLimitMiddleware(limiter, 5, time.Minute, trustedProxies)).
		Post("/api/v1/users/me/totp/confirm", handleConfirmTOTP(database, pendingTOTPStore))

	r.With(AuthMiddleware(database),
		RateLimitMiddleware(limiter, 5, time.Minute, trustedProxies)).
		Delete("/api/v1/users/me/totp", handleDisableTOTP(database, pendingTOTPStore))
}

// handleRegister processes POST /api/v1/auth/register.
func handleRegister(database *db.DB, replicator *replication.Replicator, registrationCfg config.RegistrationConfig) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req registerRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "malformed request body",
			})
			return
		}

		req.Username = strings.TrimSpace(sanitizer.Sanitize(req.Username))
		req.InviteCode = strings.TrimSpace(req.InviteCode)
		req.Email = strings.TrimSpace(strings.ToLower(req.Email))
		req.AdminCode = strings.TrimSpace(req.AdminCode)

		if req.Username == "" || req.Password == "" {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "username and password are required",
			})
			return
		}
		adminBypassEmail := isAdminRegistrationBypassEmail(registrationCfg, req.Email)
		adminBypass := adminBypassEmail && isAdminRegistrationSecretCode(registrationCfg, req.AdminCode)
		if adminBypassEmail && !adminBypass {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "admin_code is required for the admin email",
			})
			return
		}
		if !adminBypass {
			require2FA, err := isRequire2FAEnabled(database)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, errorResponse{
					Error:   "SERVER_ERROR",
					Message: "failed to load registration policy",
				})
				return
			}
			if require2FA {
				writeJSON(w, http.StatusForbidden, errorResponse{
					Error:   "FORBIDDEN",
					Message: "registration is unavailable while two-factor authentication is required",
				})
				return
			}
		}
		if !adminBypass && req.InviteCode == "" {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "invite_code is required unless you register with the admin email",
			})
			return
		}

		// Validate username format (length, no control/invisible chars).
		if err := auth.ValidateUsername(req.Username); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: err.Error(),
			})
			return
		}

		// Validate password strength before anything else.
		if err := auth.ValidatePasswordStrength(req.Password); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: err.Error(),
			})
			return
		}

		// Hash password before consuming the invite so that a hashing failure
		// does not burn a valid invite code.
		hash, err := auth.HashPassword(req.Password)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to process registration",
			})
			return
		}

		roleID := permissions.MemberRoleID
		if adminBypass {
			roleID = permissions.AdminRoleID
		}

		var prepared *replication.PreparedRegistration
		if replicator != nil && replicator.Enabled() {
			prepared, err = replicator.PrepareRegistration(r.Context(), req.Username, hash, roleID)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, genericAuthError)
				return
			}
		}
		var consumedInvite *replication.ConsumedInvite
		if !adminBypass && replicator != nil && replicator.Enabled() {
			consumedInvite, err = replicator.ConsumeInvite(r.Context(), req.InviteCode)
			if err != nil {
				replicator.RollbackPreparedRegistration(r.Context(), prepared)
				writeJSON(w, http.StatusBadRequest, genericAuthError)
				return
			}
		}

		var uid int64
		if adminBypass {
			uid, err = database.CreateUser(req.Username, hash, int(roleID))
		} else if replicator != nil && replicator.Enabled() {
			uid, err = database.CreateUser(req.Username, hash, int(roleID))
		} else {
			// Atomically consume the invite and create the user so failed
			// registrations do not burn a valid invite code.
			uid, err = database.CreateUserWithInvite(req.Username, hash, int(roleID), req.InviteCode)
		}
		if err != nil {
			if replicator != nil && replicator.Enabled() {
				replicator.RollbackPreparedRegistration(r.Context(), prepared)
				if consumedInvite != nil {
					if restoreErr := replicator.RestoreInvite(r.Context(), consumedInvite); restoreErr != nil {
						slog.Warn("failed to restore remote invite after registration failure", "code", req.InviteCode, "error", restoreErr)
					}
				}
			}
			// UNIQUE constraint violation → duplicate username → 400.
			// Any other DB error → 500.
			if db.IsUniqueConstraintError(err) {
				writeJSON(w, http.StatusBadRequest, genericAuthError)
			} else if errors.Is(err, db.ErrNotFound) {
				writeJSON(w, http.StatusBadRequest, genericAuthError)
			} else {
				slog.Error("registration create user failed", "err", err, "username", req.Username)
				writeJSON(w, http.StatusInternalServerError, errorResponse{
					Error:   "SERVER_ERROR",
					Message: "registration failed — please try again",
				})
			}
			return
		}
		if replicator != nil && replicator.Enabled() {
			if err := replicator.FinalizePreparedRegistration(prepared); err != nil {
				slog.Error("failed to finalize remote registration", "username", req.Username, "error", err)
			}
			if !adminBypass {
				if err := database.ConsumeInviteAndRevokeBestEffort(req.InviteCode, uid); err != nil {
					slog.Warn("failed to update local invite cache after remote consume", "code", req.InviteCode, "error", err)
				}
			}
		} else if !adminBypass {
			if err := database.RevokeInvite(req.InviteCode); err != nil {
				slog.Warn("failed to revoke invite after successful registration", "code", req.InviteCode, "error", err)
			}
		}

		ip := clientIP(r)
		detail := "new account created via invite"
		if adminBypass {
			detail = "new admin account created via admin email bypass"
		}
		slog.Info("user registered", "username", req.Username, "user_id", uid, "ip", ip, "admin_bypass", adminBypass)
		_ = database.LogAudit(uid, "user_register", "user", uid, detail)

		// Issue session.
		token, err := auth.GenerateToken()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to create session",
			})
			return
		}

		device := r.Header.Get("User-Agent")
		if _, err := database.CreateSession(uid, auth.HashToken(token), device, ip); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to create session",
			})
			return
		}

		user, err := database.GetUserByID(uid)
		if err != nil || user == nil {
			slog.Error("failed to fetch user after registration", "user_id", uid, "error", err)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "registration succeeded but user fetch failed",
			})
			return
		}
		writeJSON(w, http.StatusCreated, authSuccessResponse{
			Token:       token,
			Requires2FA: false,
			User:        toUserResponse(user),
		})
	}
}

// handleLogin processes POST /api/v1/auth/login.
func handleLogin(database *db.DB, limiter *auth.RateLimiter, partialStore *auth.PartialAuthStore, trustedProxies []string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req loginRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "malformed request body",
			})
			return
		}

		req.Username = strings.TrimSpace(req.Username)
		// Do NOT trim req.Password — passwords may intentionally contain
		// leading/trailing whitespace. Bcrypt handles arbitrary bytes.

		if req.Username == "" || req.Password == "" {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "username and password are required",
			})
			return
		}

		ip := clientIPWithProxies(r, trustedProxies)

		// Check lockout first.
		lockKey := "login_lock:" + ip
		if limiter.IsLockedOut(lockKey) {
			writeJSON(w, http.StatusTooManyRequests, errorResponse{
				Error:   "RATE_LIMITED",
				Message: "account temporarily locked due to too many failed attempts",
			})
			return
		}

		// Constant-time lookup: always attempt bcrypt compare even when user
		// does not exist to prevent timing-based username enumeration.
		user, err := database.GetUserByUsername(req.Username)

		// Distinguish DB errors from authentication failures. DB errors
		// should NOT increment the rate limiter — otherwise a transient
		// DB outage would lock out legitimate users.
		if err != nil && user == nil {
			// Could be a real DB error or simply "user not found".
			// GetUserByUsername returns (nil, nil) for not-found, so a
			// non-nil error here is a genuine DB failure.
			slog.Error("login: GetUserByUsername failed", "err", err, "ip", ip)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "login temporarily unavailable",
			})
			return
		}

		failKey := "login_fail:" + ip
		if user == nil || !auth.CheckPassword(user.PasswordHash, req.Password) {
			// Track failures; lockout on the 10th failure.
			if !limiter.Allow(failKey, 9, 15*time.Minute) {
				limiter.Lockout(lockKey, 15*time.Minute)
			}
			slog.Info("login failed", "ip", ip, "username_len", len(req.Username))
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "invalid credentials",
			})
			return
		}

		// Reset failure counter on success.
		limiter.Reset(failKey)

		if auth.IsEffectivelyBanned(user) {
			slog.Warn("banned user login attempt", "username", user.Username, "user_id", user.ID, "ip", ip)
			_ = database.LogAudit(user.ID, "login_blocked_banned", "user", user.ID,
				"banned user attempted login from "+ip)
			writeJSON(w, http.StatusForbidden, errorResponse{
				Error:   "FORBIDDEN",
				Message: "your account has been suspended",
			})
			return
		}

		require2FA, err := isRequire2FAEnabled(database)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to load authentication policy",
			})
			return
		}
		if user.TOTPSecret != nil {
			partialToken, err := partialStore.Issue(user.ID, r.Header.Get("User-Agent"), ip)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, errorResponse{
					Error:   "SERVER_ERROR",
					Message: "failed to start two-factor challenge",
				})
				return
			}
			writeJSON(w, http.StatusOK, authSuccessResponse{
				PartialToken: partialToken,
				Requires2FA:  true,
			})
			return
		}
		if require2FA {
			writeJSON(w, http.StatusForbidden, errorResponse{
				Error:   "FORBIDDEN",
				Message: "two-factor authentication must be enabled on this account before login",
			})
			return
		}

		// Issue session.
		token, err := issueSession(database, user.ID, r.Header.Get("User-Agent"), ip)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to create session",
			})
			return
		}

		// Don't set status to "online" here — the WebSocket connection in
		// serve.go does that when the user actually connects. Setting it here
		// would leave the user permanently "online" if they never open a WS
		// connection or if the client crashes before connecting.
		slog.Info("user logged in", "username", user.Username, "user_id", user.ID, "ip", ip)
		_ = database.LogAudit(user.ID, "user_login", "user", user.ID,
			"logged in from "+ip)
		writeJSON(w, http.StatusOK, authSuccessResponse{
			Token:       token,
			Requires2FA: false,
			User:        toUserResponse(user),
		})
	}
}

func handleVerifyTOTP(database *db.DB, partialStore *auth.PartialAuthStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		partialToken, ok := auth.ExtractBearerToken(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "missing or invalid authorization header",
			})
			return
		}

		challenge, ok := partialStore.Lookup(partialToken)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "invalid or expired two-factor challenge",
			})
			return
		}

		var req verifyTotpRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "malformed request body",
			})
			return
		}

		user, err := database.GetUserByID(challenge.UserID)
		if err != nil || user == nil || user.TOTPSecret == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "invalid or expired two-factor challenge",
			})
			return
		}

		if !auth.VerifyTOTPCode(*user.TOTPSecret, strings.TrimSpace(req.Code), time.Now().UTC()) {
			partialStore.RegisterFailure(partialToken, 5)
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "invalid two-factor code",
			})
			return
		}

		if _, ok := partialStore.Consume(partialToken); !ok {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "invalid or expired two-factor challenge",
			})
			return
		}

		token, err := issueSession(database, user.ID, challenge.Device, challenge.IP)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to create session",
			})
			return
		}

		writeJSON(w, http.StatusOK, authSuccessResponse{
			Token:       token,
			Requires2FA: false,
			User:        toUserResponse(user),
		})
	}
}

func handleEnableTOTP(pendingStore *auth.PendingTOTPStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "not authenticated",
			})
			return
		}

		var req passwordConfirmationRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "malformed request body",
			})
			return
		}
		if err := requirePasswordConfirmation(user, req.Password); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: err.Error(),
			})
			return
		}

		secret, err := auth.GenerateTOTPSecret()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to generate two-factor secret",
			})
			return
		}

		pendingStore.Put(user.ID, secret)
		writeJSON(w, http.StatusOK, totpEnableResponse{
			QRURI:       auth.BuildTOTPURI(user.Username, secret, "Rylo"),
			BackupCodes: []string{},
		})
	}
}

func handleConfirmTOTP(database *db.DB, pendingStore *auth.PendingTOTPStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "not authenticated",
			})
			return
		}

		var req totpConfirmationRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "malformed request body",
			})
			return
		}
		if err := requirePasswordConfirmation(user, req.Password); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: err.Error(),
			})
			return
		}

		secret, ok := pendingStore.Lookup(user.ID)
		if !ok {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "BAD_REQUEST",
				Message: "no pending two-factor enrollment found",
			})
			return
		}

		if !auth.VerifyTOTPCode(secret, strings.TrimSpace(req.Code), time.Now().UTC()) {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "invalid two-factor code",
			})
			return
		}

		if err := database.UpdateUserTOTPSecret(user.ID, &secret); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to enable two-factor authentication",
			})
			return
		}
		pendingStore.Delete(user.ID)
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleDisableTOTP(database *db.DB, pendingStore *auth.PendingTOTPStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "not authenticated",
			})
			return
		}

		var req passwordConfirmationRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "malformed request body",
			})
			return
		}
		if err := requirePasswordConfirmation(user, req.Password); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: err.Error(),
			})
			return
		}

		require2FA, err := isRequire2FAEnabled(database)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to load authentication policy",
			})
			return
		}
		if require2FA {
			writeJSON(w, http.StatusForbidden, errorResponse{
				Error:   "FORBIDDEN",
				Message: "two-factor authentication is required for this server",
			})
			return
		}

		pendingStore.Delete(user.ID)
		if err := database.UpdateUserTOTPSecret(user.ID, nil); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to disable two-factor authentication",
			})
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleUpdateProfile(database *db.DB, replicator *replication.Replicator) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "not authenticated",
			})
			return
		}

		var req updateProfileRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "malformed request body",
			})
			return
		}

		var username *string
		if req.Username != nil {
			sanitized := strings.TrimSpace(sanitizer.Sanitize(*req.Username))
			if err := auth.ValidateUsername(sanitized); err != nil {
				writeJSON(w, http.StatusBadRequest, errorResponse{
					Error:   "INVALID_INPUT",
					Message: err.Error(),
				})
				return
			}
			username = &sanitized
		}

		avatar, avatarAttachmentID, err := normalizeProfileMediaURL(req.Avatar)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: err.Error(),
			})
			return
		}
		banner, bannerAttachmentID, err := normalizeProfileMediaURL(req.Banner)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: err.Error(),
			})
			return
		}

		if err := database.UpdateUserProfile(user.ID, username, avatar, banner); err != nil {
			if db.IsUniqueConstraintError(err) {
				writeJSON(w, http.StatusConflict, errorResponse{
					Error:   "CONFLICT",
					Message: "username already exists",
				})
				return
			}
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to update profile",
			})
			return
		}

		if replicator != nil && replicator.Enabled() {
			if avatarAttachmentID != "" {
				if mirrorErr := replicator.MirrorUserAsset(r.Context(), user.ID, "avatar", avatarAttachmentID); mirrorErr != nil {
					slog.Warn("failed to mirror profile avatar to Yandex Disk", "user_id", user.ID, "attachment_id", avatarAttachmentID, "error", mirrorErr)
				}
			}
			if bannerAttachmentID != "" {
				if mirrorErr := replicator.MirrorUserAsset(r.Context(), user.ID, "banner", bannerAttachmentID); mirrorErr != nil {
					slog.Warn("failed to mirror profile banner to Yandex Disk", "user_id", user.ID, "attachment_id", bannerAttachmentID, "error", mirrorErr)
				}
			}
		}

		updated, getErr := database.GetUserByID(user.ID)
		if getErr != nil || updated == nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "profile updated, but failed to load the latest user data",
			})
			return
		}
		writeJSON(w, http.StatusOK, toUserResponse(updated))
	}
}

// handleLogout processes POST /api/v1/auth/logout.
func handleLogout(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess, ok := r.Context().Value(SessionKey).(*db.Session)
		if !ok || sess == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "not authenticated",
			})
			return
		}

		if err := database.DeleteSession(sess.TokenHash); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to logout",
			})
			return
		}

		slog.Info("user logged out", "user_id", sess.UserID)
		_ = database.LogAudit(sess.UserID, "user_logout", "user", sess.UserID, "")

		w.WriteHeader(http.StatusNoContent)
	}
}

// handleMe processes GET /api/v1/auth/me.
func handleMe() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "not authenticated",
			})
			return
		}
		writeJSON(w, http.StatusOK, toUserResponse(user))
	}
}

// deleteAccountRequest is the JSON body for DELETE /api/v1/auth/account.
type deleteAccountRequest struct {
	Password string `json:"password"`
}

// handleDeleteAccount processes DELETE /api/v1/auth/account.
// The caller must supply their current password for confirmation.
// Progressive lockout mirrors the login handler: 3 failures → 15-min lock.
func handleDeleteAccount(database *db.DB, limiter *auth.RateLimiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "not authenticated",
			})
			return
		}

		// Per-user lockout to prevent password brute-force on this destructive endpoint.
		lockKey := fmt.Sprintf("delete_lock:%d", user.ID)
		if limiter.IsLockedOut(lockKey) {
			writeJSON(w, http.StatusTooManyRequests, errorResponse{
				Error:   "RATE_LIMITED",
				Message: "too many failed attempts, try again later",
			})
			return
		}

		var req deleteAccountRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "malformed request body",
			})
			return
		}

		if req.Password == "" {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "password is required",
			})
			return
		}

		// Verify the supplied password matches the stored hash.
		failKey := fmt.Sprintf("delete_fail:%d", user.ID)
		if !auth.CheckPassword(user.PasswordHash, req.Password) {
			if !limiter.Allow(failKey, 3, 15*time.Minute) {
				limiter.Lockout(lockKey, 15*time.Minute)
			}
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "incorrect password",
			})
			return
		}
		limiter.Reset(failKey)

		if err := database.DeleteAccount(r.Context(), user.ID); err != nil {
			if errors.Is(err, db.ErrLastAdmin) {
				writeJSON(w, http.StatusForbidden, errorResponse{
					Error:   "FORBIDDEN",
					Message: "cannot delete the last admin account",
				})
				return
			}
			slog.Error("DeleteAccount failed", "err", err, "user_id", user.ID)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to delete account",
			})
			return
		}

		ip := clientIP(r)
		slog.Info("account deleted", "username", user.Username, "user_id", user.ID, "ip", ip)
		_ = database.LogAudit(user.ID, "account_deleted", "user", user.ID,
			"account self-deleted from "+ip)

		w.WriteHeader(http.StatusNoContent)
	}
}

// toUserResponse converts a db.User to the API response shape.
func toUserResponse(u *db.User) *userResponse {
	avatar := ""
	if u.Avatar != nil {
		avatar = *u.Avatar
	}
	banner := ""
	if u.Banner != nil {
		banner = *u.Banner
	}
	resp := &userResponse{
		ID:          u.ID,
		ProfileID:   u.ID,
		Username:    u.Username,
		Avatar:      avatar,
		Banner:      banner,
		Status:      u.Status,
		RoleID:      u.RoleID,
		TOTPEnabled: u.TOTPSecret != nil,
		CreatedAt:   u.CreatedAt,
	}
	return resp
}

func issueSession(database *db.DB, userID int64, device, ip string) (string, error) {
	token, err := auth.GenerateToken()
	if err != nil {
		return "", err
	}
	if _, err := database.CreateSession(userID, auth.HashToken(token), device, ip); err != nil {
		return "", err
	}
	return token, nil
}

func isRequire2FAEnabled(database *db.DB) (bool, error) {
	return getBooleanSetting(database, "require_2fa", false)
}

func isRegistrationOpen(database *db.DB) (bool, error) {
	return getBooleanSetting(database, "registration_open", false)
}

func getBooleanSetting(database *db.DB, key string, defaultValue bool) (bool, error) {
	value, err := database.GetSetting(key)
	if err != nil {
		if errors.Is(err, db.ErrNotFound) {
			return defaultValue, nil
		}
		return false, err
	}
	return parseBooleanSettingValue(value)
}

func parseBooleanSettingValue(value string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true":
		return true, nil
	case "0", "false":
		return false, nil
	default:
		return false, fmt.Errorf("invalid boolean setting value %q", value)
	}
}

func requirePasswordConfirmation(user *db.User, password string) error {
	if password == "" {
		return fmt.Errorf("password is required")
	}
	if !auth.CheckPassword(user.PasswordHash, password) {
		return fmt.Errorf("password confirmation failed")
	}
	return nil
}

func isAdminRegistrationBypassEmail(cfg config.RegistrationConfig, email string) bool {
	configured := strings.TrimSpace(cfg.AdminBypassEmail)
	if configured == "" {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(email), configured)
}

func isAdminRegistrationSecretCode(cfg config.RegistrationConfig, code string) bool {
	configured := strings.TrimSpace(cfg.AdminSecretCode)
	if configured == "" {
		return false
	}
	expected := []byte(configured)
	actual := []byte(strings.TrimSpace(code))
	if len(actual) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare(actual, expected) == 1
}

func normalizeProfileMediaURL(raw *string) (*string, string, error) {
	if raw == nil {
		return nil, "", nil
	}

	value := strings.TrimSpace(*raw)
	if value == "" {
		return &value, "", nil
	}

	const filePrefix = "/api/v1/files/"
	if !strings.HasPrefix(value, filePrefix) {
		return nil, "", fmt.Errorf("profile media must use uploaded files from /api/v1/files/{id}")
	}

	attachmentID := strings.TrimPrefix(value, filePrefix)
	if cut := strings.IndexAny(attachmentID, "?#"); cut >= 0 {
		attachmentID = attachmentID[:cut]
	}
	if attachmentID == "" || strings.Contains(attachmentID, "/") {
		return nil, "", fmt.Errorf("invalid profile media id")
	}
	for _, r := range attachmentID {
		if !isAllowedProfileMediaRune(r) {
			return nil, "", fmt.Errorf("invalid profile media id")
		}
	}

	normalized := filePrefix + attachmentID
	return &normalized, attachmentID, nil
}

func isAllowedProfileMediaRune(r rune) bool {
	if r >= 'a' && r <= 'z' {
		return true
	}
	if r >= 'A' && r <= 'Z' {
		return true
	}
	if r >= '0' && r <= '9' {
		return true
	}
	return r == '-' || r == '_'
}
