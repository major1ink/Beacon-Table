// Package localfs реализует repository.AssetRepository поверх обычной
// файловой системы: загруженные карты/токены/аудио живут на диске, а не в
// embed.FS — embed зашивается только на этапе компиляции, рантайм-аплоады
// физически не могут туда попасть.
package localfs

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"beacon-table/internal/domain"
)

// knownKinds — подпапки, которые реально изолируются от общей "плоской"
// uploads/: карты, токены, аудио, файлы заметок, ассеты карты. Всё
// остальное (пустой/незнакомый kind) падает в корень rootDir с urlPrefix как
// есть — так вело себя исходное приложение, сохраняем поведение 1-в-1.
var knownKinds = map[string]bool{
	domain.AssetKindMaps:     true,
	domain.AssetKindTokens:   true,
	domain.AssetKindAudio:    true,
	domain.AssetKindNotes:    true,
	domain.AssetKindProps:    true,
	domain.AssetKindHandouts: true,
}

// Store — реализация repository.AssetRepository. rootDir — корневая папка
// загрузок на диске (по умолчанию "uploads"), urlPrefix — префикс, под
// которым эта папка раздаётся статикой (по умолчанию "/uploads/").
type Store struct {
	rootDir   string
	urlPrefix string
}

// NewStore создаёт хранилище ассетов с файлами в rootDir, раздаваемыми по
// urlPrefix.
func NewStore(rootDir, urlPrefix string) *Store {
	return &Store{rootDir: rootDir, urlPrefix: urlPrefix}
}

// EnsureDirs создаёт rootDir и все известные подпапки (maps/tokens/audio/…)
// заранее — вызывается композиционным корнем при старте, чтобы Save/List
// не спотыкались об отсутствующие директории на первом обращении.
func (s *Store) EnsureDirs() error {
	if err := os.MkdirAll(s.rootDir, 0o750); err != nil {
		return err
	}
	for _, kind := range domain.AssetKinds {
		if err := os.MkdirAll(filepath.Join(s.rootDir, kind), 0o750); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) dirAndPrefix(kind string) (dir, urlPrefix string) {
	if knownKinds[kind] {
		return filepath.Join(s.rootDir, kind), s.urlPrefix + kind + "/"
	}
	return s.rootDir, s.urlPrefix
}

// sanitizeFolder нормализует posix-путь подпапки, присланный клиентом:
// обрезает крайние "/", разбивает на сегменты и отклоняет пустые/"."/".." —
// единственная защита от выхода за пределы kind-директории при создании
// папок и сохранении файлов (Save/CreateFolder/DeleteFolder ниже все идут
// через неё, напрямую folder от клиента в filepath.Join не попадает).
func sanitizeFolder(folder string) (string, error) {
	folder = strings.TrimSpace(folder)
	folder = strings.Trim(folder, "/")
	if folder == "" {
		return "", nil
	}
	parts := strings.Split(folder, "/")
	clean := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" || p == "." || p == ".." {
			return "", fmt.Errorf("недопустимое имя папки")
		}
		clean = append(clean, p)
	}
	return strings.Join(clean, "/"), nil
}

// Save implements repository.AssetRepository. Имя файла уникализируется
// временной меткой в наносекундах, чтобы не перезаписывать чужие карты и не
// ловить коллизии от одинаковых имён файлов у разных пользователей.
func (s *Store) Save(ctx context.Context, kind, folder, filename string, r io.Reader) (string, error) {
	baseDir, urlPrefix := s.dirAndPrefix(kind)
	folder, err := sanitizeFolder(folder)
	if err != nil {
		return "", err
	}
	dir := baseDir
	urlFolder := ""
	if folder != "" {
		dir = filepath.Join(baseDir, filepath.FromSlash(folder))
		urlFolder = folder + "/"
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return "", err
	}

	safeName := fmt.Sprintf("%d-%s", time.Now().UnixNano(), filepath.Base(filename))
	//nolint:gosec // G304: safeName — только filepath.Base(filename) с
	// добавленным числовым префиксом, ".."/"/" в нём быть не может; dir
	// собран из kind (проверен knownKinds) и folder, прогнанного через
	// sanitizeFolder выше (отклоняет "."/".."/пустые сегменты).
	dst, err := os.Create(filepath.Join(dir, safeName))
	if err != nil {
		return "", err
	}
	defer dst.Close()

	if _, err := io.Copy(dst, r); err != nil {
		return "", err
	}
	return urlPrefix + urlFolder + safeName, nil
}

