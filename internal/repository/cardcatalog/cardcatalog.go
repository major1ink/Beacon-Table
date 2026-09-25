// Package cardcatalog — общая половина пяти файловых библиотек карточек
// (monsterfile, spellfile, itemfile, referencefile, conditionfile):
// карточки модулей (Source, только чтение) и Catalog, который склеивает их с
// библиотекой мира в один репозиторий. Раньше каждая библиотека держала
// свою копию этого кода с единственным встроенным каталогом D&D; с модулями
// источников стало N, и логика «какой источник по id» живёт здесь одна.
//
// Карточки модуля не редактируются и не удаляются: хочет ДМ поправить —
// клонирует карточку в библиотеку мира и правит копию.
package cardcatalog

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"path"
	"regexp"
	"sort"
	"strings"

	"beacon-table/internal/domain"
)

// unsafeIDChars — тот же санитайзер, что у файловых библиотек: id карточки
// приходит из URL, доверять ему как куску пути нельзя.
var unsafeIDChars = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// Kind — то, чем пять видов карточек отличаются для каталога.
type Kind[T any] struct {
	// SetCatalog — пометить карточку как карточку модуля: id из имени
	// файла, признак «только чтение», id модуля (пусто у встроенного D&D).
	SetCatalog func(card *T, id, moduleID string)
	// SetLibrary — снять эти пометки с карточки библиотеки мира (на случай,
	// если файл на диске поправили руками мимо приложения).
	SetLibrary func(card *T)
	// Less — порядок выдачи списка.
	Less func(a, b *T) bool
}

// Source — карточки одного вида из одного модуля: папка dir в fsys, по
// файлу на карточку. id карточки = prefix + имя файла без .json: у
// встроенного каталога D&D prefix "sys-" (как до модулей), у остальных
// "<id модуля>--".
type Source[T any] struct {
	fsys     fs.FS
	dir      string
	prefix   string
	moduleID string
	kind     Kind[T]
}

// NewSource — dir без хвостового "/", относительно корня fsys.
func NewSource[T any](fsys fs.FS, dir, prefix, moduleID string, kind Kind[T]) *Source[T] {
	return &Source[T]{fsys: fsys, dir: dir, prefix: prefix, moduleID: moduleID, kind: kind}
}

// Owns — принадлежит ли id этому источнику.
func (s *Source[T]) Owns(id string) bool { return strings.HasPrefix(id, s.prefix) }

func (s *Source[T]) idFromFilename(name string) string {
	return s.prefix + unsafeIDChars.ReplaceAllString(strings.TrimSuffix(name, ".json"), "_")
}

func (s *Source[T]) filename(id string) string {
	safe := unsafeIDChars.ReplaceAllString(strings.TrimPrefix(id, s.prefix), "_")
	if safe == "" || safe == "." || safe == ".." {
		safe = "card"
	}
	return safe + ".json"
}

// List — все карточки источника. Битый файл пропускается: одна сломанная
// карточка не должна прятать остальные.
func (s *Source[T]) List(_ context.Context) ([]*T, error) {
	entries, err := fs.ReadDir(s.fsys, s.dir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []*T{}, nil
		}
		return nil, err
	}
	out := make([]*T, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := fs.ReadFile(s.fsys, path.Join(s.dir, e.Name()))
		if err != nil {
			continue
		}
		var card T
		if err := json.Unmarshal(data, &card); err != nil {
			continue
		}
		s.kind.SetCatalog(&card, s.idFromFilename(e.Name()), s.moduleID)
		out = append(out, &card)
	}
	sort.SliceStable(out, func(i, j int) bool { return s.kind.Less(out[i], out[j]) })
	return out, nil
}

// Get — карточка по id или domain.ErrNotFound.
func (s *Source[T]) Get(_ context.Context, id string) (*T, error) {
	data, err := fs.ReadFile(s.fsys, path.Join(s.dir, s.filename(id)))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, domain.ErrNotFound
		}
		return nil, err
	}
	var card T
	if err := json.Unmarshal(data, &card); err != nil {
		return nil, err
	}
	s.kind.SetCatalog(&card, id, s.moduleID)
	return &card, nil
}

// Library — библиотека мира: файлы на диске, редактируемые.
type Library[T any] interface {
	List(ctx context.Context) ([]*T, error)
	Get(ctx context.Context, id string) (*T, error)
	Create(ctx context.Context, id string, card *T) error
	Update(ctx context.Context, id string, card *T) (bool, error)
	Delete(ctx context.Context, id string) error
}

