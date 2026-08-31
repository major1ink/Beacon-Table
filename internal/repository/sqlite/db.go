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

	if err := applyPragmas(db); err != nil {
		db.Close()
		return nil, err
	}

	// Схема живёт в migrations.go: Open только открывает файл и доводит его
	// до актуальной версии.
	if err := migrate(db); err != nil {
		db.Close()
		return nil, err
	}
	// Внешние ключи (ON DELETE CASCADE) в SQLite по умолчанию выключены на
	// уровне соединения, а не БД — включаем ПОСЛЕ миграций: шагу схемы
	// (ALTER/пересозданию таблицы) проверка ссылок только мешала бы, а
	// рабочим запросам она нужна.
	if _, err := db.Exec(`PRAGMA foreign_keys = ON`); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

// applyPragmas настраивает соединение до миграций — чтобы и сами миграции
// шли уже в этом режиме.
func applyPragmas(db *sql.DB) error {
	// WAL: пишущая транзакция (сохранение сцены, импорт мира) больше не
	// блокирует читающие — а импорт модуля Foundry держит запись секундами.
	// Побочный эффект: рядом с beacon.db появляются -wal и -shm; они
	// сливаются в основной файл при закрытии базы (см. shutdown в
	// cmd/beacon-table/main.go), но копировать базу «на живую» мимо них
	// нельзя — резервная копия делается через VACUUM INTO.
	//
	// Результат читаем, а не выполняем Exec'ом: PRAGMA journal_mode
	// возвращает установившийся режим. Для базы в памяти (тесты) это будет
	// "memory" — WAL там не поддерживается, и это не ошибка.
	var mode string
	if err := db.QueryRow(`PRAGMA journal_mode = WAL`).Scan(&mode); err != nil {
		return err
	}
	// busy_timeout: вместо мгновенного "database is locked" соединение ждёт
	// освобождения до пяти секунд. С единственным соединением в пуле блокировки
	// изнутри процесса не случаются, но снаружи файл может держать бэкап или
	// консоль sqlite3 — тогда лучше подождать, чем уронить запрос.
	if _, err := db.Exec(`PRAGMA busy_timeout = 5000`); err != nil {
		return err
	}
	return nil
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
