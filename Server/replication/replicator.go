package replication

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/rylo/server/config"
	"github.com/rylo/server/db"
	"github.com/rylo/server/storage"
)

const (
	remoteEventsDir  = "events"
	remoteUsersDir   = "users"
	remoteBlobsDir   = "blobs"
	remoteInvitesDir = "invites"
	remoteLocksDir   = ".locks"
	remoteAvatarsDir = "Avatars"
	remoteBannersDir = "Banners"
)

const (
	EventTypeRegistration  = "registration"
	EventTypeMessage       = "message"
	EventTypeMessageDelete = "message_delete"
	EventTypePresence      = "presence"
	EventTypeReaction      = "reaction"
	EventTypeProfileUpdate = "profile_update"
)

type InvitePayload struct {
	Code       string  `json:"code"`
	CreatedBy  int64   `json:"created_by"`
	RedeemedBy *int64  `json:"redeemed_by,omitempty"`
	MaxUses    *int    `json:"max_uses,omitempty"`
	UseCount   int     `json:"use_count"`
	ExpiresAt  *string `json:"expires_at,omitempty"`
	Revoked    bool    `json:"revoked"`
	CreatedAt  string  `json:"created_at"`
	UpdatedAt  string  `json:"updated_at"`
}

type ConsumedInvite struct {
	Path     string
	Previous InvitePayload
	Current  InvitePayload
}

type EventEnvelope struct {
	ID         string          `json:"id"`
	Type       string          `json:"type"`
	OriginNode string          `json:"origin_node"`
	CreatedAt  string          `json:"created_at"`
	Payload    json.RawMessage `json:"payload"`
}

type RegistrationPayload struct {
	Username     string `json:"username"`
	PasswordHash string `json:"password_hash"`
	RoleID       int64  `json:"role_id"`
	CreatedAt    string `json:"created_at"`
}

type AttachmentPayload struct {
	ID       string `json:"id"`
	Filename string `json:"filename"`
	Size     int64  `json:"size"`
	Mime     string `json:"mime"`
	Width    *int   `json:"width,omitempty"`
	Height   *int   `json:"height,omitempty"`
}

type MessagePayload struct {
	SyncID         string              `json:"sync_id,omitempty"`
	ChannelKind    string              `json:"channel_kind"`
	ChannelID      int64               `json:"channel_id"`
	ChannelName    string              `json:"channel_name"`
	SenderUsername string              `json:"sender_username"`
	OriginServer   string              `json:"origin_server,omitempty"`
	Content        string              `json:"content"`
	Timestamp      string              `json:"timestamp"`
	DMParticipants []string            `json:"dm_participants,omitempty"`
	Attachments    []AttachmentPayload `json:"attachments,omitempty"`
}

type MessageDeletePayload struct {
	SyncID         string   `json:"sync_id,omitempty"`
	ChannelKind    string   `json:"channel_kind"`
	ChannelID      int64    `json:"channel_id"`
	ChannelName    string   `json:"channel_name"`
	SenderUsername string   `json:"sender_username"`
	Timestamp      string   `json:"timestamp"`
	DMParticipants []string `json:"dm_participants,omitempty"`
}

type PresencePayload struct {
	Username     string `json:"username"`
	Status       string `json:"status"`
	LastSeen     string `json:"last_seen"`
	SourceServer string `json:"source_server,omitempty"`
}

type ReactionPayload struct {
	SyncID         string   `json:"sync_id,omitempty"`
	ChannelKind    string   `json:"channel_kind"`
	ChannelID      int64    `json:"channel_id"`
	ChannelName    string   `json:"channel_name"`
	SenderUsername string   `json:"sender_username"`
	MessageSyncID  string   `json:"message_sync_id"`
	Emoji          string   `json:"emoji"`
	Action         string   `json:"action"` // "add" or "remove"
	Timestamp      string   `json:"timestamp"`
	DMParticipants []string `json:"dm_participants,omitempty"`
}

type ProfileUpdatePayload struct {
	PreviousUsername string             `json:"previous_username,omitempty"`
	Username         string             `json:"username"`
	Avatar           string             `json:"avatar"`
	Banner           string             `json:"banner"`
	Timestamp        string             `json:"timestamp"`
	AvatarAttachment *AttachmentPayload `json:"avatar_attachment,omitempty"`
	BannerAttachment *AttachmentPayload `json:"banner_attachment,omitempty"`
}

type ImportedMessage struct {
	MessageID        int64
	ChannelID        int64
	ChannelKind      string
	SenderID         int64
	SenderUsername   string
	Content          string
	Timestamp        string
	OriginServer     string
	DMParticipantIDs []int64
}

type ImportedDelete struct {
	MessageID        int64
	ChannelID        int64
	ChannelKind      string
	DMParticipantIDs []int64
}

type ImportedPresence struct {
	UserID       int64
	Status       string
	LastSeen     string
	SourceServer string
}

type ImportedReaction struct {
	MessageID        int64
	ChannelID        int64
	ChannelKind      string
	UserID           int64
	Emoji            string
	Action           string // "add" or "remove"
	DMParticipantIDs []int64
}

type ImportedProfileUpdate struct {
	UserID   int64
	Username string
	Avatar   *string
	Banner   *string
}

type DefaultAvatarCategory struct {
	Name    string
	Avatars []DefaultAvatarEntry
}

type DefaultAvatarEntry struct {
	Name string
}

type PreparedRegistration struct {
	ProfilePath string
	EventPath   string
	EventID     string
}

// Replicator mirrors selected Rylo data to a shared Yandex Disk folder and
// imports new remote events back into the local database.
type Replicator struct {
	enabled             bool
	db                  *db.DB
	client              *webDAVClient
	key                 []byte
	rootPath            string
	advertiseHost       string
	nodeID              string
	pollInterval        time.Duration
	stopCh              chan struct{}
	profileBackfillDone bool
	importedHook        func(ImportedMessage)
	deletedHook         func(ImportedDelete)
	presenceHook        func(ImportedPresence)
	reactionHook        func(ImportedReaction)
	profileHook         func(ImportedProfileUpdate)
}

// New creates a Yandex Disk replicator. When the feature is disabled, a
// disabled replicator is returned so callers can unconditionally invoke it.
func New(cfg config.YandexDiskConfig, database *db.DB) (*Replicator, error) {
	r := &Replicator{
		enabled:       cfg.Enabled && strings.TrimSpace(cfg.OAuthToken) != "",
		db:            database,
		rootPath:      normalizeRemotePath(cfg.RootPath),
		advertiseHost: strings.TrimSpace(cfg.AdvertiseHost),
		nodeID:        uuid.NewString(),
		pollInterval:  time.Duration(cfg.PollIntervalSeconds * float64(time.Second)),
		stopCh:        make(chan struct{}),
	}
	if !r.enabled {
		return r, nil
	}

	key, err := deriveEncryptionKey(cfg)
	if err != nil {
		return nil, err
	}
	r.key = key
	r.client = newWebDAVClient(cfg.BaseURL, cfg.OAuthToken)
	if err := r.ensureRemoteLayout(context.Background()); err != nil {
		return nil, err
	}
	return r, nil
}

// Enabled reports whether remote replication is active.
func (r *Replicator) Enabled() bool {
	return r != nil && r.enabled
}

// Start launches the background importer loop.
func (r *Replicator) Start() {
	if !r.Enabled() {
		return
	}

	go func() {
		ticker := time.NewTicker(r.pollInterval)
		defer ticker.Stop()
		for {
			if err := r.SyncOnce(context.Background()); err != nil {
				slog.Warn("yandex sync tick failed", "error", err)
			}

			select {
			case <-ticker.C:
			case <-r.stopCh:
				return
			}
		}
	}()
}

// Stop terminates the background importer.
func (r *Replicator) Stop() {
	if !r.Enabled() {
		return
	}
	select {
	case <-r.stopCh:
	default:
		close(r.stopCh)
	}
}

// SetImportedMessageHook registers a callback invoked when a remote message is
// successfully imported into the local DB.
func (r *Replicator) SetImportedMessageHook(hook func(ImportedMessage)) {
	if r == nil {
		return
	}
	r.importedHook = hook
}

// SetImportedDeleteHook registers a callback invoked when a remote delete is
// successfully imported into the local DB.
func (r *Replicator) SetImportedDeleteHook(hook func(ImportedDelete)) {
	if r == nil {
		return
	}
	r.deletedHook = hook
}

