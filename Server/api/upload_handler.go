package api

import (
	"bytes"
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

// MountUploadRoutes registers upload and file-serving endpoints.
// allowedOrigins controls the Access-Control-Allow-Origin header on served files.
func MountUploadRoutes(r chi.Router, database *db.DB, store *storage.Storage, allowedOrigins []string, replicator *replication.Replicator) {
	// Upload requires authentication and a higher body size limit (100 MB).
	r.With(
		AuthMiddleware(database),
		MaxBodySize(100<<20),
	).Post("/api/v1/uploads", handleUpload(database, store, replicator))

	// Default avatars (stored in /RyloData/Avatars on Yandex Disk).
	r.With(AuthMiddleware(database)).
		Get("/api/v1/profile/default-avatars", handleListDefaultAvatars(replicator))
	r.Get("/api/v1/profile/default-avatars/{category}/{name}", handleServeDefaultAvatarPreview(replicator))
	r.With(AuthMiddleware(database)).
		Post("/api/v1/profile/default-avatar", handleSelectDefaultAvatar(database, store, replicator))

	// Default banners (stored in /RyloData/Banners on Yandex Disk).
	r.With(AuthMiddleware(database)).
		Get("/api/v1/profile/default-banners", handleListDefaultBanners(replicator))
	r.Get("/api/v1/profile/default-banners/{category}/{name}", handleServeDefaultBannerPreview(replicator))
	r.With(AuthMiddleware(database)).
		Post("/api/v1/profile/default-banner", handleSelectDefaultBanner(database, store, replicator))

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

		// Detect MIME type from actual file bytes (never trust client header).
		var sniffBuf [512]byte
		n, readErr := file.Read(sniffBuf[:])
		if readErr != nil && readErr.Error() != "EOF" && readErr.Error() != "unexpected EOF" {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error":   "BAD_REQUEST",
				"message": "failed to read uploaded file",
			})
			return
		}
		detectedMime := http.DetectContentType(sniffBuf[:n])
		// Seek back so the full content is available for storage.
		if _, seekErr := file.Seek(0, 0); seekErr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{
				"error":   "INTERNAL_ERROR",
				"message": "failed to process uploaded file",
			})
			return
		}
		mime := detectedMime

		// Store file on disk (validates file type via magic bytes).
		if err := store.Save(fileID, file); err != nil {
			slog.Warn("file upload rejected", "error", err)
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error":   "BAD_REQUEST",
				"message": fmt.Sprintf("upload rejected: %s", err),
			})
			return
		}

		// Extract image dimensions if the file is an image.
		var width, height *int
		if strings.HasPrefix(mime, "image/") {
			f, openErr := store.Open(fileID)
			if openErr == nil {
				cfg, _, decErr := image.DecodeConfig(f)
				f.Close() //nolint:errcheck
				if decErr == nil {
					w2, h2 := cfg.Width, cfg.Height
					width = &w2
					height = &h2
				} else {
					slog.Warn("failed to decode image dimensions", "id", fileID, "error", decErr)
				}
			}
		}

		// Insert attachment record in DB (unlinked — message_id is NULL).
		if err := database.CreateAttachment(fileID, header.Filename, fileID, mime, header.Size, width, height); err != nil {
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
			f, openErr := store.Open(fileID)
			if openErr != nil {
				_ = store.Delete(fileID)
				_ = database.DeleteAttachmentRecord(fileID)
				writeJSON(w, http.StatusInternalServerError, map[string]string{
					"error":   "INTERNAL_ERROR",
					"message": "failed to mirror attachment",
				})
				return
			}
			data, readErr := io.ReadAll(f)
			f.Close() //nolint:errcheck
			var mirrorErr error
			if readErr == nil {
				mirrorErr = replicator.MirrorAttachment(r.Context(), fileID, data)
			}
			if readErr != nil || mirrorErr != nil {
				if readErr != nil {
					slog.Error("failed to read local attachment for mirroring", "id", fileID, "error", readErr)
				}
				if mirrorErr != nil {
					slog.Error("failed to mirror attachment to Yandex Disk", "id", fileID, "error", mirrorErr)
				}
				_ = store.Delete(fileID)
				_ = database.DeleteAttachmentRecord(fileID)
				writeJSON(w, http.StatusInternalServerError, map[string]string{
					"error":   "INTERNAL_ERROR",
					"message": "failed to mirror attachment",
				})
				return
			}
		}

		slog.Info("file uploaded", "id", fileID, "filename", header.Filename, "size", header.Size, "mime", mime)

		writeJSON(w, http.StatusCreated, uploadResponse{
			ID:       fileID,
			Filename: header.Filename,
			Size:     header.Size,
			Mime:     mime,
			URL:      "/api/v1/files/" + fileID,
			Width:    width,
			Height:   height,
		})
	}
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
			http.NotFound(w, r)
			return
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

func handleSelectDefaultAvatar(database *db.DB, store *storage.Storage, replicator *replication.Replicator) http.HandlerFunc {
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

func handleSelectDefaultBanner(database *db.DB, store *storage.Storage, replicator *replication.Replicator) http.HandlerFunc {
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
		writeJSON(w, http.StatusOK, toUserResponse(updated))
	}
}
