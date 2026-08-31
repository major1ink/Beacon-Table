package sqlite

import (
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func tableColumns(t *testing.T, db *sql.DB, table string) map[string]bool {
	t.Helper()
	rows, err := db.Query(`PRAGMA table_info(` + table + `)`)
	if err != nil {
		t.Fatalf("table_info(%s): %v", table, err)
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var cid int
		var name, ctype string
		var notNull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notNull, &dflt, &pk); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out[name] = true
	}
	return out
}

func tableExists(t *testing.T, db *sql.DB, table string) bool {
	t.Helper()
	var name string
	err := db.QueryRow(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table).Scan(&name)
	if errors.Is(err, sql.ErrNoRows) {
		return false
	}
	if err != nil {
		t.Fatalf("sqlite_master: %v", err)
	}
	return true
}

func version(t *testing.T, db *sql.DB) int {
	t.Helper()
	v, err := userVersion(db)
	if err != nil {
		t.Fatalf("userVersion: %v", err)
	}
	return v
}

// TestOpenStampsSchemaVersion — свежая база получает всю схему и отметку о
// версии: без отметки следующий запуск не знал бы, что уже применено.
func TestOpenStampsSchemaVersion(t *testing.T) {
	db, err := Open(":memory:")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()

	if got := version(t, db); got != len(schemaMigrations) {
		t.Fatalf("версия схемы %d, ожидалась %d", got, len(schemaMigrations))
	}
	for _, table := range []string{"accounts", "characters", "sessions", "playlists", "companies", "server_state", "inventory_items", "pregen_characters", "foundry_modules"} {
		if !tableExists(t, db, table) {
			t.Fatalf("таблица %s не создана", table)
		}
	}
}

