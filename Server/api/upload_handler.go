package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/rylo/server/db"
	"github.com/rylo/server/replication"
	"github.com/rylo/server/storage"
)

// uploadResponse is the JSON shape returned by POST /api/v1/uploads.
type uploadResponse struct {
	ID       string `json:"id"`
	Filename string `json:"filename"`
	Size     int64  `json:"size"`
	Mime     string `json:"mime"`
	URL      string `json:"url"`
	Width    *int   `json:"width,omitempty"`
	Height   *int   `json:"height,omitempty"`
}

type defaultAvatarItemResponse struct {
	Name       string `json:"name"`
	PreviewURL string `json:"preview_url"`
}

type defaultAvatarCategoryResponse struct {
	Name    string                      `json:"name"`
	Avatars []defaultAvatarItemResponse `json:"avatars"`
}

type defaultAvatarCatalogResponse struct {
	Categories []defaultAvatarCategoryResponse `json:"categories"`
}

type selectDefaultAvatarRequest struct {
	Category string `json:"category"`
	Name     string `json:"name"`
}

type selectDefaultBannerRequest struct {
	Category string `json:"category"`
	Name     string `json:"name"`
}

const (
	uploadMirrorAttemptTimeout    = 3 * time.Minute
	uploadMirrorBackgroundRetries = 8
	uploadMirrorBackgroundDelay   = 15 * time.Second
)

// MountUploadRoutes registers upload and file-serving endpoints.
// allowedOrigins controls the Access-Control-Allow-Origin header on served files.
func MountUploadRoutes(
	r chi.Router,
	database *db.DB,
	store *storage.Storage,
	uploadMaxSizeMB int,
	allowedOrigins []string,
	replicator *replication.Replicator,
	profileBroadcaster ProfileBroadcaster,
) {
	// Upload requires authentication and a higher body size limit.
	maxUploadBytes := int64(uploadMaxSizeMB) * 1024 * 1024
	if maxUploadBytes <= 0 {
		maxUploadBytes = 100 << 20
	}
	// Add a small overhead allowance for multipart boundaries/headers.
	maxUploadRequestBytes := maxUploadBytes + (2 << 20)

	r.With(
		AuthMiddleware(database),
		MaxBodySize(maxUploadRequestBytes),
	).Post("/api/v1/uploads", handleUpload(database, store, replicator))
	r.With(
		AuthMiddleware(database),
		MaxBodySize(maxUploadRequestBytes),
	).Post("/api/v1/uploads/raw", handleUploadRaw(database, store, replicator))

	// Default avatars (stored in /RyloData/Avatars on Yandex Disk).
	r.With(AuthMiddleware(database)).
		Get("/api/v1/profile/default-avatars", handleListDefaultAvatars(replicator))
	r.Get("/api/v1/profile/default-avatars/{category}/{name}", handleServeDefaultAvatarPreview(replicator))
	r.With(AuthMiddleware(database)).
		Post("/api/v1/profile/default-avatar", handleSelectDefaultAvatar(database, store, replicator, profileBroadcaster))

	// Default banners (stored in /RyloData/Banners on Yandex Disk).
	r.With(AuthMiddleware(database)).
		Get("/api/v1/profile/default-banners", handleListDefaultBanners(replicator))
	r.Get("/api/v1/profile/default-banners/{category}/{name}", handleServeDefaultBannerPreview(replicator))
	r.With(AuthMiddleware(database)).
		Post("/api/v1/profile/default-banner", handleSelectDefaultBanner(database, store, replicator, profileBroadcaster))

	// File serving is public (URLs are unguessable UUIDs).
	r.Get("/api/v1/files/{id}", handleServeFile(database, store, allowedOrigins, replicator))
}

