package backup

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"database/sql"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

// setup — временная база с парой строк, каталог данных с файлом и каталог
// загрузок с файлом. Возвращает Options, готовые для Once.
func setup(t *testing.T) Options {
	t.Helper()
	root := t.TempDir()
	dataDir := filepath.Join(root, "data")
	uploadsDir := filepath.Join(root, "uploads")
	mustMkdir(t, filepath.Join(dataDir, "notes"))
	mustMkdir(t, filepath.Join(dataDir, "foundry-cache", "abc"))
	mustMkdir(t, uploadsDir)

	dbPath := filepath.Join(dataDir, "beacon.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	exec(t, db, `CREATE TABLE accounts (id TEXT, name TEXT)`)
	exec(t, db, `INSERT INTO accounts VALUES ('a1','dm'), ('a2','player')`)

	mustWrite(t, filepath.Join(dataDir, "notes", "chapter.md"), "тайна подземелья")
	mustWrite(t, filepath.Join(dataDir, "foundry-cache", "abc", "junk.zip"), "мусор кэша")
	mustWrite(t, filepath.Join(uploadsDir, "tavern.png"), "карта таверны")

	return Options{
		DB:     db,
		DBPath: dbPath,
		Dirs:   []string{dataDir, uploadsDir},
		Dest:   filepath.Join(dataDir, "backups"),
		Keep:   3,
	}
}

// TestOnceProducesRestorableArchive — главный сценарий: бэкап создаётся,
// содержит снимок базы и файлы каталогов, а вложенная база восстанавливается
// и читается.
func TestOnceProducesRestorableArchive(t *testing.T) {
	o := setup(t)
	ctx := context.Background()

	path, err := Once(ctx, o)
	if err != nil {
		t.Fatalf("Once: %v", err)
	}
	if filepath.Dir(path) != o.Dest {
		t.Fatalf("архив не в каталоге бэкапов: %s", path)
	}

	names := archiveNames(t, path)
	want := []string{"data/beacon.db", "data/notes/chapter.md", "uploads/tavern.png"}
	for _, w := range want {
		if !names[w] {
			t.Errorf("в архиве нет %s (есть: %v)", w, keys(names))
		}
	}
	// Кэш Foundry, живой файл базы, сам каталог бэкапов — в архив не идут.
	for bad := range names {
		if strings.Contains(bad, "foundry-cache") || strings.HasPrefix(bad, "data/backups") {
			t.Errorf("в архиве оказался %s", bad)
		}
	}
	if names["data/beacon.db-wal"] || names["data/beacon.db-shm"] {
		t.Error("в архив попали -wal/-shm вместо снимка")
	}

	// Восстанавливаем базу из архива и проверяем данные.
	restored := extractDB(t, path)
	rdb, err := sql.Open("sqlite", restored)
	if err != nil {
		t.Fatalf("open restored: %v", err)
	}
	defer rdb.Close()
	var n int
	if err := rdb.QueryRow(`SELECT count(*) FROM accounts`).Scan(&n); err != nil {
		t.Fatalf("восстановленная база не читается: %v", err)
	}
	if n != 2 {
		t.Fatalf("в восстановленной базе %d аккаунтов, ожидалось 2", n)
	}
}

// TestCheckDBCatchesBadFile — проверка снимка отклоняет файл, который не
// открывается как база: «непроверенный бэкап не бэкап».
func TestCheckDBCatchesBadFile(t *testing.T) {
	dir := t.TempDir()
	notADB := filepath.Join(dir, "broken.db")
	mustWrite(t, notADB, "это не sqlite, а просто текст подлиннее заголовка страницы")
	if err := checkDB(context.Background(), notADB); err == nil {
		t.Fatal("checkDB принял не-базу")
	}
}

// TestOnceToleratesMissingUploadsDir — свежий сервер без единой загрузки:
// каталога uploads ещё нет, но бэкап базы и данных должен пройти.
func TestOnceToleratesMissingUploadsDir(t *testing.T) {
	o := setup(t)
	o.Dirs = append(o.Dirs, filepath.Join(t.TempDir(), "нет-такого"))

	path, err := Once(context.Background(), o)
	if err != nil {
		t.Fatalf("Once с отсутствующим каталогом: %v", err)
	}
	if !archiveNames(t, path)["data/beacon.db"] {
		t.Fatal("снимок базы не попал в архив")
	}
}

// TestRotateKeepsNewest — при превышении Keep удаляются самые старые архивы.
func TestRotateKeepsNewest(t *testing.T) {
	dest := t.TempDir()
	stamps := []string{"20260101-000000", "20260102-000000", "20260103-000000", "20260104-000000"}
	for _, s := range stamps {
		mustWrite(t, filepath.Join(dest, archivePrefix+s+archiveSuffix), "x")
	}
	rotate(dest, 2)

	left := listArchives(dest)
	if len(left) != 2 {
		t.Fatalf("осталось %d архивов, ожидалось 2: %v", len(left), left)
	}
	if left[0] != archivePrefix+"20260103-000000"+archiveSuffix {
		t.Fatalf("удалили не самые старые: осталось %v", left)
	}
}

// TestRunMakesStartupBackupThenStops — Run делает бэкап на старте и
// завершается по отмене контекста.
func TestRunMakesStartupBackupThenStops(t *testing.T) {
	o := setup(t)
	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan struct{})
	go func() { Run(ctx, time.Hour, o); close(done) }()

	deadline := time.After(5 * time.Second)
	for len(listArchives(o.Dest)) == 0 {
		select {
		case <-deadline:
			t.Fatal("бэкап на старте не появился")
		case <-time.After(20 * time.Millisecond):
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Run не завершился по отмене контекста")
	}
}

// helpers ---------------------------------------------------------------

func archiveNames(t *testing.T, path string) map[string]bool {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open archive: %v", err)
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		t.Fatalf("gzip: %v", err)
	}
	tr := tar.NewReader(gz)
	out := map[string]bool{}
	for {
		h, err := tr.Next()
		if err != nil {
			break
		}
		out[h.Name] = true
	}
	return out
}

func extractDB(t *testing.T, archive string) string {
	t.Helper()
	f, err := os.Open(archive)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer f.Close()
	gz, _ := gzip.NewReader(f)
	tr := tar.NewReader(gz)
	dst := filepath.Join(t.TempDir(), "restored.db")
	for {
		h, err := tr.Next()
		if err != nil {
			t.Fatalf("data/beacon.db не найден в архиве")
		}
		if h.Name == "data/beacon.db" {
			out, err := os.Create(dst)
			if err != nil {
				t.Fatalf("create: %v", err)
			}
			if _, err := io.Copy(out, tr); err != nil {
				t.Fatalf("copy: %v", err)
			}
			out.Close()
			return dst
		}
	}
}

func mustMkdir(t *testing.T, p string) {
	t.Helper()
	if err := os.MkdirAll(p, 0o750); err != nil {
		t.Fatal(err)
	}
}

func mustWrite(t *testing.T, p, content string) {
	t.Helper()
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func exec(t *testing.T, db *sql.DB, q string) {
	t.Helper()
	if _, err := db.Exec(q); err != nil {
		t.Fatalf("exec %q: %v", q, err)
	}
}

func keys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
