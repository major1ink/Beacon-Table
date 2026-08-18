package domain

import "time"

// Playlist/PlaylistTrack — библиотека ДМ: именованные плейлисты, в каждом —
// упорядоченный список треков (своя громкость/loop на трек). Играются на
// "канале ДМ" (см. CueState), независимо от амбиента конкретной сцены.
type Playlist struct {
	ID        string
	Name      string
	CreatedAt time.Time
	Tracks    []*PlaylistTrack
}

type PlaylistTrack struct {
	ID         string
	PlaylistID string
	URL        string
	Name       string
	Volume     float64
	Loop       bool
	Position   int
}