// SetImportedPresenceHook registers a callback invoked when a remote presence
// event is imported into the local DB.
func (r *Replicator) SetImportedPresenceHook(hook func(ImportedPresence)) {
	if r == nil {
		return
	}
	r.presenceHook = hook
}

// SetImportedReactionHook registers a callback invoked when a remote reaction
// event is imported into the local DB.
func (r *Replicator) SetImportedReactionHook(hook func(ImportedReaction)) {
	if r == nil {
		return
	}
	r.reactionHook = hook
}

// SetImportedProfileHook registers a callback invoked when a remote profile
// update event is imported into the local DB.
func (r *Replicator) SetImportedProfileHook(hook func(ImportedProfileUpdate)) {
	if r == nil {
		return
	}
	r.profileHook = hook
}

// PrepareRegistration writes the remote encrypted user profile and a remote
// registration event before the local DB insert happens.
func (r *Replicator) PrepareRegistration(ctx context.Context, username, passwordHash string, roleID int64) (*PreparedRegistration, error) {
	if !r.Enabled() {
		return nil, nil
	}

	profilePath := r.userProfilePath(username)
	exists, err := r.client.Exists(ctx, profilePath)
	if err != nil {
		return nil, fmt.Errorf("checking remote user profile: %w", err)
	}
	if exists {
		return nil, fmt.Errorf("remote user already exists")
	}

	payload := RegistrationPayload{
		Username:     username,
		PasswordHash: passwordHash,
		RoleID:       roleID,
		CreatedAt:    time.Now().UTC().Format(time.RFC3339),
	}
	if err := r.putEncryptedJSON(ctx, profilePath, payload); err != nil {
		return nil, err
	}

	eventID, eventPath, err := r.publishEvent(ctx, EventTypeRegistration, payload)
	if err != nil {
		_ = r.client.Delete(ctx, profilePath)
		return nil, err
	}

	return &PreparedRegistration{
		ProfilePath: profilePath,
		EventPath:   eventPath,
		EventID:     eventID,
	}, nil
}

// FinalizePreparedRegistration marks the just-published local registration event as processed.
func (r *Replicator) FinalizePreparedRegistration(prepared *PreparedRegistration) error {
	if !r.Enabled() || prepared == nil {
		return nil
	}
	return r.db.MarkSyncEventProcessed(prepared.EventPath, prepared.EventID)
}

// MirrorInvite writes an encrypted invite snapshot to Yandex Disk.
func (r *Replicator) MirrorInvite(ctx context.Context, inv *db.Invite) error {
	if !r.Enabled() || inv == nil {
		return nil
	}
	now := time.Now().UTC().Format(time.RFC3339)
	payload := InvitePayload{
		Code:       inv.Code,
		CreatedBy:  inv.CreatedBy,
		RedeemedBy: inv.RedeemedBy,
		MaxUses:    inv.MaxUses,
		UseCount:   inv.Uses,
		ExpiresAt:  inv.ExpiresAt,
		Revoked:    inv.Revoked,
		CreatedAt:  inv.CreatedAt,
		UpdatedAt:  now,
	}
	if payload.CreatedAt == "" {
		payload.CreatedAt = now
	}
	return r.putEncryptedJSON(ctx, r.invitePath(inv.Code), payload)
}

// SyncInviteCache imports invite snapshots from Yandex Disk into the local DB
// so every device can list and manage the same invite set.
func (r *Replicator) SyncInviteCache(ctx context.Context) error {
	if !r.Enabled() {
		return nil
	}

	entries, err := r.client.ListEntries(ctx, r.remotePath(remoteInvitesDir))
	if err != nil {
		return fmt.Errorf("list remote invites: %w", err)
	}

	remoteCodes := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.Type == "dir" || !strings.HasSuffix(strings.ToLower(entry.Name), ".json.enc") {
			continue
		}

		raw, getErr := r.getDecryptedBytes(ctx, entry.Path)
		if getErr != nil {
			slog.Warn("failed to read remote invite snapshot", "path", entry.Path, "error", getErr)
			continue
		}

		var payload InvitePayload
		if err := json.Unmarshal(raw, &payload); err != nil {
			slog.Warn("failed to decode remote invite snapshot", "path", entry.Path, "error", err)
			continue
		}
		if strings.TrimSpace(payload.Code) == "" {
			continue
		}
		remoteCodes = append(remoteCodes, payload.Code)

		creator, err := r.db.GetUserByID(payload.CreatedBy)
		if err != nil {
			return err
		}
		if creator == nil {
			slog.Warn("skipping invite snapshot because creator is missing locally", "code", payload.Code, "created_by", payload.CreatedBy)
			continue
		}

		redeemedBy := payload.RedeemedBy
		if redeemedBy != nil {
			redeemer, err := r.db.GetUserByID(*redeemedBy)
			if err != nil {
				return err
			}
			if redeemer == nil {
				redeemedBy = nil
			}
		}

		createdAt := strings.TrimSpace(payload.CreatedAt)
		if createdAt == "" {
			createdAt = strings.TrimSpace(payload.UpdatedAt)
		}
		if createdAt == "" {
			createdAt = time.Now().UTC().Format(time.RFC3339)
		}

		if err := r.db.UpsertInviteSnapshot(&db.Invite{
			Code:       payload.Code,
			CreatedBy:  payload.CreatedBy,
			RedeemedBy: redeemedBy,
			MaxUses:    payload.MaxUses,
			Uses:       payload.UseCount,
			ExpiresAt:  payload.ExpiresAt,
			Revoked:    payload.Revoked,
			CreatedAt:  createdAt,
		}); err != nil {
			slog.Warn("failed to cache remote invite snapshot locally", "code", payload.Code, "error", err)
		}
	}

	if err := r.db.DeleteInvitesExcept(remoteCodes); err != nil {
		return fmt.Errorf("prune deleted remote invites: %w", err)
	}

	return nil
}

// RevokeInvite marks a remote invite as revoked.
func (r *Replicator) RevokeInvite(ctx context.Context, code string) error {
	if !r.Enabled() {
		return nil
	}
	lockPath := r.inviteLockPath(code)
	locked, err := r.acquireInviteLock(ctx, lockPath)
	if err != nil {
		return err
	}
	if !locked {
		return fmt.Errorf("invite is busy")
	}
	defer r.releaseInviteLock(context.Background(), lockPath)

	payload, err := r.readInvitePayload(ctx, code)
	if err != nil {
		return err
	}
	payload.Revoked = true
	payload.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	return r.putEncryptedJSON(ctx, r.invitePath(code), payload)
}

// DeleteInvite permanently removes an invite snapshot from Yandex Disk. The
// invite is marked revoked before removal when possible so a concurrent device
// cannot redeem it while deletion is in progress.
func (r *Replicator) DeleteInvite(ctx context.Context, code string) error {
	if !r.Enabled() {
		return nil
	}
	lockPath := r.inviteLockPath(code)
	locked, err := r.acquireInviteLock(ctx, lockPath)
	if err != nil {
		return err
	}
	if !locked {
		return fmt.Errorf("invite is busy")
	}
	defer r.releaseInviteLock(context.Background(), lockPath)

	invitePath := r.invitePath(code)
	exists, err := r.client.Exists(ctx, invitePath)
	if err != nil {
		return err
	}
	if exists {
		payload, err := r.readInvitePayload(ctx, code)
		if err == nil {
			payload.Revoked = true
			payload.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
			if err := r.putEncryptedJSON(ctx, invitePath, payload); err != nil {
				return err
			}
		} else {
			slog.Warn("failed to revoke invite snapshot before permanent delete", "code", code, "error", err)
		}
	}
	return r.client.Delete(ctx, invitePath)
}