func handleUpload(database *db.DB, store *storage.Storage, replicator *replication.Replicator) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Parse multipart form — 10 MB in memory, rest on disk.
		if err := r.ParseMultipartForm(10 << 20); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error":   "BAD_REQUEST",
				"message": "invalid multipart form",
			})
			return
		}

		file, header, err := r.FormFile("file")
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error":   "BAD_REQUEST",
				"message": "missing file field",
			})
			return
		}
		defer file.Close() //nolint:errcheck

		// Generate UUID for storage.
		fileID := uuid.New().String()

		// Store file on disk (validates file type via magic bytes).
		if err := store.Save(fileID, file); err != nil {
			slog.Warn("file upload rejected", "error", err)
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error":   "BAD_REQUEST",
				"message": fmt.Sprintf("upload rejected: %s", err),
			})
			return
		}

		resp, err := persistStoredAttachment(database, store, fileID, header.Filename)
		if err != nil {
			// Clean up stored file on DB failure.
			_ = store.Delete(fileID)
			slog.Error("failed to create attachment record", "error", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{
				"error":   "INTERNAL_ERROR",
				"message": "failed to save attachment",
			})
			return
		}

		if replicator != nil && replicator.Enabled() {
			// Never block upload success on remote mirror latency/errors.
			// The local file+DB row already exist and can be used immediately.
			scheduleAttachmentMirrorFromStore(replicator, store, fileID)
		}

		slog.Info("file uploaded", "id", fileID, "filename", resp.Filename, "size", resp.Size, "mime", resp.Mime)
		writeJSON(w, http.StatusCreated, resp)
	}
}

func handleUploadRaw(database *db.DB, store *storage.Storage, replicator *replication.Replicator) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		fileID := uuid.New().String()
		filename := r.URL.Query().Get("filename")
		if filename == "" {
			filename = r.Header.Get("X-Filename")
		}
		if filename == "" {
			filename = "upload.bin"
		}

		if err := store.Save(fileID, r.Body); err != nil {
			slog.Warn("raw upload rejected", "error", err)
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error":   "BAD_REQUEST",
				"message": fmt.Sprintf("upload rejected: %s", err),
			})
			return
		}

		resp, err := persistStoredAttachment(database, store, fileID, filename)
		if err != nil {
			_ = store.Delete(fileID)
			slog.Error("failed to create raw attachment record", "error", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{
				"error":   "INTERNAL_ERROR",
				"message": "failed to save attachment",
			})
			return
		}

		if replicator != nil && replicator.Enabled() {
			scheduleAttachmentMirrorFromStore(replicator, store, fileID)
		}

		slog.Info("raw file uploaded", "id", fileID, "filename", resp.Filename, "size", resp.Size, "mime", resp.Mime)
		writeJSON(w, http.StatusCreated, resp)
	}
}

func sanitizeAttachmentFilename(name string) string {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return "upload.bin"
	}
	return filepath.Base(trimmed)
}

func persistStoredAttachment(
	database *db.DB,
	store *storage.Storage,
	fileID string,
	filename string,
) (uploadResponse, error) {
	f, openErr := store.Open(fileID)
	if openErr != nil {
		return uploadResponse{}, openErr
	}
	defer f.Close() //nolint:errcheck

	var sniffBuf [512]byte
	n, readErr := f.Read(sniffBuf[:])
	if readErr != nil && readErr != io.EOF {
		return uploadResponse{}, readErr
	}
	detectedMime := http.DetectContentType(sniffBuf[:n])

	size := int64(n)
	if info, statErr := f.Stat(); statErr == nil {
		size = info.Size()
	}

	if _, seekErr := f.Seek(0, io.SeekStart); seekErr != nil {
		return uploadResponse{}, seekErr
	}

	var width, height *int
	if strings.HasPrefix(detectedMime, "image/") {
		cfg, _, decErr := image.DecodeConfig(f)
		if decErr == nil {
			w2, h2 := cfg.Width, cfg.Height
			width = &w2
			height = &h2
		} else {
			slog.Warn("failed to decode image dimensions", "id", fileID, "error", decErr)
		}
	}

	cleanFilename := sanitizeAttachmentFilename(filename)
	if err := database.CreateAttachment(fileID, cleanFilename, fileID, detectedMime, size, width, height); err != nil {
		return uploadResponse{}, err
	}

	return uploadResponse{
		ID:       fileID,
		Filename: cleanFilename,
		Size:     size,
		Mime:     detectedMime,
		URL:      "/api/v1/files/" + fileID,
		Width:    width,
		Height:   height,
	}, nil
}

