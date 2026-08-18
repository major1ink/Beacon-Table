package service

import (
	"context"
	"strings"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository"
)

// PlaylistService — библиотека плейлистов канала ДМ (см. Room/CueState):
// именованные плейлисты, в каждом — упорядоченный список треков.
type PlaylistService interface {
	List(ctx context.Context) ([]*domain.Playlist, error)
	Create(ctx context.Context, name string) (*domain.Playlist, error)
	Rename(ctx context.Context, id, name string) error
	Delete(ctx context.Context, id string) error
	AddTrack(ctx context.Context, playlistID, url, name string, volume float64, loop bool) (*domain.PlaylistTrack, error)
	UpdateTrack(ctx context.Context, playlistID, trackID, name string, volume float64, loop bool) error
	DeleteTrack(ctx context.Context, playlistID, trackID string) error
	// MoveTrack переставляет трек кнопками ↑/↓: direction — "up" | "down"
	// (любое другое значение трактуется как "up", как и раньше).
	MoveTrack(ctx context.Context, playlistID, trackID, direction string) error
}

type playlistService struct {
	playlists repository.PlaylistRepository
}

func NewPlaylistService(playlists repository.PlaylistRepository) PlaylistService {
	return &playlistService{playlists: playlists}
}

func (s *playlistService) List(ctx context.Context) ([]*domain.Playlist, error) {
	return s.playlists.List(ctx)
}

func (s *playlistService) Create(ctx context.Context, name string) (*domain.Playlist, error) {
	name, err := validatePlaylistName(name)
	if err != nil {
		return nil, err
	}
	id := newID()
	if err := s.playlists.Create(ctx, id, name); err != nil {
		return nil, err
	}
	return &domain.Playlist{ID: id, Name: name}, nil
}

func (s *playlistService) Rename(ctx context.Context, id, name string) error {
	name, err := validatePlaylistName(name)
	if err != nil {
		return err
	}
	found, err := s.playlists.Rename(ctx, id, name)
	if err != nil {
		return err
	}
	if !found {
		return domain.ErrNotFound
	}
	return nil
}

func (s *playlistService) Delete(ctx context.Context, id string) error {
	return s.playlists.Delete(ctx, id)
}

func (s *playlistService) AddTrack(ctx context.Context, playlistID, url, name string, volume float64, loop bool) (*domain.PlaylistTrack, error) {
	name = strings.TrimSpace(name)
	url = strings.TrimSpace(url)
	if name == "" || url == "" {
		return nil, &domain.ValidationError{Msg: "нужны имя и url трека (см. /upload)"}
	}
	volume = clampVolume(volume)
	id := newID()
	if err := s.playlists.AddTrack(ctx, id, playlistID, url, name, volume, loop); err != nil {
		return nil, err
	}
	return &domain.PlaylistTrack{ID: id, PlaylistID: playlistID, URL: url, Name: name, Volume: volume, Loop: loop}, nil
}

func (s *playlistService) UpdateTrack(ctx context.Context, playlistID, trackID, name string, volume float64, loop bool) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return &domain.ValidationError{Msg: "имя трека обязательно"}
	}
	volume = clampVolume(volume)
	found, err := s.playlists.UpdateTrack(ctx, trackID, playlistID, name, volume, loop)
	if err != nil {
		return err
	}
	if !found {
		return domain.ErrNotFound
	}
	return nil
}

func (s *playlistService) DeleteTrack(ctx context.Context, playlistID, trackID string) error {
	found, err := s.playlists.DeleteTrack(ctx, trackID, playlistID)
	if err != nil {
		return err
	}
	if !found {
		return domain.ErrNotFound
	}
	return nil
}

func (s *playlistService) MoveTrack(ctx context.Context, playlistID, trackID, direction string) error {
	dir := -1
	if direction == "down" {
		dir = 1
	}
	return s.playlists.MoveTrack(ctx, playlistID, trackID, dir)
}