// ConsumeInvite validates an invite in Yandex Disk and atomically flips it to
// revoked for one-time usage.
func (r *Replicator) ConsumeInvite(ctx context.Context, code string) (*ConsumedInvite, error) {
	if !r.Enabled() {
		return nil, fmt.Errorf("replication disabled")
	}

	lockPath := r.inviteLockPath(code)
	locked, err := r.acquireInviteLock(ctx, lockPath)
	if err != nil {
		return nil, err
	}
	if !locked {
		return nil, fmt.Errorf("invite is busy")
	}
	defer r.releaseInviteLock(context.Background(), lockPath)

	invitePath := r.invitePath(code)
	exists, err := r.client.Exists(ctx, invitePath)
	if err != nil {
		return nil, err
	}
	if !exists {
		localInvite, getErr := r.db.GetInvite(code)
		if getErr != nil {
			return nil, getErr
		}
		if localInvite == nil {
			return nil, fmt.Errorf("invite not found")
		}
		if mirrorErr := r.MirrorInvite(ctx, localInvite); mirrorErr != nil {
			return nil, mirrorErr
		}
	}

	payload, err := r.readInvitePayload(ctx, code)
	if err != nil {
		return nil, err
	}
	if err := validateInvitePayload(payload, time.Now().UTC()); err != nil {
		return nil, err
	}

	previous := payload
	payload.UseCount++
	payload.Revoked = true
	payload.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	if err := r.putEncryptedJSON(ctx, r.invitePath(code), payload); err != nil {
		return nil, err
	}

	return &ConsumedInvite{
		Path:     r.invitePath(code),
		Previous: previous,
		Current:  payload,
	}, nil
}

// RestoreInvite rewrites the invite payload after a local registration failure.
func (r *Replicator) RestoreInvite(ctx context.Context, consumed *ConsumedInvite) error {
	if !r.Enabled() || consumed == nil {
		return nil
	}
	lockPath := r.inviteLockPath(consumed.Previous.Code)
	locked, err := r.acquireInviteLock(ctx, lockPath)
	if err != nil {
		return err
	}
	if !locked {
		return fmt.Errorf("invite is busy")
	}
	defer r.releaseInviteLock(context.Background(), lockPath)
	return r.putEncryptedJSON(ctx, consumed.Path, consumed.Previous)
}

// RollbackPreparedRegistration removes remote artifacts after a failed local registration.
func (r *Replicator) RollbackPreparedRegistration(ctx context.Context, prepared *PreparedRegistration) {
	if !r.Enabled() || prepared == nil {
		return
	}
	if prepared.EventPath != "" {
		_ = r.client.Delete(ctx, prepared.EventPath)
	}
	if prepared.ProfilePath != "" {
		_ = r.client.Delete(ctx, prepared.ProfilePath)
	}
}

// MirrorAttachment writes an encrypted copy of an uploaded attachment to Yandex Disk.
func (r *Replicator) MirrorAttachment(ctx context.Context, id string, data []byte) error {
	if !r.Enabled() {
		return nil
	}
	return r.putEncryptedBytes(ctx, r.blobPath(id), data, "application/octet-stream")
}

// MirrorUserAsset stores a profile media copy inside the user's directory.
// The source bytes are read from the already mirrored blob object.
func (r *Replicator) MirrorUserAsset(ctx context.Context, userID int64, kind, attachmentID string) error {
	if !r.Enabled() {
		return nil
	}
	kind = strings.ToLower(strings.TrimSpace(kind))
	if kind != "avatar" && kind != "banner" {
		return fmt.Errorf("unsupported user asset kind %q", kind)
	}

	userDir := r.remotePath(remoteUsersDir, fmt.Sprintf("%d", userID))
	if err := r.client.EnsureDir(ctx, userDir); err != nil {
		return err
	}

	plaintext, err := r.getDecryptedBytes(ctx, r.blobPath(attachmentID))
	if err != nil {
		return err
	}
	return r.putEncryptedBytes(ctx, r.userAssetPath(userID, kind, attachmentID), plaintext, "application/octet-stream")
}

// MirrorProfileUpdate publishes a replicated user profile snapshot update so
// other nodes can apply avatar/banner/username changes.
func (r *Replicator) MirrorProfileUpdate(ctx context.Context, previousUsername string, user *db.User) error {
	if !r.Enabled() || user == nil {
		return nil
	}

	avatar := ""
	if user.Avatar != nil {
		avatar = *user.Avatar
	}
	banner := ""
	if user.Banner != nil {
		banner = *user.Banner
	}

	payload := ProfileUpdatePayload{
		PreviousUsername: strings.TrimSpace(previousUsername),
		Username:         strings.TrimSpace(user.Username),
		Avatar:           avatar,
		Banner:           banner,
		Timestamp:        time.Now().UTC().Format(time.RFC3339),
	}

	// Attach metadata for profile media file URLs so the receiver can create
	// local attachment records before serving /api/v1/files/{id}.
	if avatarID, ok := profileMediaAttachmentID(avatar); ok {
		att, err := r.buildAttachmentPayload(avatarID)
		if err != nil {
			return err
		}
		payload.AvatarAttachment = att
	}
	if bannerID, ok := profileMediaAttachmentID(banner); ok {
		att, err := r.buildAttachmentPayload(bannerID)
		if err != nil {
			return err
		}
		payload.BannerAttachment = att
	}

	eventID, eventPath, err := r.publishEvent(ctx, EventTypeProfileUpdate, payload)
	if err != nil {
		return err
	}
	return r.db.MarkSyncEventProcessed(eventPath, eventID)
}

// ListDefaultAvatarCatalog returns all configured default avatars grouped by
// folder name from /<root>/Avatars on Yandex Disk.
func (r *Replicator) ListDefaultAvatarCatalog(ctx context.Context) ([]DefaultAvatarCategory, error) {
	if !r.Enabled() {
		return []DefaultAvatarCategory{}, nil
	}

	categoryEntries, err := r.client.ListEntries(ctx, r.remotePath(remoteAvatarsDir))
	if err != nil {
		return nil, err
	}

	catalog := make([]DefaultAvatarCategory, 0, len(categoryEntries))
	for _, entry := range categoryEntries {
		if entry.Type != "dir" {
			continue
		}

		categoryName := strings.TrimSpace(entry.Name)
		if categoryName == "" {
			continue
		}

		avatarEntries, listErr := r.client.ListEntries(ctx, entry.Path)
		if listErr != nil {
			slog.Warn("failed to list default avatar category", "category", categoryName, "error", listErr)
			continue
		}

		avatars := make([]DefaultAvatarEntry, 0, len(avatarEntries))
		for _, avatar := range avatarEntries {
			if avatar.Type == "dir" {
				continue
			}
			avatarName := strings.TrimSpace(avatar.Name)
			if avatarName == "" || !isSupportedDefaultAvatarFilename(avatarName) {
				continue
			}
			avatars = append(avatars, DefaultAvatarEntry{Name: avatarName})
		}
		if len(avatars) == 0 {
			continue
		}

		sort.Slice(avatars, func(i, j int) bool {
			return strings.ToLower(avatars[i].Name) < strings.ToLower(avatars[j].Name)
		})
		catalog = append(catalog, DefaultAvatarCategory{
			Name:    categoryName,
			Avatars: avatars,
		})
	}

	sort.Slice(catalog, func(i, j int) bool {
		return strings.ToLower(catalog[i].Name) < strings.ToLower(catalog[j].Name)
	})
	return catalog, nil
}

// GetDefaultAvatarBytes reads one default avatar file from
// /<root>/Avatars/{category}/{filename}.
func (r *Replicator) GetDefaultAvatarBytes(ctx context.Context, category, filename string) ([]byte, string, error) {
	if !r.Enabled() {
		return nil, "", fmt.Errorf("replication disabled")
	}

	safeCategory, err := sanitizeDefaultAvatarPathSegment(category, "category")
	if err != nil {
		return nil, "", err
	}
	safeFilename, err := sanitizeDefaultAvatarPathSegment(filename, "filename")
	if err != nil {
		return nil, "", err
	}
	if !isSupportedDefaultAvatarFilename(safeFilename) {
		return nil, "", fmt.Errorf("unsupported avatar file type")
	}

	remotePath := r.remotePath(remoteAvatarsDir, safeCategory, safeFilename)
	data, err := r.client.Get(ctx, remotePath)
	if err != nil {
		return nil, "", err
	}
	return data, safeFilename, nil
}

