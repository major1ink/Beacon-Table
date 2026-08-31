// Package backup делает согласованные снимки данных Beacon Table: базу через
// VACUUM INTO (копировать файл SQLite на живой системе нельзя — снимок вышел
// бы битым), плюс каталоги данных и загрузок одним архивом. По расписанию из
// main, либо разово командой `beacon-table backup`.
package backup

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"database/sql"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	_ "modernc.org/sqlite" // драйвер для проверки снимка
)

// Options — что и куда бэкапить.
type Options struct {
	// DB — живое соединение с базой: VACUUM INTO идёт через него, поэтому
	// снимок консистентен даже под записью.
	DB *sql.DB
	// DBPath — путь к самому файлу базы (нужен, чтобы исключить его и его
	// -wal/-shm из архива каталогов: в архив кладётся снимок, а не живой файл).
	DBPath string
	// Dirs — каталоги, которые архивируются целиком (данные, загрузки).
	Dirs []string
	// Dest — куда складывать архивы. Если лежит внутри одного из Dirs,
	// сам себя в архив не тянет.
	Dest string
	// Keep — сколько последних архивов оставлять, остальные удаляются.
	Keep int
}

const (
	archivePrefix = "beacon-backup-"
	archiveSuffix = ".tar.gz"
	stampLayout   = "20060102-150405" // сортируется как есть, безопасно в имени файла
)

// Once делает один бэкап: снимок базы, проверка снимка, архив снимка вместе
// с Dirs, удаление лишних старых архивов. Возвращает путь готового архива.
func Once(ctx context.Context, o Options) (string, error) {
	if err := os.MkdirAll(o.Dest, 0o750); err != nil {
		return "", fmt.Errorf("каталог бэкапов: %w", err)
	}
	cleanupStaleTemp(o.Dest)

	stamp := time.Now().Format(stampLayout)
	snapshot := filepath.Join(o.Dest, ".snapshot-"+stamp+".db")
	defer func() { _ = os.Remove(snapshot) }()

	if _, err := o.DB.ExecContext(ctx, "VACUUM INTO ?", snapshot); err != nil {
		return "", fmt.Errorf("снимок базы (VACUUM INTO): %w", err)
	}
	if err := checkDB(ctx, snapshot); err != nil {
		return "", fmt.Errorf("снимок базы не прошёл проверку: %w", err)
	}

	tmp := filepath.Join(o.Dest, "."+archivePrefix+stamp+archiveSuffix+".tmp")
	final := filepath.Join(o.Dest, archivePrefix+stamp+archiveSuffix)
	if err := writeArchive(ctx, tmp, snapshot, o); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	if err := verifyArchive(ctx, tmp); err != nil {
		_ = os.Remove(tmp)
		return "", fmt.Errorf("готовый архив не восстанавливается: %w", err)
	}
	if err := os.Rename(tmp, final); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}

	rotate(o.Dest, o.Keep)
	return final, nil
}

// Run делает бэкап на старте (если свежего ещё нет) и дальше каждые interval,
// пока не отменят ctx.
func Run(ctx context.Context, interval time.Duration, o Options) {
	if !hasRecentBackup(o.Dest, interval/2) {
		backupNow(ctx, o)
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			backupNow(ctx, o)
		}
	}
}

func backupNow(ctx context.Context, o Options) {
	path, err := Once(ctx, o)
	if err != nil {
		if ctx.Err() != nil {
			return // остановка сервера — не ошибка
		}
		slog.Error("бэкап не удался", "err", err)
		return
	}
	slog.Info("бэкап готов", "path", path)
}

// checkDB открывает снимок и убеждается, что он читается и целостен —
// «непроверенный бэкап не бэкап».
func checkDB(ctx context.Context, path string) error {
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		return err
	}
	defer db.Close()

	var result string
	if err := db.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&result); err != nil {
		return err
	}
	if result != "ok" {
		return fmt.Errorf("integrity_check: %s", result)
	}
	// Заодно — что схема на месте и таблицы читаются.
	var n int
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM accounts").Scan(&n); err != nil {
		return fmt.Errorf("таблицы не читаются: %w", err)
	}
	return nil
}