func mirrorAttachmentWithRetry(
	ctx context.Context,
	replicator *replication.Replicator,
	fileID string,
	data []byte,
	attempts int,
	baseDelay time.Duration,
) error {
	if replicator == nil || !replicator.Enabled() {
		return nil
	}
	if attempts < 1 {
		attempts = 1
	}

	var lastErr error
	for attempt := 1; attempt <= attempts; attempt++ {
		attemptCtx, cancel := context.WithTimeout(ctx, uploadMirrorAttemptTimeout)
		err := replicator.MirrorAttachment(attemptCtx, fileID, data)
		cancel()
		if err == nil {
			return nil
		}
		lastErr = err

		if attempt >= attempts {
			break
		}
		waitFor := time.Duration(attempt) * baseDelay
		if waitFor <= 0 {
			continue
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(waitFor):
		}
	}
	return lastErr
}

func scheduleAttachmentMirrorRetry(
	replicator *replication.Replicator,
	fileID string,
	data []byte,
) {
	if replicator == nil || !replicator.Enabled() {
		return
	}
	go func() {
		if err := mirrorAttachmentWithRetry(
			context.Background(),
			replicator,
			fileID,
			data,
			uploadMirrorBackgroundRetries,
			uploadMirrorBackgroundDelay,
		); err != nil {
			slog.Error("background attachment mirror failed", "id", fileID, "error", err)
		} else {
			slog.Info("attachment mirrored in background", "id", fileID)
		}
	}()
}

func scheduleAttachmentMirrorFromStore(
	replicator *replication.Replicator,
	store *storage.Storage,
	fileID string,
) {
	if replicator == nil || !replicator.Enabled() || store == nil {
		return
	}
	go func() {
		f, openErr := store.Open(fileID)
		if openErr != nil {
			slog.Error("background mirror: failed to open local attachment", "id", fileID, "error", openErr)
			return
		}
		data, readErr := io.ReadAll(f)
		f.Close() //nolint:errcheck
		if readErr != nil {
			slog.Error("background mirror: failed to read local attachment", "id", fileID, "error", readErr)
			return
		}
		scheduleAttachmentMirrorRetry(replicator, fileID, data)
	}()
}

func handleServeFile(database *db.DB, store *storage.Storage, allowedOrigins []string, replicator *replication.Replicator) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		fileID := chi.URLParam(r, "id")
		if fileID == "" {
			http.NotFound(w, r)
			return
		}

		// Look up attachment metadata.
		att, err := database.GetAttachmentByID(fileID)
		if err != nil {
			slog.Error("failed to look up attachment", "id", fileID, "error", err)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "internal server error",
			})
			return
		}
		if att == nil {
			if replicator == nil || !replicator.Enabled() {
				http.NotFound(w, r)
				return
			}
			if hydrateErr := hydrateMissingAttachmentFromReplicatedBlob(r.Context(), database, store, replicator, fileID); hydrateErr != nil {
				http.NotFound(w, r)
				return
			}
			att, err = database.GetAttachmentByID(fileID)
			if err != nil {
				slog.Error("failed to look up hydrated attachment", "id", fileID, "error", err)
				writeJSON(w, http.StatusInternalServerError, errorResponse{
					Error:   "INTERNAL_ERROR",
					Message: "internal server error",
				})
				return
			}
			if att == nil {
				http.NotFound(w, r)
				return
			}
		}

		// Open file from storage.
		f, err := store.Open(att.StoredAs)
		if err != nil {
			if replicator == nil || !replicator.Enabled() {
				http.NotFound(w, r)
				return
			}
			if hydrateErr := replicator.EnsureLocalAttachment(r.Context(), att.StoredAs, store); hydrateErr != nil {
				http.NotFound(w, r)
				return
			}
			f, err = store.Open(att.StoredAs)
			if err != nil {
				http.NotFound(w, r)
				return
			}
		}
		defer f.Close() //nolint:errcheck

		// Set headers before ServeContent to ensure correct MIME type.
		w.Header().Set("Content-Type", att.MimeType)
		w.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": att.Filename}))
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		// CORS: allow webview to read the response body using configured origins.
		if origin := r.Header.Get("Origin"); origin != "" {
			for _, allowed := range allowedOrigins {
				if allowed == "*" || strings.EqualFold(allowed, origin) {
					w.Header().Set("Access-Control-Allow-Origin", origin)
					w.Header().Set("Access-Control-Expose-Headers", "Content-Type, Content-Length")
					break
				}
			}
		}

		// Use the actual file modification time so If-Modified-Since works correctly.
		var modTime time.Time
		if info, statErr := f.Stat(); statErr == nil {
			modTime = info.ModTime()
		}
		http.ServeContent(w, r, att.Filename, modTime, f)
	}
}

