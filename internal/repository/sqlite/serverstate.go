package sqlite

import (
	"context"
	"database/sql"
	"errors"
)

// ServerStateStore реализует repository.ServerStateRepository поверх той же
// таблицы server_state, что и активный/легаси мир у CompanyStore (см.
// Open: схема). Отдельный тип, а не пара методов на CompanyStore, потому что
// глобальные настройки сервера — не про миры: CompanyStore держит CRUD
// компаний, и подмешивать в него ключ трансляции значило бы отдавать
// сервисам, которым нужен только ключ, весь интерфейс работы с мирами.
type ServerStateStore struct {
	db *sql.DB
}

// NewServerStateStore строит KV глобальных настроек поверх db, открытого Open.
func NewServerStateStore(db *sql.DB) *ServerStateStore {
	return &ServerStateStore{db: db}
}

// Get implements repository.ServerStateRepository. Отсутствующий ключ — не
// ошибка, а пустая строка: вызывающий (см. service.BroadcastService) сам
// решает, значит ли это "ещё не настроено".
func (s *ServerStateStore) Get(ctx context.Context, key string) (string, error) {
	var value string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM server_state WHERE key = ?`, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return value, err
}

// Set implements repository.ServerStateRepository.
func (s *ServerStateStore) Set(ctx context.Context, key, value string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO server_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		key, value,
	)
	return err
}
