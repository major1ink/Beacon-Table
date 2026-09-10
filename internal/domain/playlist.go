package domain

import "time"

// PlaylistKindSFX — панель эффектов (soundboard Foundry, mode -1): треки
// играют одноразово по кнопке, а не в канале ДМ. Пустой Kind — обычный.
const PlaylistKindSFX = "sfx"

// Playlist/PlaylistTrack — библиотека ДМ: именованные плейлисты, в каждом —
// упорядоченный список треков (своя громкость/loop на трек). Играются на
// "канале ДМ" (см. CueState), независимо от амбиента конкретной сцены.
// Kind — "" (обычный) | PlaylistKindSFX.
type Playlist struct {
	ID        string
	Name      string
	Kind      string
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
