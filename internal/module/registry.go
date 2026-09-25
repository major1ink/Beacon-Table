package module

import (
	"archive/zip"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"beacon-table/internal/domain"
)

// Источники модуля.
const (
	// SourceBuiltin — зашит в бинарник (пока D&D не вынесен в отдельный
	// репозиторий, см. задачу «Вынос D&D из бинарника»).
	SourceBuiltin = "builtin"
	// SourceInstalled — установлен владельцем в <data>/modules/<id>.
	SourceInstalled = "installed"
	// SourceDev — папка из --modules-dev: читается как есть, без упаковки,
	// чтобы правка JSON была видна после перезапуска мира.
	SourceDev = "dev"
)

// Module — модуль, готовый к подключению.
type Module struct {
	Manifest *Manifest
	Source   string
	// FS — корень модуля (там, где лежит module.json).
	FS fs.FS
	// Dir — папка на диске; пусто у встроенного.
	Dir string

	// kindDir/assetsDir — раскладка, отличная от стандартной. Нужна только
	// встроенному каталогу D&D, у которого исторически
	// systemdata/<вид>/<система>/ и systemdata/assets/<система>/.
	kindDir   func(kind string) string
	assetsDir string
}

// ContentDir — папка с карточками вида kind внутри FS.
func (m *Module) ContentDir(kind string) string {
	if m.kindDir != nil {
		return m.kindDir(kind)
	}
	return kind
}

// AssetsDir — папка с картинками внутри FS.
func (m *Module) AssetsDir() string {
	if m.assetsDir != "" {
		return m.assetsDir
	}
	return "assets"
}

// Builtin — модуль из каталога, зашитого в бинарник: карточки в
// <root>/<вид>/<dir>/, картинки в <root>/assets/<dir>/.
func Builtin(fsys fs.FS, root, dir string, manifest *Manifest) *Module {
	return &Module{
		Manifest:  manifest,
		Source:    SourceBuiltin,
		FS:        fsys,
		kindDir:   func(kind string) string { return path.Join(root, kind, dir) },
		assetsDir: path.Join(root, "assets", dir),
	}
}

// Ограничения на установку — чтобы битый или злонамеренный архив не забил
// диск и не распаковался за пределы своей папки.
const (
	maxFiles         = 50000
	maxUnpackedBytes = int64(2) << 30 // 2 ГиБ
	manifestName     = "module.json"
	maxManifestBytes = 1 << 20
)

// Registry — все модули, доступные серверу: встроенные, установленные в
// root и dev-папки. При совпадении id побеждает более поздний источник
// (dev > installed > builtin): так установленный D&D заменяет встроенный, а
// модуль в разработке — установленный.
type Registry struct {
	root       string
	builtin    []*Module
	devDirs    []string
	appVersion string

	// mu — установка и удаление не должны пересекаться друг с другом.
	mu sync.Mutex
}

// NewRegistry — root обычно <data>/modules. appVersion — версия программы
// для проверки minAppVersion; пусто или "dev" — не проверяем.
func NewRegistry(root string, builtin []*Module, devDirs []string, appVersion string) *Registry {
	return &Registry{root: root, builtin: builtin, devDirs: devDirs, appVersion: appVersion}
}

// List — все доступные модули, по одному на id, отсортированы по id.
func (r *Registry) List() ([]*Module, error) {
	if r == nil {
		return nil, nil
	}
	byID := map[string]*Module{}
	for _, m := range r.builtin {
		byID[m.Manifest.ID] = m
	}
	for _, m := range r.installed() {
		byID[m.Manifest.ID] = m
	}
	for _, dir := range r.devDirs {
		for _, m := range scanDir(dir, SourceDev) {
			byID[m.Manifest.ID] = m
		}
	}
	out := make([]*Module, 0, len(byID))
	for _, m := range byID {
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Manifest.ID < out[j].Manifest.ID })
	return out, nil
}

// Get — модуль по id или domain.ErrNotFound.
func (r *Registry) Get(id string) (*Module, error) {
	all, err := r.List()
	if err != nil {
		return nil, err
	}
	for _, m := range all {
		if m.Manifest.ID == id {
			return m, nil
		}
	}
	return nil, domain.ErrNotFound
}

func (r *Registry) installed() []*Module {
	if r.root == "" {
		return nil
	}
	if _, err := os.Stat(r.root); errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return scanDir(r.root, SourceInstalled)
}