// ListDefaultBannerCatalog returns all configured default banners grouped by
// folder name from /<root>/Banners on Yandex Disk.
func (r *Replicator) ListDefaultBannerCatalog(ctx context.Context) ([]DefaultAvatarCategory, error) {
	if !r.Enabled() {
		return []DefaultAvatarCategory{}, nil
	}

	categoryEntries, err := r.client.ListEntries(ctx, r.remotePath(remoteBannersDir))
	if err != nil {
		return nil, err
	}

	catalog := make([]DefaultAvatarCategory, 0, len(categoryEntries))
	for _, entry := range categoryEntries {
		if entry.Type != "dir" {
			continue
		}

		categoryName := strings.TrimSpace(entry.Name)
		if categoryName == "" {
			continue
		}

		bannerEntries, listErr := r.client.ListEntries(ctx, entry.Path)
		if listErr != nil {
			slog.Warn("failed to list default banner category", "category", categoryName, "error", listErr)
			continue
		}

		banners := make([]DefaultAvatarEntry, 0, len(bannerEntries))
		for _, banner := range bannerEntries {
			if banner.Type == "dir" {
				continue
			}
			bannerName := strings.TrimSpace(banner.Name)
			if bannerName == "" || !isSupportedDefaultAvatarFilename(bannerName) {
				continue
			}
			banners = append(banners, DefaultAvatarEntry{Name: bannerName})
		}
		if len(banners) == 0 {
			continue
		}

		sort.Slice(banners, func(i, j int) bool {
			return strings.ToLower(banners[i].Name) < strings.ToLower(banners[j].Name)
		})
		catalog = append(catalog, DefaultAvatarCategory{
			Name:    categoryName,
			Avatars: banners, // Re-using structs
		})
	}

	sort.Slice(catalog, func(i, j int) bool {
		return strings.ToLower(catalog[i].Name) < strings.ToLower(catalog[j].Name)
	})
	return catalog, nil
}

// GetDefaultBannerBytes reads one default banner file from
// /<root>/Banners/{category}/{filename}.
func (r *Replicator) GetDefaultBannerBytes(ctx context.Context, category, filename string) ([]byte, string, error) {
	if !r.Enabled() {
		return nil, "", fmt.Errorf("replication disabled")
	}

	safeCategory, err := sanitizeDefaultAvatarPathSegment(category, "category")
	if err != nil {
		return nil, "", err
	}
	safeFilename, err := sanitizeDefaultAvatarPathSegment(filename, "filename")
	if err != nil {
		return nil, "", err
	}
	if !isSupportedDefaultAvatarFilename(safeFilename) {
		return nil, "", fmt.Errorf("unsupported banner file type")
	}

	remotePath := r.remotePath(remoteBannersDir, safeCategory, safeFilename)
	data, err := r.client.Get(ctx, remotePath)
	if err != nil {
		return nil, "", err
	}
	return data, safeFilename, nil
}

// EnsureLocalAttachment downloads an attachment from Yandex Disk into local storage.
func (r *Replicator) EnsureLocalAttachment(ctx context.Context, id string, store *storage.Storage) error {
	if !r.Enabled() {
		return fmt.Errorf("replication disabled")
	}
	plaintext, err := r.getDecryptedBytes(ctx, r.blobPath(id))
	if err != nil {
		return err
	}
	return store.Save(id, bytes.NewReader(plaintext))
}

// MirrorMessage publishes a remote message event after a local message was saved.
func (r *Replicator) MirrorMessage(ctx context.Context, payload MessagePayload) error {
	if !r.Enabled() {
		return nil
	}
	if strings.TrimSpace(payload.OriginServer) == "" {
		payload.OriginServer = r.advertiseHost
	}
	eventID, eventPath, err := r.publishEvent(ctx, EventTypeMessage, payload)
	if err != nil {
		return err
	}
	return r.db.MarkSyncEventProcessed(eventPath, eventID)
}

// MirrorMessageDelete publishes a remote delete event after a local message was deleted.
func (r *Replicator) MirrorMessageDelete(ctx context.Context, payload MessageDeletePayload) error {
	if !r.Enabled() {
		return nil
	}
	eventID, eventPath, err := r.publishEvent(ctx, EventTypeMessageDelete, payload)
	if err != nil {
		return err
	}
	return r.db.MarkSyncEventProcessed(eventPath, eventID)
}

// MirrorPresence publishes a remote presence event.
func (r *Replicator) MirrorPresence(ctx context.Context, payload PresencePayload) error {
	if !r.Enabled() {
		return nil
	}
	payload.Username = strings.TrimSpace(payload.Username)
	payload.Status = strings.TrimSpace(strings.ToLower(payload.Status))
	if payload.LastSeen == "" {
		payload.LastSeen = time.Now().UTC().Format(time.RFC3339)
	}
	if strings.TrimSpace(payload.SourceServer) == "" {
		payload.SourceServer = r.advertiseHost
	}
	if payload.Username == "" {
		return fmt.Errorf("presence username is empty")
	}
	if payload.Status == "" {
		return fmt.Errorf("presence status is empty")
	}

	eventID, eventPath, err := r.publishEvent(ctx, EventTypePresence, payload)
	if err != nil {
		return err
	}
	return r.db.MarkSyncEventProcessed(eventPath, eventID)
}

// MirrorReaction publishes a remote reaction event after a local reaction was added or removed.
func (r *Replicator) MirrorReaction(ctx context.Context, payload ReactionPayload) error {
	if !r.Enabled() {
		return nil
	}
	if payload.Timestamp == "" {
		payload.Timestamp = time.Now().UTC().Format(time.RFC3339)
	}
	eventID, eventPath, err := r.publishEvent(ctx, EventTypeReaction, payload)
	if err != nil {
		return err
	}
	return r.db.MarkSyncEventProcessed(eventPath, eventID)
}

// SyncOnce fetches remote event files and imports any event not yet processed locally.
func (r *Replicator) SyncOnce(ctx context.Context) error {
	if !r.Enabled() {
		return nil
	}
	if !r.profileBackfillDone {
		if err := r.backfillMissingProfileMedia(ctx); err != nil {
			slog.Warn("profile media backfill failed", "error", err)
		} else {
			r.profileBackfillDone = true
		}
	}

	paths, err := r.client.List(ctx, r.remotePath(remoteEventsDir))
	if err != nil {
		return fmt.Errorf("listing remote events: %w", err)
	}
	sort.Strings(paths)

	for _, remotePath := range paths {
		if !strings.HasSuffix(remotePath, ".json.enc") {
			continue
		}

		processed, err := r.db.HasProcessedSyncEvent(remotePath)
		if err != nil {
			slog.Warn("failed to check sync event", "path", remotePath, "error", err)
			continue
		}
		if processed {
			continue
		}

		raw, err := r.getDecryptedBytes(ctx, remotePath)
		if err != nil {
			slog.Warn("failed to read remote event", "path", remotePath, "error", err)
			continue
		}

		var env EventEnvelope
		if err := json.Unmarshal(raw, &env); err != nil {
			slog.Warn("failed to parse remote event", "path", remotePath, "error", err)
			continue
		}

		if env.OriginNode == r.nodeID {
			if err := r.db.MarkSyncEventProcessed(remotePath, env.ID); err != nil {
				slog.Warn("failed to mark local event as processed", "path", remotePath, "error", err)
			}
			continue
		}

		if err := r.applyEvent(ctx, env); err != nil {
			slog.Warn("failed to import remote event", "path", remotePath, "type", env.Type, "error", err)
			continue
		}
		if err := r.db.MarkSyncEventProcessed(remotePath, env.ID); err != nil {
			slog.Warn("failed to record processed remote event", "path", remotePath, "error", err)
		}
	}

	return nil
}

func (r *Replicator) applyEvent(ctx context.Context, env EventEnvelope) error {
	switch env.Type {
	case EventTypeRegistration:
		var payload RegistrationPayload
		if err := json.Unmarshal(env.Payload, &payload); err != nil {
			return fmt.Errorf("decode registration payload: %w", err)
		}
		return r.applyRegistration(payload)
	case EventTypeMessage:
		var payload MessagePayload
		if err := json.Unmarshal(env.Payload, &payload); err != nil {
			return fmt.Errorf("decode message payload: %w", err)
		}
		return r.applyMessage(ctx, payload)
	case EventTypeMessageDelete:
		var payload MessageDeletePayload
		if err := json.Unmarshal(env.Payload, &payload); err != nil {
			return fmt.Errorf("decode message delete payload: %w", err)
		}
		return r.applyMessageDelete(payload)
	case EventTypePresence:
		var payload PresencePayload
		if err := json.Unmarshal(env.Payload, &payload); err != nil {
			return fmt.Errorf("decode presence payload: %w", err)
		}
		return r.applyPresence(payload)
	case EventTypeReaction:
		var payload ReactionPayload
		if err := json.Unmarshal(env.Payload, &payload); err != nil {
			return fmt.Errorf("decode reaction payload: %w", err)
		}
		return r.applyReaction(payload)
	case EventTypeProfileUpdate:
		var payload ProfileUpdatePayload
		if err := json.Unmarshal(env.Payload, &payload); err != nil {
			return fmt.Errorf("decode profile update payload: %w", err)
		}
		return r.applyProfileUpdate(payload)
	default:
		return fmt.Errorf("unknown event type %q", env.Type)
	}
}