func writeArchive(ctx context.Context, path, snapshot string, o Options) (err error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600) //nolint:gosec // путь из конфига сервера
	if err != nil {
		return err
	}
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)

	// Закрываем в обратном порядке и не теряем ошибку записи: она всплывает
	// именно на Close у tar/gzip (сброс буферов).
	defer func() {
		for _, c := range []io.Closer{tw, gz, f} {
			if cerr := c.Close(); cerr != nil && err == nil {
				err = cerr
			}
		}
	}()

	// Снимок базы кладём под каноническим именем — при восстановлении он
	// встаёт на место живого файла.
	if err := addFile(tw, snapshot, "data/beacon.db"); err != nil {
		return fmt.Errorf("архив: снимок базы: %w", err)
	}

	skip := archiveSkip(o)
	for _, dir := range o.Dirs {
		if _, statErr := os.Stat(dir); os.IsNotExist(statErr) {
			continue // каталога ещё нет (свежий сервер без единой загрузки) — нечего архивировать
		}
		base := filepath.Base(dir)
		werr := filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
			if err != nil {
				return err
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			rel, err := filepath.Rel(dir, p)
			if err != nil {
				return err
			}
			name := filepath.ToSlash(filepath.Join(base, rel))
			if skip(p, name, info) {
				if info.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if !info.Mode().IsRegular() {
				return nil
			}
			return addFile(tw, p, name)
		})
		if werr != nil {
			return fmt.Errorf("архив каталога %s: %w", dir, werr)
		}
	}
	return nil
}

// archiveSkip — что не кладём в архив: сам каталог бэкапов, живой файл базы
// (в архиве есть снимок), кэш Foundry (регенерируется), временные снимки.
func archiveSkip(o Options) func(path, name string, info os.FileInfo) bool {
	dest, _ := filepath.Abs(o.Dest)
	dbPath, _ := filepath.Abs(o.DBPath)
	return func(path, name string, info os.FileInfo) bool {
		abs, _ := filepath.Abs(path)
		if dest != "" && (abs == dest || strings.HasPrefix(abs, dest+string(os.PathSeparator))) {
			return true
		}
		if abs == dbPath || abs == dbPath+"-wal" || abs == dbPath+"-shm" {
			return true
		}
		bn := filepath.Base(name)
		if bn == "foundry-cache" || bn == "migrations" {
			return info.IsDir()
		}
		return false
	}
}

func addFile(tw *tar.Writer, src, name string) error {
	f, err := os.Open(src) //nolint:gosec // путь из обхода каталога данных сервера
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	hdr := &tar.Header{Name: name, Mode: 0o600, Size: info.Size(), ModTime: info.ModTime()}
	if err := tw.WriteHeader(hdr); err != nil {
		return err
	}
	_, err = io.Copy(tw, f)
	return err
}

// verifyArchive распаковывает из архива обратно только базу и снова гоняет
// проверку целостности — так мы знаем, что архив не просто записан, а
// действительно восстанавливается.
func verifyArchive(ctx context.Context, path string) error {
	f, err := os.Open(path) //nolint:gosec // путь из конфига сервера
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer func() { _ = gz.Close() }()

	tmp, err := os.CreateTemp("", "beacon-restore-check-*.db")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	defer func() { _ = tmp.Close() }()

	tr := tar.NewReader(gz)
	found := false
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if hdr.Name == "data/beacon.db" {
			if _, err := io.Copy(tmp, tr); err != nil { //nolint:gosec // размер базы под контролем VACUUM
				return err
			}
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("в архиве нет data/beacon.db")
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return checkDB(ctx, tmp.Name())
}

// rotate оставляет keep самых свежих архивов, остальные удаляет. keep <= 0 —
// не удаляем ничего.
func rotate(dest string, keep int) {
	if keep <= 0 {
		return
	}
	archives := listArchives(dest)
	if len(archives) <= keep {
		return
	}
	for _, name := range archives[:len(archives)-keep] {
		if err := os.Remove(filepath.Join(dest, name)); err != nil {
			slog.Warn("не удалось удалить старый бэкап", "err", err)
		}
	}
}

// listArchives — имена архивов в dest, от старых к новым (метка времени в
// имени сортируется лексикографически).
func listArchives(dest string) []string {
	entries, err := os.ReadDir(dest)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		n := e.Name()
		if strings.HasPrefix(n, archivePrefix) && strings.HasSuffix(n, archiveSuffix) {
			out = append(out, n)
		}
	}
	sort.Strings(out)
	return out
}

func hasRecentBackup(dest string, within time.Duration) bool {
	archives := listArchives(dest)
	if len(archives) == 0 {
		return false
	}
	newest := archives[len(archives)-1]
	info, err := os.Stat(filepath.Join(dest, newest))
	if err != nil {
		return false
	}
	return time.Since(info.ModTime()) < within
}

// cleanupStaleTemp убирает .tmp/.snapshot от прерванных прогонов.
func cleanupStaleTemp(dest string) {
	entries, err := os.ReadDir(dest)
	if err != nil {
		return
	}
	for _, e := range entries {
		n := e.Name()
		if strings.HasPrefix(n, "."+archivePrefix) || strings.HasPrefix(n, ".snapshot-") {
			_ = os.Remove(filepath.Join(dest, n))
		}
	}
}