func handleListDefaultAvatars(replicator *replication.Replicator) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if replicator == nil || !replicator.Enabled() {
			writeJSON(w, http.StatusOK, defaultAvatarCatalogResponse{
				Categories: []defaultAvatarCategoryResponse{},
			})
			return
		}

		catalog, err := replicator.ListDefaultAvatarCatalog(r.Context())
		if err != nil {
			slog.Warn("failed to list default avatars from Yandex Disk", "error", err)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to list default avatars",
			})
			return
		}

		categories := make([]defaultAvatarCategoryResponse, 0, len(catalog))
		for _, category := range catalog {
			avatars := make([]defaultAvatarItemResponse, 0, len(category.Avatars))
			for _, avatar := range category.Avatars {
				avatars = append(avatars, defaultAvatarItemResponse{
					Name:       avatar.Name,
					PreviewURL: "/api/v1/profile/default-avatars/" + url.PathEscape(category.Name) + "/" + url.PathEscape(avatar.Name),
				})
			}
			categories = append(categories, defaultAvatarCategoryResponse{
				Name:    category.Name,
				Avatars: avatars,
			})
		}

		writeJSON(w, http.StatusOK, defaultAvatarCatalogResponse{
			Categories: categories,
		})
	}
}

func handleServeDefaultAvatarPreview(replicator *replication.Replicator) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if replicator == nil || !replicator.Enabled() {
			http.NotFound(w, r)
			return
		}

		category := chi.URLParam(r, "category")
		name := chi.URLParam(r, "name")
		data, filename, err := replicator.GetDefaultAvatarBytes(r.Context(), category, name)
		if err != nil {
			http.NotFound(w, r)
			return
		}

		contentType := http.DetectContentType(data)
		if !strings.HasPrefix(contentType, "image/") {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "default avatar is not an image",
			})
			return
		}

		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": filename}))
		w.Header().Set("Cache-Control", "private, max-age=300")
		http.ServeContent(w, r, filename, time.Now().UTC(), bytes.NewReader(data))
	}
}