func (r *Replicator) applyRegistration(payload RegistrationPayload) error {
	existing, err := r.db.GetUserByUsername(payload.Username)
	if err != nil {
		return err
	}
	if existing != nil {
		return nil
	}
	_, err = r.db.CreateUser(payload.Username, payload.PasswordHash, int(payload.RoleID))
	return err
}

func (r *Replicator) applyProfileUpdate(payload ProfileUpdatePayload) error {
	username := strings.TrimSpace(payload.Username)
	if username == "" {
		return fmt.Errorf("profile update payload missing username")
	}

	previous := strings.TrimSpace(payload.PreviousUsername)
	var user *db.User
	var err error

	if previous != "" {
		user, err = r.db.GetUserByUsername(previous)
		if err != nil {
			return err
		}
	}
	if user == nil {
		user, err = r.db.GetUserByUsername(username)
		if err != nil {
			return err
		}
	}
	if user == nil {
		return fmt.Errorf("profile user %q not imported yet", username)
	}

	if err := r.ensureAttachmentSnapshot(payload.AvatarAttachment); err != nil {
		return err
	}
	if err := r.ensureAttachmentSnapshot(payload.BannerAttachment); err != nil {
		return err
	}

	avatar := payload.Avatar
	banner := payload.Banner
	if err := r.db.UpdateUserProfile(user.ID, &username, &avatar, &banner); err != nil {
		return err
	}
	r.emitImportedProfile(ImportedProfileUpdate{
		UserID:   user.ID,
		Username: username,
		Avatar:   normalizeProfileMediaPtr(avatar),
		Banner:   normalizeProfileMediaPtr(banner),
	})
	return nil
}

func (r *Replicator) backfillMissingProfileMedia(ctx context.Context) error {
	members, err := r.db.ListMembers()
	if err != nil {
		return err
	}
	for _, member := range members {
		user, getErr := r.db.GetUserByID(member.ID)
		if getErr != nil || user == nil {
			continue
		}

		needAvatar := user.Avatar == nil || strings.TrimSpace(*user.Avatar) == ""
		needBanner := user.Banner == nil || strings.TrimSpace(*user.Banner) == ""
		if !needAvatar && !needBanner {
			continue
		}

		avatarID, bannerID, pickErr := r.pickLatestUserAssetIDs(ctx, user.ID)
		if pickErr != nil {
			slog.Warn("failed to list remote user assets", "user_id", user.ID, "error", pickErr)
			continue
		}

		var avatar *string
		if needAvatar && avatarID != "" {
			value := "/api/v1/files/" + avatarID
			avatar = &value
		}
		var banner *string
		if needBanner && bannerID != "" {
			value := "/api/v1/files/" + bannerID
			banner = &value
		}
		if avatar == nil && banner == nil {
			continue
		}

		if updErr := r.db.UpdateUserProfile(user.ID, nil, avatar, banner); updErr != nil {
			slog.Warn("failed to backfill profile media", "user_id", user.ID, "error", updErr)
			continue
		}

		updated, getUpdatedErr := r.db.GetUserByID(user.ID)
		if getUpdatedErr != nil || updated == nil {
			continue
		}
		r.emitImportedProfile(ImportedProfileUpdate{
			UserID:   updated.ID,
			Username: strings.TrimSpace(updated.Username),
			Avatar:   normalizeProfileMediaForWS(updated.Avatar),
			Banner:   normalizeProfileMediaForWS(updated.Banner),
		})
	}
	return nil
}

func (r *Replicator) pickLatestUserAssetIDs(ctx context.Context, userID int64) (string, string, error) {
	entries, err := r.client.ListEntries(ctx, r.remotePath(remoteUsersDir, fmt.Sprintf("%d", userID)))
	if err != nil {
		return "", "", err
	}

	var latestAvatarID string
	var latestAvatarTime time.Time
	var hasAvatarTime bool
	var latestBannerID string
	var latestBannerTime time.Time
	var hasBannerTime bool

	for _, entry := range entries {
		kind, attachmentID, ok := parseRemoteUserAssetFilename(entry.Name)
		if !ok {
			continue
		}
		modifiedAt, modifiedOK := parseRemoteModifiedTime(entry.Modified)

		switch kind {
		case "avatar":
			if shouldReplaceLatestAsset(latestAvatarID, hasAvatarTime, latestAvatarTime, modifiedOK, modifiedAt) {
				latestAvatarID = attachmentID
				latestAvatarTime = modifiedAt
				hasAvatarTime = modifiedOK
			}
		case "banner":
			if shouldReplaceLatestAsset(latestBannerID, hasBannerTime, latestBannerTime, modifiedOK, modifiedAt) {
				latestBannerID = attachmentID
				latestBannerTime = modifiedAt
				hasBannerTime = modifiedOK
			}
		}
	}

	return latestAvatarID, latestBannerID, nil
}

func parseRemoteUserAssetFilename(name string) (string, string, bool) {
	base := strings.TrimSuffix(strings.TrimSpace(name), ".bin")
	if base == strings.TrimSpace(name) {
		return "", "", false
	}
	parts := strings.SplitN(base, "_", 2)
	if len(parts) != 2 {
		return "", "", false
	}
	kind := strings.ToLower(strings.TrimSpace(parts[0]))
	if kind != "avatar" && kind != "banner" {
		return "", "", false
	}
	attachmentID := strings.TrimSpace(parts[1])
	if attachmentID == "" {
		return "", "", false
	}
	return kind, attachmentID, true
}

func parseRemoteModifiedTime(value string) (time.Time, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return time.Time{}, false
	}
	ts, err := time.Parse(time.RFC3339, trimmed)
	if err != nil {
		return time.Time{}, false
	}
	return ts, true
}

func shouldReplaceLatestAsset(currentID string, currentHasTime bool, currentTime time.Time, nextHasTime bool, nextTime time.Time) bool {
	if currentID == "" {
		return true
	}
	if nextHasTime {
		if !currentHasTime {
			return true
		}
		return nextTime.After(currentTime)
	}
	return false
}

func normalizeProfileMediaForWS(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	copyValue := trimmed
	return &copyValue
}

func normalizeProfileMediaPtr(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	copyValue := value
	return &copyValue
}

func (r *Replicator) applyPresence(payload PresencePayload) error {
	username := strings.TrimSpace(payload.Username)
	if username == "" {
		return fmt.Errorf("presence payload missing username")
	}
	status := strings.TrimSpace(strings.ToLower(payload.Status))
	switch status {
	case "online", "idle", "dnd", "offline":
	default:
		return fmt.Errorf("presence payload has invalid status %q", payload.Status)
	}
	lastSeen := strings.TrimSpace(payload.LastSeen)
	if lastSeen == "" {
		lastSeen = time.Now().UTC().Format(time.RFC3339)
	}

	user, err := r.db.GetUserByUsername(username)
	if err != nil {
		return err
	}
	if user == nil {
		return fmt.Errorf("presence user %q not imported yet", username)
	}
	if err := r.db.UpdateUserStatusAt(user.ID, status, lastSeen); err != nil {
		return err
	}

	r.emitImportedPresence(ImportedPresence{
		UserID:       user.ID,
		Status:       status,
		LastSeen:     lastSeen,
		SourceServer: strings.TrimSpace(payload.SourceServer),
	})
	return nil
}

