// Package itemfile реализует repository.ItemRepository поверх обычных
// .json-файлов на диске: по файлу на предмет (dataDir/items/<id>.json), тот
// же принцип атомарной записи (tmp + rename), что и в spellfile/monsterfile/
// notefile/scenefile — падение/убийство процесса посреди записи не роняет
// остальную библиотеку и не оставляет битый файл этого предмета. Библиотека
// предметов общая на весь стол (не привязана к ДМ, в отличие от бестиария),
// но формат хранения — тот же самый файл-на-запись, разница только в том,
// кто имеет доступ к API поверх этого репозитория (см.
// internal/api/http/item_handlers.go: requireAccount, а не
// requireAdminAccount).
package itemfile

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"beacon-table/internal/domain"
)

// Store реализует repository.ItemRepository.
type Store struct {
	dir string
}

// NewStore создаёт репозиторий библиотеки предметов в dataDir/items.
func NewStore(dataDir string) *Store {
	return &Store{dir: filepath.Join(dataDir, "items")}
}

var unsafeIDChars = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// itemPath — путь файла предмета по его ID. ID уже filesystem-safe
// (генерируется как hex-строка, см. service.newID()), санитайзер — на
// случай ручной правки файлов на диске мимо приложения (как в spellfile).
func (s *Store) itemPath(id string) string {
	safe := unsafeIDChars.ReplaceAllString(id, "_")
	if safe == "" {
		safe = "item"
	}
	return filepath.Join(s.dir, safe+".json")
}

func (s *Store) List(ctx context.Context) ([]*domain.Item, error) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []*domain.Item{}, nil
		}
		return nil, err
	}
	items := make([]*domain.Item, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(s.dir, e.Name()))
		if err != nil {
			continue // повреждённый/недоступный файл одного предмета не роняет список остальных
		}
		var it domain.Item
		if err := json.Unmarshal(data, &it); err != nil {
			continue
		}
		items = append(items, &it)
	}
	sort.Slice(items, func(i, j int) bool {
		return strings.ToLower(items[i].Name) < strings.ToLower(items[j].Name)
	})
	return items, nil
}

func (s *Store) Get(ctx context.Context, id string) (*domain.Item, error) {
	data, err := os.ReadFile(s.itemPath(id))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, domain.ErrNotFound
		}
		return nil, err
	}
	var it domain.Item
	if err := json.Unmarshal(data, &it); err != nil {
		return nil, err
	}
	return &it, nil
}

// writeAtomic — общая запись Create/Update: во временный файл и
// переименование поверх целевого (см. spellfile.writeAtomic).
func (s *Store) writeAtomic(id string, it *domain.Item) error {
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(it, "", "  ")
	if err != nil {
		return err
	}
	p := s.itemPath(id)
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func (s *Store) Create(ctx context.Context, id string, it *domain.Item) error {
	return s.writeAtomic(id, it)
}

func (s *Store) Update(ctx context.Context, id string, it *domain.Item) (bool, error) {
	if _, err := os.Stat(s.itemPath(id)); err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	if err := s.writeAtomic(id, it); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Store) Delete(ctx context.Context, id string) error {
	err := os.Remove(s.itemPath(id))
	if err != nil && os.IsNotExist(err) {
		return nil
	}
	return err
}