func handleSelectDefaultAvatar(
	database *db.DB,
	store *storage.Storage,
	replicator *replication.Replicator,
	profileBroadcaster ProfileBroadcaster,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if replicator == nil || !replicator.Enabled() {
			writeJSON(w, http.StatusServiceUnavailable, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "default avatars are unavailable while Yandex Disk sync is disabled",
			})
			return
		}

		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "not authenticated",
			})
			return
		}

		var req selectDefaultAvatarRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "malformed request body",
			})
			return
		}

		data, filename, err := replicator.GetDefaultAvatarBytes(r.Context(), req.Category, req.Name)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "default avatar not found",
			})
			return
		}

		fileID := uuid.New().String()
		if err := store.Save(fileID, bytes.NewReader(data)); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "failed to save selected avatar",
			})
			return
		}

		mimeType := http.DetectContentType(data)
		if !strings.HasPrefix(mimeType, "image/") {
			_ = store.Delete(fileID)
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "selected avatar is not an image",
			})
			return
		}

		var width, height *int
		cfg, _, decodeErr := image.DecodeConfig(bytes.NewReader(data))
		if decodeErr == nil {
			w2 := cfg.Width
			h2 := cfg.Height
			width = &w2
			height = &h2
		}

		if err := database.CreateAttachment(fileID, filename, fileID, mimeType, int64(len(data)), width, height); err != nil {
			_ = store.Delete(fileID)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to persist selected avatar",
			})
			return
		}

		if err := replicator.MirrorAttachment(r.Context(), fileID, data); err != nil {
			_ = store.Delete(fileID)
			_ = database.DeleteAttachmentRecord(fileID)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to mirror selected avatar",
			})
			return
		}

		avatarURL := "/api/v1/files/" + fileID
		if err := database.UpdateUserProfile(user.ID, nil, &avatarURL, nil); err != nil {
			_ = store.Delete(fileID)
			_ = database.DeleteAttachmentRecord(fileID)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to update user avatar",
			})
			return
		}

		if err := replicator.MirrorUserAsset(r.Context(), user.ID, "avatar", fileID); err != nil {
			slog.Warn("failed to mirror selected default avatar as user asset", "user_id", user.ID, "attachment_id", fileID, "error", err)
		}

		updated, err := database.GetUserByID(user.ID)
		if err != nil || updated == nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "avatar updated, but failed to load the latest profile",
			})
			return
		}

		if mirrorErr := replicator.MirrorProfileUpdate(r.Context(), user.Username, updated); mirrorErr != nil {
			slog.Warn("failed to publish avatar profile update", "user_id", user.ID, "error", mirrorErr)
		}
		broadcastMemberProfileUpdate(profileBroadcaster, updated)

		writeJSON(w, http.StatusOK, toUserResponse(updated))
	}
}

func handleListDefaultBanners(replicator *replication.Replicator) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if replicator == nil || !replicator.Enabled() {
			writeJSON(w, http.StatusOK, defaultAvatarCatalogResponse{
				Categories: []defaultAvatarCategoryResponse{},
			})
			return
		}

		catalog, err := replicator.ListDefaultBannerCatalog(r.Context())
		if err != nil {
			slog.Warn("failed to list default banners from Yandex Disk", "error", err)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to list default banners",
			})
			return
		}

		categories := make([]defaultAvatarCategoryResponse, 0, len(catalog))
		for _, category := range catalog {
			banners := make([]defaultAvatarItemResponse, 0, len(category.Avatars))
			for _, banner := range category.Avatars {
				banners = append(banners, defaultAvatarItemResponse{
					Name:       banner.Name,
					PreviewURL: "/api/v1/profile/default-banners/" + url.PathEscape(category.Name) + "/" + url.PathEscape(banner.Name),
				})
			}
			categories = append(categories, defaultAvatarCategoryResponse{
				Name:    category.Name,
				Avatars: banners,
			})
		}

		writeJSON(w, http.StatusOK, defaultAvatarCatalogResponse{
			Categories: categories,
		})
	}
}

func handleServeDefaultBannerPreview(replicator *replication.Replicator) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if replicator == nil || !replicator.Enabled() {
			http.NotFound(w, r)
			return
		}

		category := chi.URLParam(r, "category")
		name := chi.URLParam(r, "name")
		data, filename, err := replicator.GetDefaultBannerBytes(r.Context(), category, name)
		if err != nil {
			http.NotFound(w, r)
			return
		}

		contentType := http.DetectContentType(data)
		if !strings.HasPrefix(contentType, "image/") {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "default banner is not an image",
			})
			return
		}

		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": filename}))
		w.Header().Set("Cache-Control", "private, max-age=300")
		http.ServeContent(w, r, filename, time.Now().UTC(), bytes.NewReader(data))
	}
}

