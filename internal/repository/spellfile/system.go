// system.go — вторая половина пакета: каталог заклинаний "из коробки",
// зашитый в бинарник на этапе компиляции (SystemStore), и Catalog, который
// склеивает его с общей пользовательской библиотекой (Store, см.
// spellfile.go) в единый repository.SpellRepository. Та же схема, что и в
// internal/repository/monsterfile/system.go — см. комментарии там для
// обоснования решений (namespacing id по префиксу, id из имени файла и т.п.).
package spellfile

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"sort"
	"strings"

	"beacon-table/internal/domain"
)

// systemIDPrefix — namespaces id заклинаний каталога "из коробки" от id
// пользовательской библиотеки (случайный hex, см. service.newID()).
const systemIDPrefix = "sys-"

// SystemStore — каталог заклинаний "из коробки", зашитый в бинарник через
// embed.FS (см. cmd/beacon-table/main.go: //go:embed systemdata и
// cmd/beacon-table/systemdata/spells/*.json). Только чтение — правка/удаление
// через API отдаёт domain.ErrForbidden (см. Catalog ниже); хочет игрок или
// ДМ подправить заклинание "из коробки" — клонирует его в общую библиотеку
// (кнопка "Клонировать", см. web/src/pages/spellbook.js) и правит копию.
type SystemStore struct {
	fsys fs.FS
	dir  string
}

// NewSystemStore — dir здесь без хвостового "/", относительно корня fsys
// (например "systemdata/spells" при fsys = embed.FS из main.go).
func NewSystemStore(fsys fs.FS, dir string) *SystemStore {
	return &SystemStore{fsys: fsys, dir: dir}
}

func (s *SystemStore) idFromFilename(name string) string {
	base := strings.TrimSuffix(name, ".json")
	return systemIDPrefix + unsafeIDChars.ReplaceAllString(base, "_")
}

// filename — обратное к idFromFilename: id -> имя файла в каталоге.
// Санитайзер тот же, что у Store.spellPath — id тут приходит из URL (запрос
// клиента), доверять ему как "безопасному куску пути" нельзя.
func (s *SystemStore) filename(id string) string {
	base := strings.TrimPrefix(id, systemIDPrefix)
	safe := unsafeIDChars.ReplaceAllString(base, "_")
	if safe == "" {
		safe = "spell"
	}
	return safe + ".json"
}

func (s *SystemStore) List(ctx context.Context) ([]*domain.Spell, error) {
	entries, err := fs.ReadDir(s.fsys, s.dir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []*domain.Spell{}, nil
		}
		return nil, err
	}
	spells := make([]*domain.Spell, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := fs.ReadFile(s.fsys, s.dir+"/"+e.Name())
		if err != nil {
			continue // битый файл каталога не должен ронять весь список
		}
		var sp domain.Spell
		if err := json.Unmarshal(data, &sp); err != nil {
			continue
		}
		sp.ID = s.idFromFilename(e.Name())
		sp.System = true
		spells = append(spells, &sp)
	}
	sort.Slice(spells, func(i, j int) bool {
		if spells[i].Level != spells[j].Level {
			return spells[i].Level < spells[j].Level
		}
		return strings.ToLower(spells[i].Name) < strings.ToLower(spells[j].Name)
	})
	return spells, nil
}

func (s *SystemStore) Get(ctx context.Context, id string) (*domain.Spell, error) {
	data, err := fs.ReadFile(s.fsys, s.dir+"/"+s.filename(id))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, domain.ErrNotFound
		}
		return nil, err
	}
	var sp domain.Spell
	if err := json.Unmarshal(data, &sp); err != nil {
		return nil, err
	}
	sp.ID = id
	sp.System = true
	return &sp, nil
}

// Catalog реализует repository.SpellRepository поверх двух источников —
// SystemStore (только чтение, из бинарника) и Store (общая пользовательская
// библиотека на диске) — service-слой (SpellService) не знает о каталоге
// "из коробки", видит один SpellRepository, как и раньше.
type Catalog struct {
	system *SystemStore
	user   *Store
}

// NewCatalog — user обычно spellfile.NewStore(dataDir), system —
// spellfile.NewSystemStore(embed.FS, "systemdata/spells").
func NewCatalog(user *Store, system *SystemStore) *Catalog {
	return &Catalog{system: system, user: user}
}

func (c *Catalog) List(ctx context.Context) ([]*domain.Spell, error) {
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
		if all[i].Level != all[j].Level {
			return all[i].Level < all[j].Level
		}
		return strings.ToLower(all[i].Name) < strings.ToLower(all[j].Name)
	})
	return all, nil
}

func (c *Catalog) Get(ctx context.Context, id string) (*domain.Spell, error) {
	if strings.HasPrefix(id, systemIDPrefix) {
		return c.system.Get(ctx, id)
	}
	sp, err := c.user.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	sp.System = false // на случай, если файл на диске поправили руками мимо приложения
	return sp, nil
}

func (c *Catalog) Create(ctx context.Context, id string, sp *domain.Spell) error {
	sp.System = false
	return c.user.Create(ctx, id, sp)
}

// Update возвращает domain.ErrForbidden для карточек каталога "из коробки" —
// api-слой мапит её на HTTP 403 (см. internal/api/http/spell_handlers.go).
func (c *Catalog) Update(ctx context.Context, id string, sp *domain.Spell) (bool, error) {
	if strings.HasPrefix(id, systemIDPrefix) {
		return false, domain.ErrForbidden
	}
	sp.System = false
	return c.user.Update(ctx, id, sp)
}

func (c *Catalog) Delete(ctx context.Context, id string) error {
	if strings.HasPrefix(id, systemIDPrefix) {
		return domain.ErrForbidden
	}
	return c.user.Delete(ctx, id)
}