// scanDir — модули в подпапках dir (сама dir тоже может быть модулем — так
// удобно указывать в --modules-dev одну папку модуля). Папка с битым
// module.json пропускается с предупреждением в журнал: один сломанный
// модуль не должен прятать остальные.
func scanDir(dir, source string) []*Module {
	var out []*Module
	if m, err := openDir(dir, source); err == nil {
		return append(out, m)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		slog.Warn("Папка модулей недоступна", "dir", dir, "err", err)
		return nil
	}
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		m, err := openDir(filepath.Join(dir, e.Name()), source)
		if err != nil {
			if !errors.Is(err, fs.ErrNotExist) {
				slog.Warn("Модуль пропущен", "dir", filepath.Join(dir, e.Name()), "err", err)
			}
			continue
		}
		out = append(out, m)
	}
	return out
}

func openDir(dir, source string) (*Module, error) {
	data, err := os.ReadFile(filepath.Join(dir, manifestName)) //nolint:gosec // папка модулей задаётся настройками сервера
	if err != nil {
		return nil, err
	}
	man, err := ParseManifest(data)
	if err != nil {
		return nil, err
	}
	return &Module{Manifest: man, Source: source, FS: os.DirFS(dir), Dir: dir}, nil
}

// Install ставит (или обновляет) модуль из архива .btmod. Архив сначала
// целиком распаковывается во временную папку и проверяется, и только потом
// подменяет прежнюю версию — сбой посреди установки старую не ломает.
func (r *Registry) Install(archive string) (*Module, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.root == "" {
		return nil, fmt.Errorf("папка модулей не задана")
	}
	zr, err := zip.OpenReader(archive)
	if err != nil {
		return nil, &domain.ValidationError{Msg: "это не архив модуля (.btmod — zip): " + err.Error()}
	}
	defer func() { _ = zr.Close() }()

	prefix, man, err := findManifest(&zr.Reader)
	if err != nil {
		return nil, &domain.ValidationError{Msg: err.Error()}
	}
	if err := r.checkAppVersion(man); err != nil {
		return nil, &domain.ValidationError{Msg: err.Error()}
	}
	if err := os.MkdirAll(r.root, 0o750); err != nil {
		return nil, err
	}
	tmp := filepath.Join(r.root, ".install-"+man.ID+"-"+randomSuffix())
	if err := extract(&zr.Reader, prefix, tmp); err != nil {
		_ = os.RemoveAll(tmp)
		return nil, &domain.ValidationError{Msg: err.Error()}
	}
	final := filepath.Join(r.root, man.ID)
	old := ""
	if _, err := os.Stat(final); err == nil {
		old = filepath.Join(r.root, ".old-"+man.ID+"-"+randomSuffix())
		if err := os.Rename(final, old); err != nil {
			_ = os.RemoveAll(tmp)
			return nil, err
		}
	}
	if err := os.Rename(tmp, final); err != nil {
		if old != "" {
			_ = os.Rename(old, final)
		}
		_ = os.RemoveAll(tmp)
		return nil, err
	}
	if old != "" {
		_ = os.RemoveAll(old)
	}
	slog.Info("Модуль установлен", "id", man.ID, "version", man.Version)
	return openDir(final, SourceInstalled)
}

// Remove удаляет установленный модуль. Встроенный и dev-модуль удалить
// нельзя — их нет в папке установки. Карточки миров, склонированные из
// модуля, и токены на картах от этого не страдают: клон живёт в библиотеке
// мира, токен хранит свои числа.
func (r *Registry) Remove(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !validID.MatchString(id) || r.root == "" {
		return domain.ErrNotFound
	}
	dir := filepath.Join(r.root, id)
	if _, err := os.Stat(filepath.Join(dir, manifestName)); err != nil {
		for _, m := range r.builtin {
			if m.Manifest.ID == id {
				return &domain.ValidationError{Msg: "модуль встроен в программу — удалить его нельзя, только выключить в мире"}
			}
		}
		return domain.ErrNotFound
	}
	trash := filepath.Join(r.root, ".removed-"+id+"-"+randomSuffix())
	if err := os.Rename(dir, trash); err != nil {
		return err
	}
	slog.Info("Модуль удалён", "id", id)
	return os.RemoveAll(trash)
}

