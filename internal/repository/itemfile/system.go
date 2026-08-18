// system.go — вторая половина пакета: каталог предметов "из коробки", зашитый
// в бинарник на этапе компиляции (SystemStore), и Catalog, который склеивает
// его с общей пользовательской библиотекой (Store, см. itemfile.go) в единый
// repository.ItemRepository. Та же схема, что и в
// internal/repository/spellfile/system.go — см. комментарии там для
// обоснования решений (namespacing id по префиксу, id из имени файла и т.п.).
package itemfile

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"sort"
	"strings"

	"beacon-table/internal/domain"
)

// systemIDPrefix — namespaces id предметов каталога "из коробки" от id
// пользовательской библиотеки (случайный hex, см. service.newID()).
const systemIDPrefix = "sys-"

// SystemStore — каталог предметов "из коробки", зашитый в бинарник через
// embed.FS (см. cmd/beacon-table/main.go: //go:embed systemdata и
// cmd/beacon-table/systemdata/items/*.json). Только чтение — правка/удаление
// через API отдаёт domain.ErrForbidden (см. Catalog ниже); хочет игрок или
// ДМ подправить предмет "из коробки" — клонирует его в общую библиотеку
// (кнопка "Клонировать", см. web/src/pages/itembook.js) и правит копию.
type SystemStore struct {
	fsys fs.FS
	dir  string
}

// NewSystemStore — dir здесь без хвостового "/", относительно корня fsys
// (например "systemdata/items" при fsys = embed.FS из main.go).
func NewSystemStore(fsys fs.FS, dir string) *SystemStore {
	return &SystemStore{fsys: fsys, dir: dir}
}

func (s *SystemStore) idFromFilename(name string) string {
	base := strings.TrimSuffix(name, ".json")
	return systemIDPrefix + unsafeIDChars.ReplaceAllString(base, "_")
}

// filename — обратное к idFromFilename: id -> имя файла в каталоге.
// Санитайзер тот же, что у Store.itemPath — id тут приходит из URL (запрос
// клиента), доверять ему как "безопасному куску пути" нельзя.
func (s *SystemStore) filename(id string) string {
	base := strings.TrimPrefix(id, systemIDPrefix)
	safe := unsafeIDChars.ReplaceAllString(base, "_")
	if safe == "" {
		safe = "item"
	}
	return safe + ".json"
}

func (s *SystemStore) List(ctx context.Context) ([]*domain.Item, error) {
	entries, err := fs.ReadDir(s.fsys, s.dir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []*domain.Item{}, nil
		}
		return nil, err
	}
	items := make([]*domain.Item, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := fs.ReadFile(s.fsys, s.dir+"/"+e.Name())
		if err != nil {
			continue // битый файл каталога не должен ронять весь список
		}
		var it domain.Item
		if err := json.Unmarshal(data, &it); err != nil {
			continue
		}
		it.ID = s.idFromFilename(e.Name())
		it.System = true
		items = append(items, &it)
	}
	sort.Slice(items, func(i, j int) bool {
		return strings.ToLower(items[i].Name) < strings.ToLower(items[j].Name)
	})
	return items, nil
}

func (s *SystemStore) Get(ctx context.Context, id string) (*domain.Item, error) {
	data, err := fs.ReadFile(s.fsys, s.dir+"/"+s.filename(id))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, domain.ErrNotFound
		}
		return nil, err
	}
	var it domain.Item
	if err := json.Unmarshal(data, &it); err != nil {
		return nil, err
	}
	it.ID = id
	it.System = true
	return &it, nil
}

// Catalog реализует repository.ItemRepository поверх двух источников —
// SystemStore (только чтение, из бинарника) и Store (общая пользовательская
// библиотека на диске) — service-слой (ItemService) не знает о каталоге "из
// коробки", видит один ItemRepository, как и раньше.
type Catalog struct {
	system *SystemStore
	user   *Store
}

// NewCatalog — user обычно itemfile.NewStore(dataDir), system —
// itemfile.NewSystemStore(embed.FS, "systemdata/items").
func NewCatalog(user *Store, system *SystemStore) *Catalog {
	return &Catalog{system: system, user: user}
}

func (c *Catalog) List(ctx context.Context) ([]*domain.Item, error) {
	sysList, err := c.system.List(ctx)
	if err != nil {
		return nil, err
	}
	userList, err := c.user.List(ctx)
	if err != nil {
		return nil, err
	}
	all := append(sysList, userList...)
	sort.Slice(all, func(i, j int) bool {
		return strings.ToLower(all[i].Name) < strings.ToLower(all[j].Name)
	})
	return all, nil
}

func (c *Catalog) Get(ctx context.Context, id string) (*domain.Item, error) {
	if strings.HasPrefix(id, systemIDPrefix) {
		return c.system.Get(ctx, id)
	}
	it, err := c.user.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	it.System = false // на случай, если файл на диске поправили руками мимо приложения
	return it, nil
}

func (c *Catalog) Create(ctx context.Context, id string, it *domain.Item) error {
	it.System = false
	return c.user.Create(ctx, id, it)
}

// Update возвращает domain.ErrForbidden для карточек каталога "из коробки" —
// api-слой мапит её на HTTP 403 (см. internal/api/http/item_handlers.go).
func (c *Catalog) Update(ctx context.Context, id string, it *domain.Item) (bool, error) {
	if strings.HasPrefix(id, systemIDPrefix) {
		return false, domain.ErrForbidden
	}
	it.System = false
	return c.user.Update(ctx, id, it)
}

func (c *Catalog) Delete(ctx context.Context, id string) error {
	if strings.HasPrefix(id, systemIDPrefix) {
		return domain.ErrForbidden
	}
	return c.user.Delete(ctx, id)
}
