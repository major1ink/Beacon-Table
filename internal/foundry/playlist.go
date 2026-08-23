package foundry

import (
	"context"
	"strings"

	"beacon-table/internal/domain"
)

// Playlist — плейлист Foundry, уже готовый к заведению через
// service.PlaylistService (см. internal/service/foundry.go). Своим типом, а
// не domain.Playlist: у нашего плейлиста id треков раздаёт сервис при
// добавлении, собирать их здесь было бы вранье.
type Playlist struct {
	Name   string
	Tracks []Track
}

// Track — один трек плейлиста: URL уже наш, файл перенесён из архива.
type Track struct {
	Name   string
	URL    string
	Volume float64
	Loop   bool
}

// MapPlaylist переносит треки плейлиста из архива в библиотеку аудио и
// собирает список. Треки, которых в архиве нет (ссылки на ассеты самого
// Foundry или на внешний стрим), пропускаются — плейлист с битой ссылкой
// хуже, чем плейлист без неё.
func MapPlaylist(ctx context.Context, d Doc, assets *Assets) *Playlist {
	name := strings.TrimSpace(asString(d["name"]))
	if name == "" {
		name = "Плейлист из Foundry"
	}
	p := &Playlist{Name: name}
	for _, raw := range asSlice(d["sounds"]) {
		sound := asMap(raw)
		if sound == nil {
			continue
		}
		url := assets.URL(ctx, domain.AssetKindAudio, asString(sound["path"]))
		if url == "" {
			continue
		}
		trackName := strings.TrimSpace(asString(sound["name"]))
		if trackName == "" {
			trackName = "Без названия"
		}
		p.Tracks = append(p.Tracks, Track{
			Name:   trackName,
			URL:    url,
			Volume: num(sound["volume"], 0.5),
			Loop:   asBool(sound["repeat"]),
		})
	}
	return p
}
