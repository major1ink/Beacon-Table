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

// Open открывает (и при первом запуске создаёт) файл базы по path и
// накатывает схему. CREATE TABLE IF NOT EXISTS — миграций пока не нужно,
// схема одна и меняется редко; при появлении реальной эволюции схемы стоит
// завести отдельный migrations-механизм по аналогии с scenefile-пакетом.
// Возвращает сырой *sql.DB — из него конструируются AccountStore/
// CharacterStore/SessionStore/PlaylistStore (см. New* в соседних файлах),
// закрывать его (db.Close()) — забота композиционного корня.
func Open(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	// SQLite не любит параллельную запись из нескольких соединений —
	// сериализуем через единственное соединение в пуле. Для нагрузки этого
	// сервера (один стол, десятки аккаунтов, редкие записи) с запасом.
	db.SetMaxOpenConns(1)

	schema := []string{
		`CREATE TABLE IF NOT EXISTS accounts (
			id TEXT PRIMARY KEY,
			username TEXT NOT NULL UNIQUE,
			password_hash TEXT NOT NULL,
			role TEXT NOT NULL,
			status TEXT NOT NULL,
			must_change_password INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS characters (
			id TEXT PRIMARY KEY,
			account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			avatar_url TEXT NOT NULL DEFAULT '',
			sheet_json TEXT NOT NULL DEFAULT '{}',
			created_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS sessions (
			token TEXT PRIMARY KEY,
			account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			created_at TEXT NOT NULL,
			expires_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS playlists (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS playlist_tracks (
			id TEXT PRIMARY KEY,
			playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
			url TEXT NOT NULL,
			name TEXT NOT NULL,
			volume REAL NOT NULL DEFAULT 0.8,
			loop INTEGER NOT NULL DEFAULT 0,
			position INTEGER NOT NULL
		)`,
		// inventory_items — инвентарь персонажей (см. domain.InventoryEntry),
		// своя таблица, НЕ поле characters.sheet_json (см. комментарий
		// repository.CharacterRepository про гонку с автосейвом листа).
		// account_id/company_id денормализованы на строку (как и у остальных
		// таблиц выше) — Update/Remove/List фильтруются напрямую без JOIN.
		`CREATE TABLE IF NOT EXISTS inventory_items (
			id TEXT PRIMARY KEY,
			character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
			account_id TEXT NOT NULL,
			company_id TEXT NOT NULL,
			item_id TEXT NOT NULL DEFAULT '',
			name TEXT NOT NULL,
			image_url TEXT NOT NULL DEFAULT '',
			weight_lb REAL NOT NULL DEFAULT 0,
			quantity INTEGER NOT NULL DEFAULT 1,
			equipped INTEGER NOT NULL DEFAULT 0,
			notes TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL
		)`,
		// companies — миры/столы (см. domain.Company); server_state —
		// однострочный-на-ключ KV, сейчас хранит active_company_id (какой
		// мир сейчас запущен, см. service.CompanyManager) и legacy_company_id
		// (какая компания — если есть — унаследовала данные инсталляции до
		// появления этой фичи, см. MigrateLegacyCompany).
		`CREATE TABLE IF NOT EXISTS companies (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			system TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS server_state (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)`,
		// foundry_modules — пакеты Foundry VTT, хотя бы раз импортированные в
		// мир (см. domain.FoundryModule): раздел "Настройки" показывает по
		// ним список и проверяет обновления по manifest_url. Ключ — (id,
		// company_id): id пакета уникален внутри мира, но два разных мира
		// вполне могут поставить один и тот же модуль независимо.
		`CREATE TABLE IF NOT EXISTS foundry_modules (
			id TEXT NOT NULL,
			company_id TEXT NOT NULL DEFAULT '',
			title TEXT NOT NULL,
			version TEXT NOT NULL,
			manifest_url TEXT NOT NULL,
			imported_at TEXT NOT NULL,
			PRIMARY KEY (id, company_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_characters_account ON characters(account_id)`,
		`CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id)`,
		`CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks(playlist_id)`,
		`CREATE INDEX IF NOT EXISTS idx_inventory_items_character ON inventory_items(character_id)`,
	}
	for _, stmt := range schema {
		if _, err := db.Exec(stmt); err != nil {
			db.Close()
			return nil, err
		}
	}
	// CREATE TABLE IF NOT EXISTS не добавляет колонки к уже существующей
	// таблице — sheet_json/company_id/system появились позже исходной схемы,
	// поэтому для баз, созданных до них, догоняем ALTER TABLE вручную.
	alters := []struct{ table, column, definition string }{
		{"characters", "sheet_json", `TEXT NOT NULL DEFAULT '{}'`},
		{"accounts", "company_id", `TEXT NOT NULL DEFAULT ''`},
		{"characters", "company_id", `TEXT NOT NULL DEFAULT ''`},
		{"characters", "system", `TEXT NOT NULL DEFAULT ''`},
		{"playlists", "company_id", `TEXT NOT NULL DEFAULT ''`},
	}
	for _, a := range alters {
		if err := addColumnIfMissing(db, a.table, a.column, a.definition); err != nil {
			db.Close()
			return nil, err
		}
	}
	// Индексы по company_id — заводим уже после ALTER TABLE выше (колонки
	// должны существовать к этому моменту).
	postAlterIndexes := []string{
		`CREATE INDEX IF NOT EXISTS idx_accounts_company ON accounts(company_id)`,
		`CREATE INDEX IF NOT EXISTS idx_characters_company ON characters(company_id)`,
		`CREATE INDEX IF NOT EXISTS idx_playlists_company ON playlists(company_id)`,
	}
	for _, stmt := range postAlterIndexes {
		if _, err := db.Exec(stmt); err != nil {
			db.Close()
			return nil, err
		}
	}
	// Внешние ключи (ON DELETE CASCADE) в SQLite по умолчанию выключены на
	// уровне соединения, а не БД — включаем на каждое открытие.
	if _, err := db.Exec(`PRAGMA foreign_keys = ON`); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

// addColumnIfMissing — минимальная замена полноценного migrations-механизма
// (см. комментарий Open выше) для единственного случая, когда он реально
// понадобился: колонка добавлена в схему после того, как у части
// пользователей уже есть data/beacon.db без неё. PRAGMA table_info не
// поддерживает плейсхолдеры для имени таблицы — table здесь всегда
// константа из кода (не пользовательский ввод), поэтому строим запрос
// напрямую без риска SQL-инъекции.
func addColumnIfMissing(db *sql.DB, table, column, definition string) error {
	rows, err := db.Query(`PRAGMA table_info(` + table + `)`)
	if err != nil {
		return err
	}
	found := false
	for rows.Next() {
		var cid int
		var name, ctype string
		var notNull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notNull, &dflt, &pk); err != nil {
			rows.Close()
			return err
		}
		if name == column {
			found = true
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows.Close()
	if found {
		return nil
	}
	_, err = db.Exec(`ALTER TABLE ` + table + ` ADD COLUMN ` + column + ` ` + definition)
	return err
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