func (r *Replicator) applyMessage(ctx context.Context, payload MessagePayload) error {
	sender, err := r.db.GetUserByUsername(payload.SenderUsername)
	if err != nil {
		return err
	}
	if sender == nil {
		return fmt.Errorf("sender %q not imported yet", payload.SenderUsername)
	}

	channelID, participantIDs, err := r.resolveChannelReference(
		payload.ChannelKind,
		payload.ChannelID,
		payload.ChannelName,
		payload.DMParticipants,
	)
	if err != nil {
		return err
	}

	if payload.SyncID != "" {
		existingID, findErr := r.db.FindMessageIDBySyncID(payload.SyncID)
		if findErr != nil {
			return findErr
		}
		if existingID > 0 {
			return nil
		}
	}

	msgID, err := r.db.CreateMessageWithTimestampAndSyncID(
		channelID,
		sender.ID,
		payload.Content,
		nil,
		payload.Timestamp,
		payload.SyncID,
	)
	if err != nil {
		return err
	}

	imported := ImportedMessage{
		MessageID:      msgID,
		ChannelID:      channelID,
		ChannelKind:    payload.ChannelKind,
		SenderID:       sender.ID,
		SenderUsername: sender.Username,
		Content:        payload.Content,
		Timestamp:      payload.Timestamp,
		OriginServer:   strings.TrimSpace(payload.OriginServer),
	}
	if payload.ChannelKind == "dm" {
		imported.DMParticipantIDs = participantIDs
	}

	if len(payload.Attachments) == 0 {
		r.emitImportedMessage(imported)
		return nil
	}

	attachmentIDs := make([]string, 0, len(payload.Attachments))
	for _, att := range payload.Attachments {
		existing, getErr := r.db.GetAttachmentByID(att.ID)
		if getErr != nil {
			return getErr
		}
		if existing == nil {
			if createErr := r.db.CreateAttachment(att.ID, att.Filename, att.ID, att.Mime, att.Size, att.Width, att.Height); createErr != nil {
				return createErr
			}
		}
		attachmentIDs = append(attachmentIDs, att.ID)
	}
	if _, err = r.db.LinkAttachmentsToMessage(msgID, attachmentIDs); err != nil {
		return err
	}

	r.emitImportedMessage(imported)
	return nil
}

func (r *Replicator) applyMessageDelete(payload MessageDeletePayload) error {
	channelID, participantIDs, err := r.resolveChannelReference(
		payload.ChannelKind,
		payload.ChannelID,
		payload.ChannelName,
		payload.DMParticipants,
	)
	if err != nil {
		return err
	}

	messageID, err := r.findDeletedMessageTarget(channelID, payload)
	if err != nil {
		return err
	}
	if messageID == 0 {
		return nil
	}
	if err := r.db.SetMessageDeleted(messageID, true); err != nil {
		return err
	}

	r.emitImportedDelete(ImportedDelete{
		MessageID:        messageID,
		ChannelID:        channelID,
		ChannelKind:      payload.ChannelKind,
		DMParticipantIDs: participantIDs,
	})
	return nil
}

func (r *Replicator) applyReaction(payload ReactionPayload) error {
	sender, err := r.db.GetUserByUsername(payload.SenderUsername)
	if err != nil {
		return err
	}
	if sender == nil {
		return fmt.Errorf("reaction sender %q not imported yet", payload.SenderUsername)
	}

	// Find the message by sync_id.
	if payload.MessageSyncID == "" {
		return fmt.Errorf("reaction missing message_sync_id")
	}
	msgID, err := r.db.FindMessageIDBySyncID(payload.MessageSyncID)
	if err != nil {
		return err
	}
	if msgID == 0 {
		// The message hasn't been imported yet — skip silently.
		slog.Debug("applyReaction: message not found for sync_id, skipping", "sync_id", payload.MessageSyncID)
		return nil
	}

	msg, err := r.db.GetMessage(msgID)
	if err != nil || msg == nil {
		return fmt.Errorf("applyReaction: failed to load message %d: %w", msgID, err)
	}

	channelID := msg.ChannelID

	// Resolve DM participant IDs for broadcasting.
	var participantIDs []int64
	if payload.ChannelKind == "dm" {
		for _, uname := range payload.DMParticipants {
			u, uErr := r.db.GetUserByUsername(uname)
			if uErr != nil || u == nil {
				continue
			}
			participantIDs = append(participantIDs, u.ID)
		}
	}

	switch payload.Action {
	case "add":
		if err := r.db.AddReaction(msgID, sender.ID, payload.Emoji); err != nil {
			// Might be a duplicate — not an error for replication.
			slog.Debug("applyReaction: AddReaction failed (possibly duplicate)", "err", err, "msg_id", msgID)
			return nil
		}
	case "remove":
		if err := r.db.RemoveReaction(msgID, sender.ID, payload.Emoji); err != nil {
			// Might already be removed — not an error for replication.
			slog.Debug("applyReaction: RemoveReaction failed", "err", err, "msg_id", msgID)
			return nil
		}
	default:
		return fmt.Errorf("applyReaction: unknown action %q", payload.Action)
	}

	r.emitImportedReaction(ImportedReaction{
		MessageID:        msgID,
		ChannelID:        channelID,
		ChannelKind:      payload.ChannelKind,
		UserID:           sender.ID,
		Emoji:            payload.Emoji,
		Action:           payload.Action,
		DMParticipantIDs: participantIDs,
	})
	return nil
}

func (r *Replicator) findDeletedMessageTarget(channelID int64, payload MessageDeletePayload) (int64, error) {
	if payload.SyncID != "" {
		msgID, err := r.db.FindMessageIDBySyncID(payload.SyncID)
		if err != nil {
			return 0, err
		}
		if msgID > 0 {
			return msgID, nil
		}
	}

	sender, err := r.db.GetUserByUsername(payload.SenderUsername)
	if err != nil {
		return 0, err
	}
	if sender == nil {
		return 0, nil
	}
	return r.db.FindMessageIDByLegacySignature(channelID, sender.ID, payload.Timestamp)
}

func (r *Replicator) resolveChannelReference(channelKind string, channelID int64, channelName string, participants []string) (int64, []int64, error) {
	if channelKind == "dm" {
		if len(participants) < 2 {
			return 0, nil, fmt.Errorf("dm message missing participants")
		}
		userA, err := r.db.GetUserByUsername(participants[0])
		if err != nil {
			return 0, nil, err
		}
		userB, err := r.db.GetUserByUsername(participants[1])
		if err != nil {
			return 0, nil, err
		}
		if userA == nil || userB == nil {
			return 0, nil, fmt.Errorf("dm participants not imported yet")
		}
		ch, _, err := r.db.GetOrCreateDMChannel(userA.ID, userB.ID)
		if err != nil {
			return 0, nil, err
		}
		return ch.ID, []int64{userA.ID, userB.ID}, nil
	}

	if channelID > 0 {
		ch, err := r.db.GetChannel(channelID)
		if err != nil {
			return 0, nil, err
		}
		if ch != nil {
			return ch.ID, nil, nil
		}
	}

	channels, err := r.db.ListChannels()
	if err != nil {
		return 0, nil, err
	}
	for _, ch := range channels {
		if ch.Name == channelName && ch.Type == channelKind {
			return ch.ID, nil, nil
		}
	}
	return 0, nil, fmt.Errorf("channel %q not found locally", channelName)
}

func (r *Replicator) ensureRemoteLayout(ctx context.Context) error {
	for _, p := range []string{
		r.rootPath,
		r.remotePath(remoteEventsDir),
		r.remotePath(remoteUsersDir),
		r.remotePath(remoteBlobsDir),
		r.remotePath(remoteInvitesDir),
		r.remotePath(remoteInvitesDir, remoteLocksDir),
	} {
		if err := r.client.EnsureDir(ctx, p); err != nil {
			return err
		}
	}
	return nil
}

func (r *Replicator) emitImportedMessage(msg ImportedMessage) {
	if r.importedHook == nil {
		return
	}
	defer func() {
		if rec := recover(); rec != nil {
			slog.Warn("imported message hook panicked", "panic", rec)
		}
	}()
	r.importedHook(msg)
}

func (r *Replicator) emitImportedDelete(event ImportedDelete) {
	if r.deletedHook == nil {
		return
	}
	defer func() {
		if rec := recover(); rec != nil {
			slog.Warn("imported delete hook panicked", "panic", rec)
		}
	}()
	r.deletedHook(event)
}

func (r *Replicator) emitImportedPresence(event ImportedPresence) {
	if r.presenceHook == nil {
		return
	}
	defer func() {
		if rec := recover(); rec != nil {
			slog.Warn("imported presence hook panicked", "panic", rec)
		}
	}()
	r.presenceHook(event)
}

