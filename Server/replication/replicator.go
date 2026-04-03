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
	remoteEventsDir = "events"
	remoteUsersDir  = "users"
	remoteBlobsDir  = "blobs"
)

const (
	EventTypeRegistration = "registration"
	EventTypeMessage      = "message"
)

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
	ChannelKind    string              `json:"channel_kind"`
	ChannelID      int64               `json:"channel_id"`
	ChannelName    string              `json:"channel_name"`
	SenderUsername string              `json:"sender_username"`
	Content        string              `json:"content"`
	Timestamp      string              `json:"timestamp"`
	DMParticipants []string            `json:"dm_participants,omitempty"`
	Attachments    []AttachmentPayload `json:"attachments,omitempty"`
}

type PreparedRegistration struct {
	ProfilePath string
	EventPath   string
	EventID     string
}

// Replicator mirrors selected Rylo data to a shared Yandex Disk folder and
// imports new remote events back into the local database.
type Replicator struct {
	enabled      bool
	db           *db.DB
	client       *webDAVClient
	key          []byte
	rootPath     string
	nodeID       string
	pollInterval time.Duration
	stopCh       chan struct{}
}

// New creates a Yandex Disk replicator. When the feature is disabled, a
// disabled replicator is returned so callers can unconditionally invoke it.
func New(cfg config.YandexDiskConfig, database *db.DB) (*Replicator, error) {
	r := &Replicator{
		enabled:      cfg.Enabled && strings.TrimSpace(cfg.OAuthToken) != "",
		db:           database,
		rootPath:     normalizeRemotePath(cfg.RootPath),
		nodeID:       uuid.NewString(),
		pollInterval: time.Duration(cfg.PollIntervalSeconds) * time.Second,
		stopCh:       make(chan struct{}),
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
	eventID, eventPath, err := r.publishEvent(ctx, EventTypeMessage, payload)
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

func (r *Replicator) applyMessage(ctx context.Context, payload MessagePayload) error {
	sender, err := r.db.GetUserByUsername(payload.SenderUsername)
	if err != nil {
		return err
	}
	if sender == nil {
		return fmt.Errorf("sender %q not imported yet", payload.SenderUsername)
	}

	channelID, err := r.resolveChannelID(payload)
	if err != nil {
		return err
	}

	msgID, err := r.db.CreateMessageWithTimestamp(channelID, sender.ID, payload.Content, nil, payload.Timestamp)
	if err != nil {
		return err
	}

	if len(payload.Attachments) == 0 {
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
	_, err = r.db.LinkAttachmentsToMessage(msgID, attachmentIDs)
	return err
}

func (r *Replicator) resolveChannelID(payload MessagePayload) (int64, error) {
	if payload.ChannelKind == "dm" {
		if len(payload.DMParticipants) < 2 {
			return 0, fmt.Errorf("dm message missing participants")
		}
		userA, err := r.db.GetUserByUsername(payload.DMParticipants[0])
		if err != nil {
			return 0, err
		}
		userB, err := r.db.GetUserByUsername(payload.DMParticipants[1])
		if err != nil {
			return 0, err
		}
		if userA == nil || userB == nil {
			return 0, fmt.Errorf("dm participants not imported yet")
		}
		ch, _, err := r.db.GetOrCreateDMChannel(userA.ID, userB.ID)
		if err != nil {
			return 0, err
		}
		return ch.ID, nil
	}

	if payload.ChannelID > 0 {
		ch, err := r.db.GetChannel(payload.ChannelID)
		if err != nil {
			return 0, err
		}
		if ch != nil {
			return ch.ID, nil
		}
	}

	channels, err := r.db.ListChannels()
	if err != nil {
		return 0, err
	}
	for _, ch := range channels {
		if ch.Name == payload.ChannelName && ch.Type == payload.ChannelKind {
			return ch.ID, nil
		}
	}
	return 0, fmt.Errorf("channel %q not found locally", payload.ChannelName)
}

func (r *Replicator) ensureRemoteLayout(ctx context.Context) error {
	for _, p := range []string{
		r.rootPath,
		r.remotePath(remoteEventsDir),
		r.remotePath(remoteUsersDir),
		r.remotePath(remoteBlobsDir),
	} {
		if err := r.client.EnsureDir(ctx, p); err != nil {
			return err
		}
	}
	return nil
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

func (r *Replicator) userProfilePath(username string) string {
	return r.remotePath(remoteUsersDir, strings.ToLower(strings.TrimSpace(username))+".json.enc")
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
	type embeddedItem struct {
		Path string `json:"path"`
		Type string `json:"type"`
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
		return []string{}, nil
	}
	if status != 200 {
		return nil, fmt.Errorf("list %s: unexpected status %d", remotePath, status)
	}
	results := make([]string, 0, len(resource.Embedded.Items))
	for _, item := range resource.Embedded.Items {
		results = append(results, fromDiskPath(item.Path))
	}
	return results, nil
}

func (c *webDAVClient) mkdir(ctx context.Context, remotePath string) error {
	status, err := c.apiJSON(ctx, http.MethodPut, "/resources", map[string]string{
		"path": toDiskPath(remotePath),
	}, nil, nil)
	if err != nil {
		return err
	}
	if status == 201 || status == 409 {
		return nil
	}
	if status == 409 {
		return nil
	}
	return fmt.Errorf("create dir %s: unexpected status %d", remotePath, status)
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
