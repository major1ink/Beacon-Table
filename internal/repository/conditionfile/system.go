// system.go — вторая половина пакета: каталог состояний «из коробки»,
// зашитый в бинарник на этапе компиляции (SystemStore), и Catalog, который
// склеивает его с пользовательской библиотекой (Store, см.
// conditionfile.go) в единый repository.ConditionRepository. Та же схема,
// что в internal/repository/referencefile/system.go — см. комментарии там
// про namespacing id по префиксу и id из имени файла.
//
// Именно этот файл (точнее, подпапка systemdata/conditions/<system>,
// которую сюда передаёт app.CompanyManager.Launch) и реализует требование
// «статусы делятся по игровым системам»: мир на D&D 2014 видит состояния из
// dnd5e-2014, мир на 2024 — из dnd5e-2024, никакого ветвления по системе в
// остальном коде нет.
package conditionfile

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"strings"

	"beacon-table/internal/domain"
)

// systemIDPrefix — namespaces id состояний каталога «из коробки» от id
// пользовательской библиотеки (случайный hex, см. service.newID()).
const systemIDPrefix = "sys-"

// SystemStore — каталог состояний «из коробки», зашитый в бинарник через
// embed.FS (см. cmd/beacon-table/main.go: //go:embed systemdata и
// cmd/beacon-table/systemdata/conditions/<system>/*.json). Только чтение —
// правка/удаление через API отдаёт domain.ErrForbidden (см. Catalog ниже);
// хочет ДМ подправить состояние «из коробки» — клонирует его в библиотеку и
// правит копию.
type SystemStore struct {
	fsys fs.FS
	dir  string
}

// NewSystemStore — dir здесь без хвостового "/", относительно корня fsys
// (например "systemdata/conditions/dnd5e-2024" при fsys = embed.FS из main.go).
func NewSystemStore(fsys fs.FS, dir string) *SystemStore {
	return &SystemStore{fsys: fsys, dir: dir}
}

func (s *SystemStore) idFromFilename(name string) string {
	base := strings.TrimSuffix(name, ".json")
	return systemIDPrefix + unsafeIDChars.ReplaceAllString(base, "_")
}

// filename — обратное к idFromFilename: id -> имя файла в каталоге. id тут
// приходит из URL (запрос клиента), доверять ему как «безопасному куску
// пути» нельзя — санитайзер тот же, что у Store.conditionPath.
func (s *SystemStore) filename(id string) string {
	base := strings.TrimPrefix(id, systemIDPrefix)
	safe := unsafeIDChars.ReplaceAllString(base, "_")
	if safe == "" {
		safe = "condition"
	}
	return safe + ".json"
}

func (s *SystemStore) List(ctx context.Context) ([]*domain.Condition, error) {
	entries, err := fs.ReadDir(s.fsys, s.dir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []*domain.Condition{}, nil
		}
		return nil, err
	}
	conds := make([]*domain.Condition, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := fs.ReadFile(s.fsys, s.dir+"/"+e.Name())
		if err != nil {
			continue // битый файл каталога не должен ронять весь список
		}
		var c domain.Condition
		if err := json.Unmarshal(data, &c); err != nil {
			continue
		}
		c.ID = s.idFromFilename(e.Name())
		c.System = true
		conds = append(conds, &c)
	}
	sortByName(conds)
	return conds, nil
}

func (s *SystemStore) Get(ctx context.Context, id string) (*domain.Condition, error) {
	data, err := fs.ReadFile(s.fsys, s.dir+"/"+s.filename(id))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, domain.ErrNotFound
		}
		return nil, err
	}
	var c domain.Condition
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, err
	}
	c.ID = id
	c.System = true
	return &c, nil
}

// Catalog реализует repository.ConditionRepository поверх двух источников —
// SystemStore (только чтение, из бинарника) и Store (пользовательская
// библиотека на диске) — так, что service-слой видит один репозиторий.
type Catalog struct {
	system *SystemStore
	user   *Store
}

// NewCatalog — user обычно conditionfile.NewStore(dataDir), system —
// conditionfile.NewSystemStore(embed.FS, "systemdata/conditions/"+system).
func NewCatalog(user *Store, system *SystemStore) *Catalog {
	return &Catalog{system: system, user: user}
}

func (c *Catalog) List(ctx context.Context) ([]*domain.Condition, error) {
	sysList, err := c.system.List(ctx)
	if err != nil {
		return nil, err
	}
	userList, err := c.user.List(ctx)
	if err != nil {
		return nil, err
	}
	all := append(sysList, userList...)
	sortByName(all)
	return all, nil
}

func (c *Catalog) Get(ctx context.Context, id string) (*domain.Condition, error) {
	if strings.HasPrefix(id, systemIDPrefix) {
		return c.system.Get(ctx, id)
	}
	cond, err := c.user.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	cond.System = false // на случай, если файл на диске поправили руками мимо приложения
	return cond, nil
}

func (c *Catalog) Create(ctx context.Context, id string, cond *domain.Condition) error {
	cond.System = false
	return c.user.Create(ctx, id, cond)
}

// Update возвращает domain.ErrForbidden для карточек каталога «из коробки» —
// api-слой мапит её на HTTP 403 (см. condition_handlers.go).
func (c *Catalog) Update(ctx context.Context, id string, cond *domain.Condition) (bool, error) {
	if strings.HasPrefix(id, systemIDPrefix) {
		return false, domain.ErrForbidden
	}
	cond.System = false
	return c.user.Update(ctx, id, cond)
}

func (c *Catalog) Delete(ctx context.Context, id string) error {
	if strings.HasPrefix(id, systemIDPrefix) {
		return domain.ErrForbidden
	}
	return c.user.Delete(ctx, id)
}