func (r *Replicator) emitImportedReaction(event ImportedReaction) {
	if r.reactionHook == nil {
		return
	}
	defer func() {
		if rec := recover(); rec != nil {
			slog.Warn("imported reaction hook panicked", "panic", rec)
		}
	}()
	r.reactionHook(event)
}

func (r *Replicator) emitImportedProfile(event ImportedProfileUpdate) {
	if r.profileHook == nil {
		return
	}
	defer func() {
		if rec := recover(); rec != nil {
			slog.Warn("imported profile hook panicked", "panic", rec)
		}
	}()
	r.profileHook(event)
}

func (r *Replicator) readInvitePayload(ctx context.Context, code string) (InvitePayload, error) {
	var payload InvitePayload
	raw, err := r.getDecryptedBytes(ctx, r.invitePath(code))
	if err != nil {
		return payload, fmt.Errorf("read invite from Yandex Disk: %w", err)
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return payload, fmt.Errorf("decode invite payload: %w", err)
	}
	return payload, nil
}

func (r *Replicator) acquireInviteLock(ctx context.Context, lockPath string) (bool, error) {
	status, err := r.client.mkdirWithStatus(ctx, lockPath)
	if err != nil {
		return false, err
	}
	if status == 201 {
		return true, nil
	}
	if status == 409 {
		return false, nil
	}
	return false, fmt.Errorf("unexpected invite lock status %d", status)
}

func (r *Replicator) releaseInviteLock(ctx context.Context, lockPath string) {
	if err := r.client.Delete(ctx, lockPath); err != nil {
		slog.Warn("failed to release invite lock", "path", lockPath, "error", err)
	}
}

func (r *Replicator) publishEvent(ctx context.Context, eventType string, payload any) (string, string, error) {
	encodedPayload, err := json.Marshal(payload)
	if err != nil {
		return "", "", fmt.Errorf("marshal event payload: %w", err)
	}

	eventID := uuid.NewString()
	env := EventEnvelope{
		ID:         eventID,
		Type:       eventType,
		OriginNode: r.nodeID,
		CreatedAt:  time.Now().UTC().Format(time.RFC3339),
		Payload:    encodedPayload,
	}

	timestamp := time.Now().UTC().Format("20060102T150405.000000000Z")
	filename := fmt.Sprintf("%s_%s_%s.json.enc", timestamp, eventType, eventID)
	remotePath := r.remotePath(remoteEventsDir, filename)
	if err := r.putEncryptedJSON(ctx, remotePath, env); err != nil {
		return "", "", err
	}
	return eventID, remotePath, nil
}

func (r *Replicator) putEncryptedJSON(ctx context.Context, remotePath string, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("marshal encrypted payload: %w", err)
	}
	return r.putEncryptedBytes(ctx, remotePath, raw, "application/octet-stream")
}

func (r *Replicator) putEncryptedBytes(ctx context.Context, remotePath string, plaintext []byte, contentType string) error {
	encrypted, err := encryptBytes(r.key, plaintext)
	if err != nil {
		return err
	}
	if err := r.client.Put(ctx, remotePath, encrypted, contentType); err != nil {
		return fmt.Errorf("upload to Yandex Disk %s: %w", remotePath, err)
	}
	return nil
}

func (r *Replicator) getDecryptedBytes(ctx context.Context, remotePath string) ([]byte, error) {
	encrypted, err := r.client.Get(ctx, remotePath)
	if err != nil {
		return nil, err
	}
	return decryptBytes(r.key, encrypted)
}

func (r *Replicator) blobPath(id string) string {
	return r.remotePath(remoteBlobsDir, id+".bin")
}

func (r *Replicator) invitePath(code string) string {
	return r.remotePath(remoteInvitesDir, strings.ToLower(strings.TrimSpace(code))+".json.enc")
}

func (r *Replicator) inviteLockPath(code string) string {
	return r.remotePath(remoteInvitesDir, remoteLocksDir, strings.ToLower(strings.TrimSpace(code)))
}

func (r *Replicator) userProfilePath(username string) string {
	return r.remotePath(remoteUsersDir, strings.ToLower(strings.TrimSpace(username))+".json.enc")
}

func (r *Replicator) userAssetPath(userID int64, kind, attachmentID string) string {
	filename := fmt.Sprintf("%s_%s.bin", kind, attachmentID)
	return r.remotePath(remoteUsersDir, fmt.Sprintf("%d", userID), filename)
}

func profileMediaAttachmentID(value string) (string, bool) {
	const filePrefix = "/api/v1/files/"
	trimmed := strings.TrimSpace(value)
	if !strings.HasPrefix(trimmed, filePrefix) {
		return "", false
	}
	attachmentID := strings.TrimPrefix(trimmed, filePrefix)
	if cut := strings.IndexAny(attachmentID, "?#"); cut >= 0 {
		attachmentID = attachmentID[:cut]
	}
	if attachmentID == "" || strings.Contains(attachmentID, "/") {
		return "", false
	}
	return attachmentID, true
}

func (r *Replicator) buildAttachmentPayload(attachmentID string) (*AttachmentPayload, error) {
	att, err := r.db.GetAttachmentByID(attachmentID)
	if err != nil {
		return nil, err
	}
	if att == nil {
		return nil, nil
	}

	return &AttachmentPayload{
		ID:       att.ID,
		Filename: att.Filename,
		Size:     att.Size,
		Mime:     att.MimeType,
	}, nil
}

func (r *Replicator) ensureAttachmentSnapshot(att *AttachmentPayload) error {
	if att == nil {
		return nil
	}
	existing, err := r.db.GetAttachmentByID(att.ID)
	if err != nil {
		return err
	}
	if existing != nil {
		return nil
	}
	if err := r.db.CreateAttachment(att.ID, att.Filename, att.ID, att.Mime, att.Size, att.Width, att.Height); err != nil {
		if db.IsUniqueConstraintError(err) {
			return nil
		}
		return err
	}
	return nil
}

func (r *Replicator) remotePath(parts ...string) string {
	all := append([]string{r.rootPath}, parts...)
	return normalizeRemotePath(path.Join(all...))
}

func deriveEncryptionKey(cfg config.YandexDiskConfig) ([]byte, error) {
	key := strings.TrimSpace(cfg.EncryptionKey)
	if key == "" {
		sum := sha256.Sum256([]byte("rylo-ydisk:" + cfg.OAuthToken))
		return sum[:], nil
	}

	if decoded, err := hex.DecodeString(key); err == nil && len(decoded) == 32 {
		return decoded, nil
	}
	if decoded, err := base64.StdEncoding.DecodeString(key); err == nil && len(decoded) == 32 {
		return decoded, nil
	}
	if len(key) == 32 {
		return []byte(key), nil
	}

	return nil, fmt.Errorf("invalid yandex_disk.encryption_key: expected 32-byte raw/base64/hex key")
}

func normalizeRemotePath(p string) string {
	if p == "" {
		return "/"
	}
	cleaned := path.Clean("/" + strings.TrimSpace(p))
	if cleaned == "." {
		return "/"
	}
	return cleaned
}

func sanitizeDefaultAvatarPathSegment(value, fieldName string) (string, error) {
	sanitized := strings.TrimSpace(value)
	if sanitized == "" {
		return "", fmt.Errorf("%s is required", fieldName)
	}
	if sanitized == "." || sanitized == ".." {
		return "", fmt.Errorf("invalid %s", fieldName)
	}
	if strings.ContainsAny(sanitized, "/\\") {
		return "", fmt.Errorf("invalid %s", fieldName)
	}
	for _, r := range sanitized {
		if r < 32 {
			return "", fmt.Errorf("invalid %s", fieldName)
		}
	}
	return sanitized, nil
}

func isSupportedDefaultAvatarFilename(filename string) bool {
	switch strings.ToLower(path.Ext(filename)) {
	case ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif":
		return true
	default:
		return false
	}
}

func validateInvitePayload(inv InvitePayload, now time.Time) error {
	if inv.Revoked {
		return fmt.Errorf("invite is revoked")
	}
	if inv.MaxUses != nil && inv.UseCount >= *inv.MaxUses {
		return fmt.Errorf("invite is exhausted")
	}
	if inv.ExpiresAt != nil && strings.TrimSpace(*inv.ExpiresAt) != "" {
		expiresAt, err := time.Parse(time.RFC3339, strings.TrimSpace(*inv.ExpiresAt))
		if err != nil {
			return fmt.Errorf("invite expiration is invalid")
		}
		if !expiresAt.After(now) {
			return fmt.Errorf("invite is expired")
		}
	}
	return nil
}

