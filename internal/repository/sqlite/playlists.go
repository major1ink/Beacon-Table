package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"beacon-table/internal/domain"
)

// PlaylistStore реализует repository.PlaylistRepository, привязанный к
// одной компании (миру), тем же принципом, что и CharacterStore (см.
// комментарий его типа) — пересобирается заново на каждый
// service.CompanyManager.Launch. Треки playlist_tracks сами по себе
// company_id не хранят: они всегда адресуются через playlist_id, а
// playlists уже отфильтрованы по компании в List/Rename/Delete — этого
// достаточно на доверенном масштабе одного ДМ, гоняющего свои же миры (не
// взаимно недоверяющие тенанты).
type PlaylistStore struct {
	db        *sql.DB
	companyID string
}

// NewPlaylistStore строит репозиторий плейлистов поверх db, открытого Open,
// для компании companyID.
func NewPlaylistStore(db *sql.DB, companyID string) *PlaylistStore {
	return &PlaylistStore{db: db, companyID: companyID}
}

func scanPlaylistTrack(row interface{ Scan(...any) error }) (*domain.PlaylistTrack, error) {
	var t domain.PlaylistTrack
	var loop int
	if err := row.Scan(&t.ID, &t.PlaylistID, &t.URL, &t.Name, &t.Volume, &loop, &t.Position); err != nil {
		return nil, err
	}
	t.Loop = loop != 0
	return &t, nil
}

// Create implements repository.PlaylistRepository.
func (s *PlaylistStore) Create(ctx context.Context, id, name string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO playlists (id, name, company_id, created_at) VALUES (?, ?, ?, ?)`, id, name, s.companyID, time.Now().Format(timeLayout))
	return err
}

// Rename implements repository.PlaylistRepository.
func (s *PlaylistStore) Rename(ctx context.Context, id, name string) (bool, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE playlists SET name = ? WHERE id = ? AND company_id = ?`, name, id, s.companyID)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// Delete implements repository.PlaylistRepository.
func (s *PlaylistStore) Delete(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM playlists WHERE id = ? AND company_id = ?`, id, s.companyID)
	return err
}

// List implements repository.PlaylistRepository. Отдаёт все плейлисты ЭТОЙ
// компании с уже подгруженными треками одним заходом: у ДМ их обычно
// единицы-десятки, дешевле отдать всё разом, чем городить N+1 запросов с
// клиента на каждое открытие модалки "Плейлисты".
func (s *PlaylistStore) List(ctx context.Context) ([]*domain.Playlist, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, created_at FROM playlists WHERE company_id = ? ORDER BY created_at`, s.companyID)
	if err != nil {
		return nil, err
	}
	var playlists []*domain.Playlist
	for rows.Next() {
		var p domain.Playlist
		var createdAt string
		if err := rows.Scan(&p.ID, &p.Name, &createdAt); err != nil {
			rows.Close()
			return nil, err
		}
		p.CreatedAt, _ = time.Parse(timeLayout, createdAt)
		playlists = append(playlists, &p)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	trackRows, err := s.db.QueryContext(ctx, `SELECT id, playlist_id, url, name, volume, loop, position FROM playlist_tracks ORDER BY playlist_id, position`)
	if err != nil {
		return nil, err
	}
	defer trackRows.Close()
	byPlaylist := make(map[string][]*domain.PlaylistTrack)
	for trackRows.Next() {
		t, err := scanPlaylistTrack(trackRows)
		if err != nil {
			return nil, err
		}
		byPlaylist[t.PlaylistID] = append(byPlaylist[t.PlaylistID], t)
	}
	if err := trackRows.Err(); err != nil {
		return nil, err
	}
	for _, p := range playlists {
		p.Tracks = byPlaylist[p.ID]
	}
	return playlists, nil
}

// AddTrack implements repository.PlaylistRepository. Добавляет трек в конец
// плейлиста (позиция = текущий максимум + 1 в этом плейлисте).
func (s *PlaylistStore) AddTrack(ctx context.Context, id, playlistID, url, name string, volume float64, loop bool) error {
	var maxPos sql.NullInt64
	if err := s.db.QueryRowContext(ctx, `SELECT MAX(position) FROM playlist_tracks WHERE playlist_id = ?`, playlistID).Scan(&maxPos); err != nil {
		return err
	}
	pos := 0
	if maxPos.Valid {
		pos = int(maxPos.Int64) + 1
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO playlist_tracks (id, playlist_id, url, name, volume, loop, position) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id, playlistID, url, name, volume, boolToInt(loop), pos,
	)
	return err
}

// UpdateTrack implements repository.PlaylistRepository.
func (s *PlaylistStore) UpdateTrack(ctx context.Context, id, playlistID, name string, volume float64, loop bool) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE playlist_tracks SET name = ?, volume = ?, loop = ? WHERE id = ? AND playlist_id = ?`,
		name, volume, boolToInt(loop), id, playlistID,
	)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// DeleteTrack implements repository.PlaylistRepository.
func (s *PlaylistStore) DeleteTrack(ctx context.Context, id, playlistID string) (bool, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM playlist_tracks WHERE id = ? AND playlist_id = ?`, id, playlistID)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// MoveTrack implements repository.PlaylistRepository. Переставляет трек на
// одну позицию вверх (dir<0) или вниз (dir>0), меняя местами position со
// соседом — простые кнопки ↑/↓ в UI вместо drag-and-drop. Транзакция, чтобы
// не оставить дублирующиеся/дырявые позиции при гонке двух почти
// одновременных кликов.
func (s *PlaylistStore) MoveTrack(ctx context.Context, playlistID, trackID string, dir int) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var curPos int
	if err := tx.QueryRowContext(ctx, `SELECT position FROM playlist_tracks WHERE id = ? AND playlist_id = ?`, trackID, playlistID).Scan(&curPos); err != nil {
		return err
	}

	var neighborID string
	var neighborPos int
	var neighborQuery string
	if dir < 0 {
		neighborQuery = `SELECT id, position FROM playlist_tracks WHERE playlist_id = ? AND position < ? ORDER BY position DESC LIMIT 1`
	} else {
		neighborQuery = `SELECT id, position FROM playlist_tracks WHERE playlist_id = ? AND position > ? ORDER BY position ASC LIMIT 1`
	}
	err = tx.QueryRowContext(ctx, neighborQuery, playlistID, curPos).Scan(&neighborID, &neighborPos)
	if errors.Is(err, sql.ErrNoRows) {
		return nil // уже крайний — двигать некуда, не ошибка
	}
	if err != nil {
		return err
	}

	if _, err := tx.ExecContext(ctx, `UPDATE playlist_tracks SET position = ? WHERE id = ?`, neighborPos, trackID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE playlist_tracks SET position = ? WHERE id = ?`, curPos, neighborID); err != nil {
		return err
	}
	return tx.Commit()
}
