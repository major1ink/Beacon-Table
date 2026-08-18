// system.go — вторая половина пакета: каталог справочника "из коробки",
// зашитый в бинарник на этапе компиляции (SystemStore), и Catalog, который
// склеивает его с общей пользовательской библиотекой (Store, см.
// referencefile.go) в единый repository.ReferenceRepository. Та же схема,
// что и в internal/repository/itemfile/system.go — см. комментарии там для
// обоснования решений (namespacing id по префиксу, id из имени файла и т.п.).
package referencefile

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"sort"
	"strings"

	"beacon-table/internal/domain"
)

// systemIDPrefix — namespaces id записей каталога "из коробки" от id
// пользовательской библиотеки (случайный hex, см. service.newID()).
const systemIDPrefix = "sys-"

// SystemStore — каталог справочника "из коробки", зашитый в бинарник через
// embed.FS (см. cmd/beacon-table/main.go: //go:embed systemdata и
// cmd/beacon-table/systemdata/references/*.json). Только чтение — правка/
// удаление через API отдаёт domain.ErrForbidden (см. Catalog ниже); хочет
// игрок или ДМ подправить запись "из коробки" — клонирует её в общую
// библиотеку и правит копию.
type SystemStore struct {
	fsys fs.FS
	dir  string
}

// NewSystemStore — dir здесь без хвостового "/", относительно корня fsys
// (например "systemdata/references/dnd5e-2024" при fsys = embed.FS из main.go).
func NewSystemStore(fsys fs.FS, dir string) *SystemStore {
	return &SystemStore{fsys: fsys, dir: dir}
}

func (s *SystemStore) idFromFilename(name string) string {
	base := strings.TrimSuffix(name, ".json")
	return systemIDPrefix + unsafeIDChars.ReplaceAllString(base, "_")
}

// filename — обратное к idFromFilename: id -> имя файла в каталоге.
func (s *SystemStore) filename(id string) string {
	base := strings.TrimPrefix(id, systemIDPrefix)
	safe := unsafeIDChars.ReplaceAllString(base, "_")
	if safe == "" {
		safe = "reference"
	}
	return safe + ".json"
}

func (s *SystemStore) List(ctx context.Context) ([]*domain.Reference, error) {
	entries, err := fs.ReadDir(s.fsys, s.dir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []*domain.Reference{}, nil
		}
		return nil, err
	}
	refs := make([]*domain.Reference, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := fs.ReadFile(s.fsys, s.dir+"/"+e.Name())
		if err != nil {
			continue // битый файл каталога не должен ронять весь список
		}
		var ref domain.Reference
		if err := json.Unmarshal(data, &ref); err != nil {
			continue
		}
		ref.ID = s.idFromFilename(e.Name())
		ref.System = true
		refs = append(refs, &ref)
	}
	sort.Slice(refs, func(i, j int) bool {
		return strings.ToLower(refs[i].Name) < strings.ToLower(refs[j].Name)
	})
	return refs, nil
}

func (s *SystemStore) Get(ctx context.Context, id string) (*domain.Reference, error) {
	data, err := fs.ReadFile(s.fsys, s.dir+"/"+s.filename(id))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, domain.ErrNotFound
		}
		return nil, err
	}
	var ref domain.Reference
	if err := json.Unmarshal(data, &ref); err != nil {
		return nil, err
	}
	ref.ID = id
	ref.System = true
	return &ref, nil
}

// Catalog реализует repository.ReferenceRepository поверх двух источников —
// SystemStore (только чтение, из бинарника) и Store (общая пользовательская
// библиотека на диске) — service-слой (ReferenceService) не знает о каталоге
// "из коробки", видит один ReferenceRepository, как и раньше.
type Catalog struct {
	system *SystemStore
	user   *Store
}

// NewCatalog — user обычно referencefile.NewStore(dataDir), system —
// referencefile.NewSystemStore(embed.FS, "systemdata/references/<system>").
func NewCatalog(user *Store, system *SystemStore) *Catalog {
	return &Catalog{system: system, user: user}
}

func (c *Catalog) List(ctx context.Context) ([]*domain.Reference, error) {
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

func (c *Catalog) Get(ctx context.Context, id string) (*domain.Reference, error) {
	if strings.HasPrefix(id, systemIDPrefix) {
		return c.system.Get(ctx, id)
	}
	ref, err := c.user.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	ref.System = false // на случай, если файл на диске поправили руками мимо приложения
	return ref, nil
}

func (c *Catalog) Create(ctx context.Context, id string, ref *domain.Reference) error {
	ref.System = false
	return c.user.Create(ctx, id, ref)
}

// Update возвращает domain.ErrForbidden для карточек каталога "из коробки" —
// api-слой мапит её на HTTP 403 (см. internal/api/http/reference_handlers.go).
func (c *Catalog) Update(ctx context.Context, id string, ref *domain.Reference) (bool, error) {
	if strings.HasPrefix(id, systemIDPrefix) {
		return false, domain.ErrForbidden
	}
	ref.System = false
	return c.user.Update(ctx, id, ref)
}

func (c *Catalog) Delete(ctx context.Context, id string) error {
	if strings.HasPrefix(id, systemIDPrefix) {
		return domain.ErrForbidden
	}
	return c.user.Delete(ctx, id)
}