func encryptBytes(key, plaintext []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create gcm: %w", err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("read nonce: %w", err)
	}
	ciphertext := gcm.Seal(nil, nonce, plaintext, nil)
	return append(nonce, ciphertext...), nil
}

func decryptBytes(key, ciphertext []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create gcm: %w", err)
	}
	if len(ciphertext) < gcm.NonceSize() {
		return nil, fmt.Errorf("ciphertext too short")
	}
	nonce := ciphertext[:gcm.NonceSize()]
	payload := ciphertext[gcm.NonceSize():]
	plaintext, err := gcm.Open(nil, nonce, payload, nil)
	if err != nil {
		return nil, fmt.Errorf("decrypt payload: %w", err)
	}
	return plaintext, nil
}

type webDAVClient struct {
	baseURL string
	token   string
	client  *http.Client
}

type webDAVResourceEntry struct {
	Path     string
	Type     string
	Name     string
	Modified string
}

func newWebDAVClient(baseURL, token string) *webDAVClient {
	trimmed := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if trimmed == "" || strings.Contains(trimmed, "webdav.yandex.ru") {
		trimmed = "https://cloud-api.yandex.net/v1/disk"
	}
	return &webDAVClient{
		baseURL: trimmed,
		token:   strings.TrimSpace(token),
		client:  &http.Client{Timeout: 60 * time.Second},
	}
}

func (c *webDAVClient) EnsureDir(ctx context.Context, remotePath string) error {
	parts := strings.Split(strings.Trim(normalizeRemotePath(remotePath), "/"), "/")
	cur := ""
	for _, part := range parts {
		cur = path.Join(cur, part)
		if err := c.mkdir(ctx, "/"+cur); err != nil {
			return err
		}
	}
	return nil
}

func (c *webDAVClient) Exists(ctx context.Context, remotePath string) (bool, error) {
	_, status, err := c.resourceMeta(ctx, remotePath)
	if err != nil {
		return false, err
	}
	switch status {
	case 200:
		return true, nil
	case 404:
		return false, nil
	default:
		return false, fmt.Errorf("resource lookup %s: unexpected status %d", remotePath, status)
	}
}

func (c *webDAVClient) Put(ctx context.Context, remotePath string, body []byte, contentType string) error {
	type uploadResponse struct {
		Href string `json:"href"`
	}
	var upload uploadResponse
	status, err := c.apiJSON(ctx, http.MethodGet, "/resources/upload", map[string]string{
		"path":      toDiskPath(remotePath),
		"overwrite": "true",
	}, nil, &upload)
	if err != nil {
		return err
	}
	if status != 200 {
		return fmt.Errorf("get upload url %s: unexpected status %d", remotePath, status)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPut, upload.Href, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", contentType)
	resp, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 201 && resp.StatusCode != 202 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("upload %s: status %d: %s", remotePath, resp.StatusCode, strings.TrimSpace(string(data)))
	}
	return nil
}

func (c *webDAVClient) Get(ctx context.Context, remotePath string) ([]byte, error) {
	type downloadResponse struct {
		Href string `json:"href"`
	}
	var download downloadResponse
	status, err := c.apiJSON(ctx, http.MethodGet, "/resources/download", map[string]string{
		"path": toDiskPath(remotePath),
	}, nil, &download)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("get download url %s: unexpected status %d", remotePath, status)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, download.Href, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return nil, fmt.Errorf("download %s: status %d: %s", remotePath, resp.StatusCode, strings.TrimSpace(string(data)))
	}
	return io.ReadAll(resp.Body)
}

func (c *webDAVClient) Delete(ctx context.Context, remotePath string) error {
	status, err := c.apiJSON(ctx, http.MethodDelete, "/resources", map[string]string{
		"path":        toDiskPath(remotePath),
		"permanently": "true",
	}, nil, nil)
	if err != nil {
		return err
	}
	if status != 202 && status != 204 && status != 404 {
		return fmt.Errorf("delete %s: unexpected status %d", remotePath, status)
	}
	return nil
}

func (c *webDAVClient) List(ctx context.Context, remotePath string) ([]string, error) {
	entries, err := c.ListEntries(ctx, remotePath)
	if err != nil {
		return nil, err
	}
	results := make([]string, 0, len(entries))
	for _, entry := range entries {
		results = append(results, entry.Path)
	}
	return results, nil
}

func (c *webDAVClient) ListEntries(ctx context.Context, remotePath string) ([]webDAVResourceEntry, error) {
	type embeddedItem struct {
		Path     string `json:"path"`
		Type     string `json:"type"`
		Name     string `json:"name"`
		Modified string `json:"modified"`
	}
	type embedded struct {
		Items []embeddedItem `json:"items"`
	}
	type resourceResponse struct {
		Embedded embedded `json:"_embedded"`
	}
	var resource resourceResponse
	status, err := c.apiJSON(ctx, http.MethodGet, "/resources", map[string]string{
		"path":  toDiskPath(remotePath),
		"limit": "10000",
	}, nil, &resource)
	if err != nil {
		return nil, err
	}
	if status == 404 {
		return []webDAVResourceEntry{}, nil
	}
	if status != 200 {
		return nil, fmt.Errorf("list %s: unexpected status %d", remotePath, status)
	}
	results := make([]webDAVResourceEntry, 0, len(resource.Embedded.Items))
	for _, item := range resource.Embedded.Items {
		results = append(results, webDAVResourceEntry{
			Path:     fromDiskPath(item.Path),
			Type:     strings.TrimSpace(item.Type),
			Name:     strings.TrimSpace(item.Name),
			Modified: strings.TrimSpace(item.Modified),
		})
	}
	return results, nil
}

func (c *webDAVClient) mkdir(ctx context.Context, remotePath string) error {
	status, err := c.mkdirWithStatus(ctx, remotePath)
	if err != nil {
		return err
	}
	if status == 201 || status == 409 {
		return nil
	}
	return fmt.Errorf("create dir %s: unexpected status %d", remotePath, status)
}

func (c *webDAVClient) mkdirWithStatus(ctx context.Context, remotePath string) (int, error) {
	status, err := c.apiJSON(ctx, http.MethodPut, "/resources", map[string]string{
		"path": toDiskPath(remotePath),
	}, nil, nil)
	if err != nil {
		return 0, err
	}
	return status, nil
}

func (c *webDAVClient) resourceMeta(ctx context.Context, remotePath string) ([]byte, int, error) {
	return c.api(ctx, http.MethodGet, "/resources", map[string]string{
		"path": toDiskPath(remotePath),
	}, nil)
}

func (c *webDAVClient) apiJSON(ctx context.Context, method, endpoint string, query map[string]string, body io.Reader, out any) (int, error) {
	raw, status, err := c.api(ctx, method, endpoint, query, body)
	if err != nil {
		return 0, err
	}
	if out != nil && len(raw) > 0 && status >= 200 && status < 300 {
		if err := json.Unmarshal(raw, out); err != nil {
			return status, fmt.Errorf("decode json %s: %w", endpoint, err)
		}
	}
	return status, nil
}

func (c *webDAVClient) api(ctx context.Context, method, endpoint string, query map[string]string, body io.Reader) ([]byte, int, error) {
	u, err := url.Parse(c.baseURL + endpoint)
	if err != nil {
		return nil, 0, err
	}
	values := u.Query()
	for key, value := range query {
		values.Set(key, value)
	}
	u.RawQuery = values.Encode()

	req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "OAuth "+c.token)
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	payload, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if readErr != nil {
		return nil, 0, readErr
	}
	if resp.StatusCode >= 400 && resp.StatusCode != 404 && resp.StatusCode != 409 {
		return nil, resp.StatusCode, fmt.Errorf("%s %s: status %d: %s", method, endpoint, resp.StatusCode, strings.TrimSpace(string(payload)))
	}
	return payload, resp.StatusCode, nil
}

func toDiskPath(remotePath string) string {
	return "disk:" + normalizeRemotePath(remotePath)
}

func fromDiskPath(diskPath string) string {
	return normalizeRemotePath(strings.TrimPrefix(diskPath, "disk:"))
}
