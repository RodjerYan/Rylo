package api

import "github.com/rylo/server/db"

// ProfileBroadcaster is the interface needed to send real-time profile updates
// (username/avatar/banner) from REST handlers. Satisfied by *ws.Hub.
type ProfileBroadcaster interface {
	BroadcastMemberProfileUpdate(userID int64, username string, avatar, banner *string)
}

func broadcastMemberProfileUpdate(broadcaster ProfileBroadcaster, user *db.User) {
	if broadcaster == nil || user == nil {
		return
	}
	broadcaster.BroadcastMemberProfileUpdate(user.ID, user.Username, user.Avatar, user.Banner)
}
