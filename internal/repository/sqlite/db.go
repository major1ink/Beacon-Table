// Package sqlite реализует repository.AccountRepository,
// repository.CharacterRepository, repository.SessionRepository,
// repository.PlaylistRepository и repository.FoundryModuleRepository поверх
// database/sql + modernc.org/sqlite. Единственная точка правды о SQL-схеме и
// способе хранения — весь остальной код (service, api) обращается к этим
// данным только через интерфейсы пакета repository.
//
// Каждая сущность — отдельный тип (AccountStore, CharacterStore,
// SessionStore, PlaylistStore, FoundryModuleStore), а не один Store на все
// интерфейсы: у них пересекаются имена методов (Create/List/Delete), так что
// общий приёмник их конфликтовал бы. Все они делят один *sql.DB, полученный
// из Open.
package sqlite

import (
	"database/sql"
	"time"

	_ "modernc.org/sqlite" // регистрирует драйвер "sqlite" в database/sql
)

const timeLayout = time.RFC3339

// Open открывает (и при первом запуске создаёт) файл базы по path и доводит
// его схему до актуальной версии (см. migrations.go). Возвращает сырой
// *sql.DB — из него конструируются AccountStore/CharacterStore/SessionStore/
// PlaylistStore (см. New* в соседних файлах), закрывать его (db.Close()) —
// забота композиционного корня.
func Open(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	// SQLite не любит параллельную запись из нескольких соединений —
	// сериализуем через единственное соединение в пуле. Для нагрузки этого
	// сервера (один стол, десятки аккаунтов, редкие записи) с запасом.
	db.SetMaxOpenConns(1)

	// Схема живёт в migrations.go: Open только открывает файл и доводит его
	// до актуальной версии.
	if err := migrate(db); err != nil {
		db.Close()
		return nil, err
	}
	// Внешние ключи (ON DELETE CASCADE) в SQLite по умолчанию выключены на
	// уровне соединения, а не БД — включаем на каждое открытие.
	if _, err := db.Exec(`PRAGMA foreign_keys = ON`); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
