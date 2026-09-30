package modtool

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Pack — итог упаковки: имена файлов выпуска в папке out.
type Pack struct {
	Archive string // <id>-<версия>.btmod
	Sum     string // <id>-<версия>.sha256
	Summary string // <id>-<версия>.summary.json
	SHA256  string
	Size    int64
}

// zipTime — время записи в архиве: фиксированное, чтобы одинаковые
// исходники давали одинаковый архив и одинаковый sha256.
var zipTime = time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)

// packedTop — что из корня модуля попадает в архив (README.md и служебные
// папки — нет): манифест, записи об изменениях, лицензия и сами данные.
func packedTop(name string, dir bool) bool {
	if strings.HasPrefix(name, ".") {
		return false
	}
	if dir {
		return topDirs[name]
	}
	return name != "README.md" && allowedFile(name)
}

// PackModule упаковывает проверенный модуль из dir в out: архив .btmod (zip
// с module.json в корне), его sha256 и сводку.
func PackModule(dir, out string) (*Pack, error) {
	sum, err := Summarize(dir)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(out, 0o750); err != nil {
		return nil, err
	}
	base := sum.ID + "-" + sum.Version
	p := &Pack{Archive: base + ".btmod", Sum: base + ".sha256", Summary: base + ".summary.json"}
	archive := filepath.Join(out, p.Archive)
	if err := writeZip(dir, archive); err != nil {
		return nil, err
	}
	hash, size, err := fileHash(archive)
	if err != nil {
		return nil, err
	}
	p.SHA256, p.Size = hash, size
	if err := os.WriteFile(filepath.Join(out, p.Sum), []byte(hash+"  "+p.Archive+"\n"), 0o600); err != nil {
		return nil, err
	}
	data, err := MarshalJSON(sum)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(out, p.Summary), data, 0o600); err != nil {
		return nil, err
	}
	return p, nil
}

func writeZip(dir, archive string) (err error) {
	f, err := os.Create(archive) //nolint:gosec // путь выпуска задаёт автор модуля
	if err != nil {
		return err
	}
	defer func() {
		if cerr := f.Close(); err == nil {
			err = cerr
		}
	}()
	zw := zip.NewWriter(f)
	fsys := os.DirFS(dir)
	var files []string
	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		return err
	}
	for _, e := range entries {
		if !packedTop(e.Name(), e.IsDir()) {
			continue
		}
		if !e.IsDir() {
			files = append(files, e.Name())
			continue
		}
		err := fs.WalkDir(fsys, e.Name(), func(p string, d fs.DirEntry, err error) error {
			if err == nil && !d.IsDir() {
				files = append(files, p)
			}
			return err
		})
		if err != nil {
			return err
		}
	}
	sort.Strings(files)
	for _, name := range files {
		if err := addFile(zw, fsys, name); err != nil {
			return err
		}
	}
	return zw.Close()
}

func addFile(zw *zip.Writer, fsys fs.FS, name string) error {
	src, err := fsys.Open(name)
	if err != nil {
		return err
	}
	defer func() { _ = src.Close() }()
	w, err := zw.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate, Modified: zipTime})
	if err != nil {
		return err
	}
	_, err = io.Copy(w, src)
	return err
}

func fileHash(path string) (string, int64, error) {
	f, err := os.Open(path) //nolint:gosec // путь выпуска задаёт автор модуля
	if err != nil {
		return "", 0, err
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, fmt.Errorf("%s: %w", path, err)
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}