// TestOpenIsIdempotent — повторное открытие той же базы ничего не ломает и
// не двигает версию: сервер перезапускают куда чаще, чем меняют схему.
func TestOpenIsIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "beacon.db")

	db, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO companies (id, name, system, created_at) VALUES ('c1', 'Мир', 'dnd5e-2024', '2026-01-01T00:00:00Z')`); err != nil {
		t.Fatalf("вставка: %v", err)
	}
	first := version(t, db)
	db.Close()

	again, err := Open(path)
	if err != nil {
		t.Fatalf("повторный Open: %v", err)
	}
	defer again.Close()

	if got := version(t, again); got != first {
		t.Fatalf("версия изменилась при повторном открытии: %d → %d", first, got)
	}
	var name string
	if err := again.QueryRow(`SELECT name FROM companies WHERE id = 'c1'`).Scan(&name); err != nil {
		t.Fatalf("данные потеряны: %v", err)
	}
}

// TestOpenUpgradesPreVersionDatabase — главный случай: база, созданная до
// появления механизма версий. У неё user_version = 0, часть таблиц есть, а
// колонок, добавлявшихся ALTER-ами по ходу дела, нет. Открытие должно
// достроить недостающее, сохранив данные, а не начать с чистого листа.
func TestOpenUpgradesPreVersionDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")

	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	// Схема ранней версии: characters без sheet_json/company_id/system,
	// accounts без company_id, ни companies, ни inventory_items.
	legacy := []string{
		`CREATE TABLE accounts (
			id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
			role TEXT NOT NULL, status TEXT NOT NULL, must_change_password INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL
		)`,
		`CREATE TABLE characters (
			id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			name TEXT NOT NULL, avatar_url TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
		)`,
		`INSERT INTO accounts (id, username, password_hash, role, status, created_at)
			VALUES ('a1', 'dm', 'hash', 'admin', 'active', '2026-01-01T00:00:00Z')`,
		`INSERT INTO characters (id, account_id, name, created_at)
			VALUES ('ch1', 'a1', 'Старый герой', '2026-01-01T00:00:00Z')`,
	}
	for _, stmt := range legacy {
		if _, err := raw.Exec(stmt); err != nil {
			t.Fatalf("подготовка старой базы: %v", err)
		}
	}
	raw.Close()

	db, err := Open(path)
	if err != nil {
		t.Fatalf("Open старой базы: %v", err)
	}
	defer db.Close()

	if got := version(t, db); got != len(schemaMigrations) {
		t.Fatalf("версия схемы %d, ожидалась %d", got, len(schemaMigrations))
	}
	chars := tableColumns(t, db, "characters")
	for _, column := range []string{"sheet_json", "company_id", "system"} {
		if !chars[column] {
			t.Fatalf("колонка characters.%s не добавлена", column)
		}
	}
	if !tableColumns(t, db, "accounts")["company_id"] {
		t.Fatal("колонка accounts.company_id не добавлена")
	}
	for _, table := range []string{"companies", "inventory_items", "server_state"} {
		if !tableExists(t, db, table) {
			t.Fatalf("таблица %s не создана", table)
		}
	}

	var name string
	if err := db.QueryRow(`SELECT name FROM characters WHERE id = 'ch1'`).Scan(&name); err != nil {
		t.Fatalf("персонаж потерян: %v", err)
	}
	if name != "Старый герой" {
		t.Fatalf("имя персонажа %q — данные затёрты миграцией", name)
	}
}

// TestMigrateRefusesNewerDatabase — на базе, которую обновила более свежая
// сборка, старый бинарник должен отказаться работать, а не тихо портить
// данные схемой, о которой он ничего не знает. Ровно тот случай, когда на
// сервере откатили версию приложения.
func TestMigrateRefusesNewerDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "future.db")

	db, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if _, err := db.Exec(`PRAGMA user_version = 999`); err != nil {
		t.Fatalf("проставить версию: %v", err)
	}
	db.Close()

	_, err = Open(path)
	if err == nil {
		t.Fatal("база из будущего открылась без ошибки")
	}
	if !strings.Contains(err.Error(), "обновите приложение") {
		t.Fatalf("непонятная ошибка: %v", err)
	}
	if _, statErr := os.Stat(path); statErr != nil {
		t.Fatalf("файл базы пострадал: %v", statErr)
	}
}

// TestApplyMigrationsRunsPendingStepsInOrder — механика на игрушечных шагах,
// без настоящей схемы: применяется только то, чего ещё нет, и по порядку.
func TestApplyMigrationsRunsPendingStepsInOrder(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)

	var order []int
	step := func(n int, ddl string) migration {
		return migration{version: n, name: "шаг", apply: func(tx *sql.Tx) error {
			order = append(order, n)
			_, err := tx.Exec(ddl)
			return err
		}}
	}
	list := []migration{
		step(1, `CREATE TABLE t1 (id TEXT)`),
		step(2, `CREATE TABLE t2 (id TEXT)`),
	}

	if err := applyMigrations(db, list); err != nil {
		t.Fatalf("applyMigrations: %v", err)
	}
	if len(order) != 2 || order[0] != 1 || order[1] != 2 {
		t.Fatalf("шаги выполнены в порядке %v", order)
	}
	if got := version(t, db); got != 2 {
		t.Fatalf("версия %d, ожидалась 2", got)
	}

	// Второй прогон с добавленным шагом: старые пропускаются, новый идёт.
	order = nil
	list = append(list, step(3, `CREATE TABLE t3 (id TEXT)`))
	if err := applyMigrations(db, list); err != nil {
		t.Fatalf("applyMigrations (второй прогон): %v", err)
	}
	if len(order) != 1 || order[0] != 3 {
		t.Fatalf("во втором прогоне выполнены шаги %v, ожидался только третий", order)
	}
	if !tableExists(t, db, "t3") {
		t.Fatal("таблица третьего шага не создана")
	}
}

// TestApplyMigrationsRollsBackFailedStep — упавший шаг не должен оставить
// базу на полпути: ни его изменений, ни поднятой версии.
func TestApplyMigrationsRollsBackFailedStep(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)

	boom := errors.New("шаг не задался")
	list := []migration{
		{version: 1, name: "первый", apply: func(tx *sql.Tx) error {
			_, err := tx.Exec(`CREATE TABLE ok (id TEXT)`)
			return err
		}},
		{version: 2, name: "падучий", apply: func(tx *sql.Tx) error {
			if _, err := tx.Exec(`CREATE TABLE half (id TEXT)`); err != nil {
				return err
			}
			return boom
		}},
	}

	err = applyMigrations(db, list)
	if err == nil {
		t.Fatal("упавшая миграция вернула успех")
	}
	if !errors.Is(err, boom) {
		t.Fatalf("исходная ошибка потерялась: %v", err)
	}
	if got := version(t, db); got != 1 {
		t.Fatalf("версия %d — упавший шаг не должен её двигать", got)
	}
	if tableExists(t, db, "half") {
		t.Fatal("изменения упавшего шага не откатились")
	}
	if !tableExists(t, db, "ok") {
		t.Fatal("успешный первый шаг откатился заодно")
	}
}

// TestApplyMigrationsRejectsBrokenList — защита от опечатки в списке:
// пропущенный или переставленный номер иначе тихо пропустил бы шаг.
func TestApplyMigrationsRejectsBrokenList(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	defer db.Close()

	noop := func(*sql.Tx) error { return nil }
	list := []migration{
		{version: 1, name: "первый", apply: noop},
		{version: 3, name: "третий без второго", apply: noop},
	}
	if err := applyMigrations(db, list); err == nil {
		t.Fatal("сбитый список миграций принят")
	}
}
