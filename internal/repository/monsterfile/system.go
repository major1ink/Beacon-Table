// system.go — вторая половина пакета: каталог монстров "из коробки",
// зашитый в бинарник на этапе компиляции (SystemStore), и Catalog,
// который склеивает его с пользовательской библиотекой (Store, см.
// monsterfile.go) в единый repository.MonsterRepository. Разделение на два
// файла в одном пакете, а не отдельный подпакет — SystemStore/Catalog тесно
// завязаны на internal-детали Store (monsterPath, writeAtomic) незачем
// городить экспортируемую границу между ними.
package monsterfile

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"sort"
	"strings"

	"beacon-table/internal/domain"
)

// systemIDPrefix — namespaces id монстров каталога "из коробки" от id
// пользовательской библиотеки (случайный hex, см. service.newID() —
// никогда не содержит небезопасных для hex символов вроде "s"/"y"/"-",
// коллизия исключена). По этому префиксу Catalog.{Get,Update,Delete}
// узнают, в какое хранилище идти, не гоняя запрос по обоим сразу.
const systemIDPrefix = "sys-"

// SystemStore — каталог монстров "из коробки", зашитый в бинарник через
// embed.FS (см. cmd/beacon-table/main.go: //go:embed systemdata и
// cmd/beacon-table/systemdata/bestiary/*.json). Только чтение: ДМ не может
// поправить или удалить эти карточки — версия монстра "из коробки"
// обновляется целиком при обновлении бинарника, а не правкой на месте.
// Хочет ДМ подправить — клонирует карточку в свою библиотеку (кнопка
// "Клонировать", см. web/src/pages/bestiary.js) и правит уже копию.
//
// В отличие от Store (id — часть JSON, файл — просто его отражение на
// диске), тут id берётся из имени файла, а не из содержимого: карточки
// каталога — обычные .json-файлы в исходниках проекта, которым незачем
// вручную проставлять "id" (человекочитаемое имя файла и так уникально и
// стабильно между сборками, в отличие от случайного hex).
type SystemStore struct {
	fsys fs.FS
	dir  string
}

// NewSystemStore — dir здесь без хвостового "/", относительно корня fsys
// (например "systemdata/bestiary" при fsys = embed.FS из main.go).
func NewSystemStore(fsys fs.FS, dir string) *SystemStore {
	return &SystemStore{fsys: fsys, dir: dir}
}

func (s *SystemStore) idFromFilename(name string) string {
	base := strings.TrimSuffix(name, ".json")
	return systemIDPrefix + unsafeIDChars.ReplaceAllString(base, "_")
}

// filename — обратное к idFromFilename: id -> имя файла в каталоге.
// Санитайзер тот же, что и у Store.monsterPath — id тут приходит из URL
// (запрос клиента), доверять ему как "безопасному куску пути" нельзя.
func (s *SystemStore) filename(id string) string {
	base := strings.TrimPrefix(id, systemIDPrefix)
	safe := unsafeIDChars.ReplaceAllString(base, "_")
	if safe == "" {
		safe = "monster"
	}
	return safe + ".json"
}

func (s *SystemStore) List(ctx context.Context) ([]*domain.Monster, error) {
	entries, err := fs.ReadDir(s.fsys, s.dir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []*domain.Monster{}, nil
		}
		return nil, err
	}
	monsters := make([]*domain.Monster, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := fs.ReadFile(s.fsys, s.dir+"/"+e.Name())
		if err != nil {
			continue // битый файл каталога не должен ронять весь список
		}
		var m domain.Monster
		if err := json.Unmarshal(data, &m); err != nil {
			continue
		}
		m.ID = s.idFromFilename(e.Name())
		m.System = true
		monsters = append(monsters, &m)
	}
	sort.Slice(monsters, func(i, j int) bool { return strings.ToLower(monsters[i].Name) < strings.ToLower(monsters[j].Name) })
	return monsters, nil
}

func (s *SystemStore) Get(ctx context.Context, id string) (*domain.Monster, error) {
	data, err := fs.ReadFile(s.fsys, s.dir+"/"+s.filename(id))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, domain.ErrNotFound
		}
		return nil, err
	}
	var m domain.Monster
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	m.ID = id
	m.System = true
	return &m, nil
}

// Catalog реализует repository.MonsterRepository поверх двух источников —
// SystemStore (только чтение, из бинарника) и Store (пользовательская
// библиотека на диске) — так, что service-слой (BestiaryService) вообще не
// знает о существовании каталога "из коробки": видит один
// MonsterRepository, как и раньше. List отдаёт оба списка вместе,
// Get/Update/Delete маршрутизируются по systemIDPrefix, Create всегда пишет
// в пользовательскую библиотеку (новые карточки не бывают "системными").
type Catalog struct {
	system *SystemStore
	user   *Store
}

// NewCatalog — user обычно monsterfile.NewStore(dataDir), system —
// monsterfile.NewSystemStore(embed.FS, "systemdata/bestiary").
func NewCatalog(user *Store, system *SystemStore) *Catalog {
	return &Catalog{system: system, user: user}
}

func (c *Catalog) List(ctx context.Context) ([]*domain.Monster, error) {
	sysList, err := c.system.List(ctx)
	if err != nil {
		return nil, err
	}
	userList, err := c.user.List(ctx)
	if err != nil {
		return nil, err
	}
	all := append(sysList, userList...)
	sort.Slice(all, func(i, j int) bool { return strings.ToLower(all[i].Name) < strings.ToLower(all[j].Name) })
	return all, nil
}

func (c *Catalog) Get(ctx context.Context, id string) (*domain.Monster, error) {
	if strings.HasPrefix(id, systemIDPrefix) {
		return c.system.Get(ctx, id)
	}
	m, err := c.user.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	m.System = false // на случай, если файл на диске поправили руками мимо приложения
	return m, nil
}

func (c *Catalog) Create(ctx context.Context, id string, m *domain.Monster) error {
	m.System = false
	return c.user.Create(ctx, id, m)
}

// Update возвращает domain.ErrForbidden для карточек каталога "из коробки" —
// api-слой мапит её на HTTP 403 (см. internal/api/http/monster_handlers.go),
// то же самое, что уже делают другие сервисы с этим сентинелом (см.
// internal/domain/errors.go).
func (c *Catalog) Update(ctx context.Context, id string, m *domain.Monster) (bool, error) {
	if strings.HasPrefix(id, systemIDPrefix) {
		return false, domain.ErrForbidden
	}
	m.System = false
	return c.user.Update(ctx, id, m)
}

func (c *Catalog) Delete(ctx context.Context, id string) error {
	if strings.HasPrefix(id, systemIDPrefix) {
		return domain.ErrForbidden
	}
	return c.user.Delete(ctx, id)
}
