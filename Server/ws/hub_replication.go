package ws

import (
	"log/slog"

	"github.com/rylo/server/replication"
)

// HandleReplicatedMessage pushes an imported Yandex Disk message to connected
// clients immediately, so cross-server delivery does not wait for a manual refresh.
func (h *Hub) HandleReplicatedMessage(msg replication.ImportedMessage) {
	if msg.MessageID <= 0 || msg.ChannelID <= 0 || msg.SenderID <= 0 {
		return
	}

	sender, err := h.db.GetUserByID(msg.SenderID)
	if err != nil {
		slog.Error("HandleReplicatedMessage GetUserByID", "err", err, "sender_id", msg.SenderID)
		return
	}
	if sender == nil {
		slog.Warn("HandleReplicatedMessage sender missing", "sender_id", msg.SenderID)
		return
	}

	roleName := ""
	if sender.RoleID > 0 {
		role, roleErr := h.db.GetRoleByID(sender.RoleID)
		if roleErr != nil {
			slog.Warn("HandleReplicatedMessage GetRoleByID", "err", roleErr, "role_id", sender.RoleID)
		} else if role != nil {
			roleName = role.Name
		}
	}

	attachments := []map[string]any{}
	attMap, attErr := h.db.GetAttachmentsByMessageIDs([]int64{msg.MessageID})
	if attErr != nil {
		slog.Warn("HandleReplicatedMessage GetAttachmentsByMessageIDs", "err", attErr, "msg_id", msg.MessageID)
	} else {
		for _, ai := range attMap[msg.MessageID] {
			attachments = append(attachments, map[string]any{
				"id":       ai.ID,
				"filename": ai.Filename,
				"size":     ai.Size,
				"mime":     ai.Mime,
				"url":      ai.URL,
			})
		}
	}

	broadcast := buildChatMessage(
		msg.MessageID,
		msg.ChannelID,
		sender.ID,
		sender.Username,
		sender.Avatar,
		roleName,
		msg.Content,
		msg.Timestamp,
		nil,
		attachments,
		msg.OriginServer,
	)

	if msg.ChannelKind == "dm" {
		participantIDs := msg.DMParticipantIDs
		if len(participantIDs) == 0 {
			loaded, loadErr := h.db.GetDMParticipantIDs(msg.ChannelID)
			if loadErr != nil {
				slog.Error("HandleReplicatedMessage GetDMParticipantIDs", "err", loadErr, "channel_id", msg.ChannelID)
				return
			}
			participantIDs = loaded
		}

		for _, pid := range participantIDs {
			h.SendToUser(pid, broadcast)
		}

		for _, pid := range participantIDs {
			if pid == sender.ID {
				continue
			}
			if openErr := h.db.OpenDM(pid, msg.ChannelID); openErr != nil {
				slog.Error("HandleReplicatedMessage OpenDM", "err", openErr, "recipient_id", pid, "channel_id", msg.ChannelID)
				continue
			}
			h.SendToUser(pid, buildDMChannelOpen(msg.ChannelID, sender))
		}
		return
	}

	h.BroadcastToChannel(msg.ChannelID, broadcast)
}

// HandleReplicatedDelete pushes an imported Yandex Disk deletion to connected clients.
func (h *Hub) HandleReplicatedDelete(event replication.ImportedDelete) {
	if event.MessageID <= 0 || event.ChannelID <= 0 {
		return
	}

	deletedMsg := buildChatDeleted(event.MessageID, event.ChannelID)
	if event.ChannelKind == "dm" {
		participantIDs := event.DMParticipantIDs
		if len(participantIDs) == 0 {
			loaded, err := h.db.GetDMParticipantIDs(event.ChannelID)
			if err != nil {
				slog.Error("HandleReplicatedDelete GetDMParticipantIDs", "err", err, "channel_id", event.ChannelID)
				return
			}
			participantIDs = loaded
		}

		for _, pid := range participantIDs {
			h.SendToUser(pid, deletedMsg)
		}
		return
	}

	h.BroadcastToChannel(event.ChannelID, deletedMsg)
}

// HandleReplicatedPresence broadcasts imported presence updates from Yandex
// Disk to currently connected clients.
func (h *Hub) HandleReplicatedPresence(event replication.ImportedPresence) {
	if event.UserID <= 0 {
		return
	}
	if event.Status == "" {
		return
	}
	var lastSeenPtr *string
	if event.LastSeen != "" {
		lastSeen := event.LastSeen
		lastSeenPtr = &lastSeen
	}
	h.BroadcastToAll(buildPresenceMsg(event.UserID, event.Status, lastSeenPtr))
	slog.Debug("replicated presence applied",
		"user_id", event.UserID,
		"status", event.Status,
		"source_server", event.SourceServer)
}

// HandleReplicatedReaction pushes an imported Yandex Disk reaction to connected
// clients immediately, so cross-server delivery does not wait for a manual refresh.
func (h *Hub) HandleReplicatedReaction(event replication.ImportedReaction) {
	if event.MessageID <= 0 || event.ChannelID <= 0 || event.UserID <= 0 {
		return
	}

	reactionMsg := buildReactionUpdate(event.MessageID, event.ChannelID, event.UserID, event.Emoji, event.Action)
	if event.ChannelKind == "dm" {
		participantIDs := event.DMParticipantIDs
		if len(participantIDs) == 0 {
			loaded, err := h.db.GetDMParticipantIDs(event.ChannelID)
			if err != nil {
				slog.Error("HandleReplicatedReaction GetDMParticipantIDs", "err", err, "channel_id", event.ChannelID)
				return
			}
			participantIDs = loaded
		}

		for _, pid := range participantIDs {
			h.SendToUser(pid, reactionMsg)
		}
		return
	}

	h.BroadcastToChannel(event.ChannelID, reactionMsg)
}