func handleSelectDefaultBanner(
	database *db.DB,
	store *storage.Storage,
	replicator *replication.Replicator,
	profileBroadcaster ProfileBroadcaster,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if replicator == nil || !replicator.Enabled() {
			writeJSON(w, http.StatusServiceUnavailable, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "default banners are unavailable while Yandex Disk sync is disabled",
			})
			return
		}

		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "not authenticated",
			})
			return
		}

		var req selectDefaultBannerRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "malformed request body",
			})
			return
		}
		if req.Category == "" || req.Name == "" {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "category and name are required",
			})
			return
		}

		data, filename, err := replicator.GetDefaultBannerBytes(r.Context(), req.Category, req.Name)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "default banner not found",
			})
			return
		}

		fileID := uuid.New().String()
		if err := store.Save(fileID, bytes.NewReader(data)); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "failed to save selected banner",
			})
			return
		}

		mimeType := http.DetectContentType(data)
		if !strings.HasPrefix(mimeType, "image/") {
			_ = store.Delete(fileID)
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "selected banner is not an image",
			})
			return
		}

		var width, height *int
		cfg, _, decodeErr := image.DecodeConfig(bytes.NewReader(data))
		if decodeErr == nil {
			w2 := cfg.Width
			h2 := cfg.Height
			width = &w2
			height = &h2
		}

		if err := database.CreateAttachment(fileID, filename, fileID, mimeType, int64(len(data)), width, height); err != nil {
			_ = store.Delete(fileID)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to persist selected banner",
			})
			return
		}

		if err := replicator.MirrorAttachment(r.Context(), fileID, data); err != nil {
			_ = store.Delete(fileID)
			_ = database.DeleteAttachmentRecord(fileID)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to mirror selected banner",
			})
			return
		}

		bannerURL := "/api/v1/files/" + fileID
		if updErr := database.UpdateUserProfile(user.ID, nil, nil, &bannerURL); updErr != nil {
			_ = store.Delete(fileID)
			_ = database.DeleteAttachmentRecord(fileID)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to update user banner",
			})
			return
		}

		if mirrorErr := replicator.MirrorUserAsset(r.Context(), user.ID, "banner", fileID); mirrorErr != nil {
			slog.Warn("failed to mirror banner to Yandex Disk", "user_id", user.ID, "error", mirrorErr)
		}

		updated, err := database.GetUserByID(user.ID)
		if err != nil || updated == nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to load updated profile",
			})
			return
		}

		if mirrorErr := replicator.MirrorProfileUpdate(r.Context(), user.Username, updated); mirrorErr != nil {
			slog.Warn("failed to publish banner profile update", "user_id", user.ID, "error", mirrorErr)
		}
		broadcastMemberProfileUpdate(profileBroadcaster, updated)

		writeJSON(w, http.StatusOK, toUserResponse(updated))
	}
}

func hydrateMissingAttachmentFromReplicatedBlob(
	ctx context.Context,
	database *db.DB,
	store *storage.Storage,
	replicator *replication.Replicator,
	fileID string,
) error {
	if replicator == nil || !replicator.Enabled() {
		return fmt.Errorf("replication disabled")
	}
	if err := replicator.EnsureLocalAttachment(ctx, fileID, store); err != nil {
		return err
	}

	f, err := store.Open(fileID)
	if err != nil {
		return err
	}
	defer f.Close() //nolint:errcheck

	var sniff [512]byte
	n, readErr := f.Read(sniff[:])
	if readErr != nil && readErr != io.EOF {
		return readErr
	}
	mimeType := http.DetectContentType(sniff[:n])
	size := int64(n)
	if info, statErr := f.Stat(); statErr == nil {
		size = info.Size()
	}

	if _, seekErr := f.Seek(0, io.SeekStart); seekErr != nil {
		return seekErr
	}

	var width, height *int
	if strings.HasPrefix(mimeType, "image/") {
		cfg, _, decodeErr := image.DecodeConfig(f)
		if decodeErr == nil {
			w2, h2 := cfg.Width, cfg.Height
			width = &w2
			height = &h2
		}
	}

	if err := database.CreateAttachment(fileID, fileID, fileID, mimeType, size, width, height); err != nil {
		if db.IsUniqueConstraintError(err) {
			return nil
		}
		return err
	}
	return nil
}