// Catalog — библиотека мира плюс карточки подключённых модулей, одним
// репозиторием: сервисы не знают, откуда карточка. List отдаёт всё вместе,
// Get/Update/Delete идут в источник по префиксу id, Create всегда пишет в
// библиотеку мира.
//
// Если два источника претендуют на один id (два модуля с legacyIds —
// D&D 2014 и 2024 в одном мире), побеждает подключённый раньше.
type Catalog[T any] struct {
	user     Library[T]
	sources  []*Source[T]
	kind     Kind[T]
	localize Localizer
}

// Localizer переписывает в JSON карточки ссылки, которые не должны жить в
// библиотеке мира, — картинки модулей (/module-assets/…): модуль могут
// выключить или удалить, а клон его карточки должен остаться с картинкой.
// Возвращает data как есть, если переписывать нечего.
type Localizer interface {
	LocalizeJSON(ctx context.Context, data []byte) ([]byte, error)
}

// WithLocalizer — перед записью в библиотеку мира карточка проходит через l.
func (c *Catalog[T]) WithLocalizer(l Localizer) *Catalog[T] {
	c.localize = l
	return c
}

func (c *Catalog[T]) localizeCard(ctx context.Context, card *T) error {
	if c.localize == nil {
		return nil
	}
	data, err := json.Marshal(card)
	if err != nil {
		return err
	}
	out, err := c.localize.LocalizeJSON(ctx, data)
	if err != nil || bytes.Equal(out, data) {
		return err
	}
	var fixed T
	if err := json.Unmarshal(out, &fixed); err != nil {
		return err
	}
	*card = fixed
	return nil
}

// New — sources в порядке подключения модулей.
func New[T any](user Library[T], kind Kind[T], sources ...*Source[T]) *Catalog[T] {
	return &Catalog[T]{user: user, sources: sources, kind: kind}
}

func (c *Catalog[T]) source(id string) *Source[T] {
	for _, s := range c.sources {
		if s.Owns(id) {
			return s
		}
	}
	return nil
}

// fromModule — id похож на id карточки модуля, даже если такого модуля в
// мире сейчас нет: править и удалять такое нельзя, это не библиотека мира.
func (c *Catalog[T]) fromModule(id string) bool {
	return c.source(id) != nil || strings.HasPrefix(id, "sys-") || strings.Contains(id, "--")
}

func (c *Catalog[T]) List(ctx context.Context) ([]*T, error) {
	var all []*T
	for _, s := range c.sources {
		list, err := s.List(ctx)
		if err != nil {
			return nil, err
		}
		all = append(all, list...)
	}
	userList, err := c.user.List(ctx)
	if err != nil {
		return nil, err
	}
	for _, card := range userList {
		c.kind.SetLibrary(card)
	}
	all = append(all, userList...)
	sort.SliceStable(all, func(i, j int) bool { return c.kind.Less(all[i], all[j]) })
	return all, nil
}

func (c *Catalog[T]) Get(ctx context.Context, id string) (*T, error) {
	if s := c.source(id); s != nil {
		return s.Get(ctx, id)
	}
	if c.fromModule(id) {
		// Модуль выключен или удалён: карточки нет, но это не повод искать
		// её в библиотеке мира под тем же id.
		return nil, domain.ErrNotFound
	}
	card, err := c.user.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	c.kind.SetLibrary(card)
	return card, nil
}

func (c *Catalog[T]) Create(ctx context.Context, id string, card *T) error {
	c.kind.SetLibrary(card)
	if err := c.localizeCard(ctx, card); err != nil {
		return err
	}
	return c.user.Create(ctx, id, card)
}

// Update возвращает domain.ErrForbidden для карточек модулей — api-слой
// отвечает на это 403.
func (c *Catalog[T]) Update(ctx context.Context, id string, card *T) (bool, error) {
	if c.fromModule(id) {
		return false, domain.ErrForbidden
	}
	c.kind.SetLibrary(card)
	if err := c.localizeCard(ctx, card); err != nil {
		return false, err
	}
	return c.user.Update(ctx, id, card)
}

func (c *Catalog[T]) Delete(ctx context.Context, id string) error {
	if c.fromModule(id) {
		return domain.ErrForbidden
	}
	return c.user.Delete(ctx, id)
}
