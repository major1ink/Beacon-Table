package sqlite

import (
	"database/sql"
	"fmt"
)

// ---- механизм миграций схемы ----
//
// Версия схемы живёт в PRAGMA user_version — четырёх байтах в заголовке
// самого файла БД. Не служебная таблица: user_version нельзя случайно
// потерять вместе с содержимым (её не видно в дампе таблиц и не удалить
// DELETE-ом), она меняется в той же транзакции, что и сами DDL-команды, и
// ничего не стоит на чтении при каждом старте.
//
// Правила, по которым сюда дописывают шаги:
//
//   - новый шаг ТОЛЬКО добавляется в конец списка со следующим номером;
//     уже выпущенный шаг не правят — у пользователей он давно применён, и
//     правка просто не выполнится;
//   - каждый шаг идёт в своей транзакции: упавший откатывается целиком и
//     версия не двигается, поэтому следующий запуск начнёт его заново;
//   - шаг 1 — это вся схема, какой она была к моменту появления механизма,
//     и он единственный написан идемпотентно (IF NOT EXISTS плюс
//     addColumnIfMissing). Так сделано нарочно: у существующих установок
//     user_version равен нулю, но таблицы уже есть — часть из них с полным
//     набором колонок, часть без тех, что добавлялись ALTER-ами по ходу
//     дела. Идемпотентный первый шаг доводит любую такую базу до одного и
//     того же состояния, не зная её истории.

// migration — один шаг эволюции схемы.
type migration struct {
	version int
	// name — для сообщения об ошибке: «миграция 3 (индекс по журналу)».
	name  string
	apply func(*sql.Tx) error
}

// schemaMigrations — все шаги по порядку. Единственная точка правды о том,
// как выглядит схема сегодня и как до неё дойти с любой прошлой версии.
var schemaMigrations = []migration{
	{version: 1, name: "исходная схема", apply: migrateV1},
}

// sqlExec — общее у *sql.DB и *sql.Tx: чтобы вспомогательные функции
// (addColumnIfMissing) работали и внутри шага миграции, и вне его.
type sqlExec interface {
	Exec(query string, args ...any) (sql.Result, error)
	Query(query string, args ...any) (*sql.Rows, error)
}

// migrate доводит базу до последней известной версии схемы.
func migrate(db *sql.DB) error {
	return applyMigrations(db, schemaMigrations)
}

// applyMigrations — сам механизм, отдельно от списка шагов: так его можно
// проверить на игрушечных миграциях, не трогая настоящую схему.
func applyMigrations(db *sql.DB, list []migration) error {
	for i, m := range list {
		if m.version != i+1 {
			return fmt.Errorf("список миграций сбит: шаг %d стоит на месте %d — версии должны идти подряд с единицы", m.version, i+1)
		}
	}

	current, err := userVersion(db)
	if err != nil {
		return fmt.Errorf("не удалось прочитать версию схемы: %w", err)
	}
	if current > len(list) {
		// Старый бинарник на базе, которую уже обновила новая версия. Молча
		// работать дальше нельзя: код не знает про колонки, которых ждёт
		// база, и наоборот — это тихая порча данных вместо честного отказа.
		return fmt.Errorf("база создана более новой версией Beacon Table (схема %d, эта сборка знает %d) — обновите приложение", current, len(list))
	}

	for _, m := range list {
		if m.version <= current {
			continue
		}
		if err := applyOne(db, m); err != nil {
			return err
		}
	}
	return nil
}

// applyOne выполняет один шаг и поднимает версию — обе операции в одной
// транзакции, чтобы версия не могла разъехаться с фактической схемой.
func applyOne(db *sql.DB, m migration) error {
	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("миграция %d (%s): %w", m.version, m.name, err)
	}
	if err := m.apply(tx); err != nil {
		_ = tx.Rollback()
		return fmt.Errorf("миграция %d (%s): %w", m.version, m.name, err)
	}
	// PRAGMA не принимает плейсхолдеры; version — int из кода, не ввод.
	if _, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, m.version)); err != nil {
		_ = tx.Rollback()
		return fmt.Errorf("миграция %d (%s): не удалось записать версию: %w", m.version, m.name, err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("миграция %d (%s): %w", m.version, m.name, err)
	}
	return nil
}

func userVersion(db *sql.DB) (int, error) {
	var v int
	err := db.QueryRow(`PRAGMA user_version`).Scan(&v)
	return v, err
}

// migrateV1 — схема, какой она была до появления версий, целиком и
// идемпотентно (см. комментарий к schemaMigrations выше).
func migrateV1(tx *sql.Tx) error {
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
		// pregen_characters — пул «готовых персонажей» мира (см. domain.Pregen):
		// актёры type "character" из импортированных приключений Foundry. Игрок
		// берёт свободного, ДМ назначает/возвращает в пул. Захват создаёт
		// обычную строку characters (claimed_character_id) — она и есть
		// персонаж игрока; строка тут остаётся шаблоном с пометкой занятости.
		// company_id денормализован на строку (как у characters) — стор
		// company-scoped, JOIN не нужен. FK на claimed_by нет нарочно: аккаунт
		// удаляют вместе с его персонажами (FK characters), а пул-запись при
		// этом лишь освобождается (см. sqlite/pregens.go: FreeByAccount,
		// вызывается из handleAdminAccountDelete).
		`CREATE TABLE IF NOT EXISTS pregen_characters (
			id TEXT PRIMARY KEY,
			company_id TEXT NOT NULL,
			name TEXT NOT NULL,
			avatar_url TEXT NOT NULL DEFAULT '',
			sheet_json TEXT NOT NULL DEFAULT '{}',
			source TEXT NOT NULL DEFAULT '',
			claimed_by TEXT NOT NULL DEFAULT '',
			claimed_character_id TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_characters_account ON characters(account_id)`,
		`CREATE INDEX IF NOT EXISTS idx_pregen_characters_company ON pregen_characters(company_id)`,
		`CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id)`,
		`CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks(playlist_id)`,
		`CREATE INDEX IF NOT EXISTS idx_inventory_items_character ON inventory_items(character_id)`,
	}
	for _, stmt := range schema {
		if _, err := tx.Exec(stmt); err != nil {
			return err
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
		if err := addColumnIfMissing(tx, a.table, a.column, a.definition); err != nil {
			return err
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
		if _, err := tx.Exec(stmt); err != nil {
			return err
		}
	}
	return nil
}

// addColumnIfMissing — ALTER TABLE, который не падает на уже существующей
// колонке. Нужен только шагу 1, которому приходится доводить до общего вида
// базы разного возраста (см. комментарий к schemaMigrations); новым шагам
// такое не требуется — они точно знают, с какой версии стартуют.
//
// PRAGMA table_info не поддерживает плейсхолдеры для имени таблицы — table
// здесь всегда константа из кода (не пользовательский ввод), поэтому строим
// запрос напрямую без риска SQL-инъекции.
func addColumnIfMissing(q sqlExec, table, column, definition string) error {
	rows, err := q.Query(`PRAGMA table_info(` + table + `)`)
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
	_, err = q.Exec(`ALTER TABLE ` + table + ` ADD COLUMN ` + column + ` ` + definition)
	return err
}