// List implements repository.AssetRepository. Отдаёт уже загруженные файлы
// вида kind рекурсивно по всем подпапкам, новые сверху — имя файла
// начинается с UnixNano, так что лексикографическая сортировка по URL/имени
// файла = сортировка по времени.
func (s *Store) List(ctx context.Context, kind string) ([]domain.AssetInfo, error) {
	dir := filepath.Join(s.rootDir, kind)
	if _, err := os.Stat(dir); err != nil {
		return []domain.AssetInfo{}, nil
	}
	out := make([]domain.AssetInfo, 0, 16)
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		folder, name := "", rel
		if idx := strings.LastIndex(rel, "/"); idx != -1 {
			folder, name = rel[:idx], rel[idx+1:]
		}
		display := name
		if idx := strings.Index(name, "-"); idx != -1 && idx+1 < len(name) {
			display = name[idx+1:] // убираем "<unixnano>-" префикс для читаемости
		}
		ext := strings.TrimPrefix(filepath.Ext(name), ".")
		var size int64
		var modTime string
		if info, err := d.Info(); err == nil {
			size = info.Size()
			modTime = info.ModTime().Format(time.RFC3339)
		}
		out = append(out, domain.AssetInfo{
			URL:     s.urlPrefix + kind + "/" + rel,
			Name:    display,
			Ext:     strings.ToUpper(ext),
			Size:    size,
			ModTime: modTime,
			Path:    folder,
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].URL > out[j].URL })
	return out, nil
}

// Folders implements repository.AssetRepository — обходит дерево kind и
// собирает ВСЕ подпапки, включая пустые (без единого файла внутри), чтобы
// созданная, но ещё не заполненная папка не пропадала из библиотеки.
func (s *Store) Folders(ctx context.Context, kind string) ([]domain.AssetFolder, error) {
	dir := filepath.Join(s.rootDir, kind)
	if _, err := os.Stat(dir); err != nil {
		return []domain.AssetFolder{}, nil
	}
	out := make([]domain.AssetFolder, 0, 8)
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p == dir || !d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return nil
		}
		out = append(out, domain.AssetFolder{Path: filepath.ToSlash(rel)})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}

// CreateFolder implements repository.AssetRepository.
func (s *Store) CreateFolder(ctx context.Context, kind, folder string) error {
	baseDir, _ := s.dirAndPrefix(kind)
	folder, err := sanitizeFolder(folder)
	if err != nil {
		return err
	}
	if folder == "" {
		return fmt.Errorf("имя папки не может быть пустым")
	}
	return os.MkdirAll(filepath.Join(baseDir, filepath.FromSlash(folder)), 0o750)
}

// DeleteFolder implements repository.AssetRepository — удаляет папку со
// всем содержимым (файлами и вложенными подпапками).
func (s *Store) DeleteFolder(ctx context.Context, kind, folder string) error {
	baseDir, _ := s.dirAndPrefix(kind)
	folder, err := sanitizeFolder(folder)
	if err != nil {
		return err
	}
	if folder == "" {
		return fmt.Errorf("нельзя удалить корневую папку")
	}
	return os.RemoveAll(filepath.Join(baseDir, filepath.FromSlash(folder)))
}

// DeleteAsset implements repository.AssetRepository. assetURL — публичный
// URL, ранее выданный Save/List; функция сверяет префикс и чистит путь,
// чтобы запрос не мог удалить файл вне директории kind.
func (s *Store) DeleteAsset(ctx context.Context, kind, assetURL string) error {
	dir, urlPrefix := s.dirAndPrefix(kind)
	rel := strings.TrimPrefix(assetURL, urlPrefix)
	if rel == "" || rel == assetURL {
		return fmt.Errorf("некорректный url ассета")
	}
	relClean := filepath.Clean(filepath.FromSlash(rel))
	if relClean == "." || relClean == ".." || strings.HasPrefix(relClean, ".."+string(os.PathSeparator)) || filepath.IsAbs(relClean) {
		return fmt.Errorf("некорректный url ассета")
	}
	full := filepath.Join(dir, relClean)
	cleanDir := filepath.Clean(dir)
	if full != cleanDir && !strings.HasPrefix(full, cleanDir+string(os.PathSeparator)) {
		return fmt.Errorf("некорректный url ассета")
	}
	return os.Remove(full)
}