func (r *Registry) checkAppVersion(m *Manifest) error {
	if m.MinAppVersion == "" {
		return nil
	}
	app, err := ParseVersion(r.appVersion)
	if err != nil {
		return nil // сборка разработчика ("dev") — не проверяем
	}
	need, _ := ParseVersion(m.MinAppVersion)
	if app.Less(need) {
		return fmt.Errorf("модулю %s нужна программа не ниже %s, а у тебя %s — обнови Beacon Table", m.ID, need, app)
	}
	return nil
}

// findManifest — module.json в корне архива или в единственной папке
// верхнего уровня (так часто упаковывают: zip папки целиком).
func findManifest(zr *zip.Reader) (prefix string, man *Manifest, err error) {
	var candidates []*zip.File
	for _, f := range zr.File {
		name := strings.TrimPrefix(f.Name, "./")
		if name == manifestName || (strings.Count(name, "/") == 1 && strings.HasSuffix(name, "/"+manifestName)) {
			candidates = append(candidates, f)
		}
	}
	if len(candidates) == 0 {
		return "", nil, fmt.Errorf("в архиве нет module.json — это не модуль Beacon Table")
	}
	sort.Slice(candidates, func(i, j int) bool { return len(candidates[i].Name) < len(candidates[j].Name) })
	f := candidates[0]
	if f.UncompressedSize64 > maxManifestBytes {
		return "", nil, fmt.Errorf("module.json подозрительно большой")
	}
	rc, err := f.Open()
	if err != nil {
		return "", nil, err
	}
	data, err := io.ReadAll(io.LimitReader(rc, maxManifestBytes))
	_ = rc.Close()
	if err != nil {
		return "", nil, err
	}
	man, err = ParseManifest(data)
	if err != nil {
		return "", nil, err
	}
	return strings.TrimSuffix(strings.TrimPrefix(f.Name, "./"), manifestName), man, nil
}

// extract распаковывает записи архива с префиксом prefix в dir. Всё, что
// уводит за пределы dir (абсолютные пути, ".."), симлинки и прочие
// не-обычные файлы отклоняются.
func extract(zr *zip.Reader, prefix, dir string) error {
	var total int64
	files := 0
	for _, f := range zr.File {
		name := strings.TrimPrefix(f.Name, "./")
		if !strings.HasPrefix(name, prefix) {
			continue
		}
		rel := strings.TrimPrefix(name, prefix)
		if rel == "" {
			continue
		}
		target, ok := safeJoin(dir, rel)
		if !ok {
			return fmt.Errorf("в архиве путь за пределами модуля: %q", f.Name)
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o750); err != nil {
				return err
			}
			continue
		}
		if !f.FileInfo().Mode().IsRegular() {
			continue
		}
		files++
		if files > maxFiles {
			return fmt.Errorf("в архиве больше %d файлов", maxFiles)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o750); err != nil {
			return err
		}
		n, err := extractFile(f, target, maxUnpackedBytes-total)
		if err != nil {
			return err
		}
		total += n
	}
	return nil
}

func extractFile(f *zip.File, target string, budget int64) (int64, error) {
	if budget <= 0 {
		return 0, fmt.Errorf("распакованный модуль больше %d ГиБ", maxUnpackedBytes>>30)
	}
	rc, err := f.Open()
	if err != nil {
		return 0, fmt.Errorf("не удалось прочитать %s: %w", f.Name, err)
	}
	defer rc.Close()
	out, err := os.Create(target) //nolint:gosec // target прошёл safeJoin
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(out, io.LimitReader(rc, budget+1))
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return n, fmt.Errorf("не удалось распаковать %s: %w", f.Name, err)
	}
	if n > budget {
		return n, fmt.Errorf("распакованный модуль больше %d ГиБ", maxUnpackedBytes>>30)
	}
	return n, nil
}

// safeJoin — путь внутри dir по имени записи архива; ok=false, если имя
// уводит наружу.
func safeJoin(dir, name string) (string, bool) {
	if strings.Contains(name, "\\") || strings.HasPrefix(name, "/") || strings.Contains(name, ":") {
		return "", false
	}
	clean := path.Clean(name)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", false
	}
	return filepath.Join(dir, filepath.FromSlash(clean)), true
}

func randomSuffix() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Counts — сколько карточек каждого вида в модуле (для списка модулей и
// витрины). Считаются файлы .json, без разбора.
func (m *Module) Counts() map[string]int {
	out := map[string]int{}
	for _, kind := range Kinds {
		entries, err := fs.ReadDir(m.FS, m.ContentDir(kind))
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(e.Name(), ".json") {
				out[kind]++
			}
		}
	}
	return out
}
