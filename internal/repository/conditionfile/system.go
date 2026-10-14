// system.go — карточки состояний из модулей (SystemStore, только чтение) и
// Catalog, который склеивает их с библиотекой мира (Store) в один
// репозиторий. Сама логика общая для всех пяти видов карточек — см.
// internal/repository/cardcatalog; здесь только то, чем этот вид отличается
// от остальных: тип карточки и порядок в списке.
package conditionfile

import (
	"io/fs"
	"strings"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository/cardcatalog"
)

// systemIDPrefix — префикс id карточек каталога D&D из модулей (как до
// модулей: sys-<имя файла>), см. module.LegacyIDPrefix.
const systemIDPrefix = "sys-"

var kind = cardcatalog.Kind[domain.Condition]{
	SetCatalog: func(c *domain.Condition, id, moduleID string) {
		c.ID, c.System, c.Module = id, true, moduleID
	},
	SetLibrary: func(c *domain.Condition) {
		c.System, c.Module = false, ""
	},
	Less: func(a, b *domain.Condition) bool {
		return strings.ToLower(a.Name) < strings.ToLower(b.Name)
	},
	Unique: uniqueSlugs,
}

// uniqueSlugs — slug ключ метки на токене и ссылки из заклинания, поэтому
// карточка на slug одна: своя из библиотеки мира, иначе модуля (первого по
// порядку подключения), базовые состояния — последними. Без этого базовый
// модуль, включённый рядом с системой, давал пары «Испуг» / «Испуган».
func uniqueSlugs(list []*domain.Condition) []*domain.Condition {
	rank := func(c *domain.Condition) int {
		switch {
		case !c.System:
			return 0
		case c.Module == domain.BaseModuleID:
			return 2
		}
		return 1
	}
	best := map[string]*domain.Condition{}
	for _, c := range list {
		if b, ok := best[c.Slug]; c.Slug != "" && (!ok || rank(c) < rank(b)) {
			best[c.Slug] = c
		}
	}
	out := make([]*domain.Condition, 0, len(list))
	for _, c := range list {
		if c.Slug == "" || best[c.Slug] == c {
			out = append(out, c)
		}
	}
	return out
}

// SystemStore — карточки одного модуля.
type SystemStore = cardcatalog.Source[domain.Condition]

// Catalog — библиотека мира плюс карточки подключённых модулей.
type Catalog = cardcatalog.Catalog[domain.Condition]

// NewSystemStore — каталог D&D 0.8.x: id вида sys-<имя файла>.
func NewSystemStore(fsys fs.FS, dir string) *SystemStore {
	return NewModuleStore(fsys, dir, systemIDPrefix, "")
}

// NewModuleStore — карточки модуля moduleID в папке dir; prefix — см.
// module.Manifest.IDPrefix.
func NewModuleStore(fsys fs.FS, dir, prefix, moduleID string) *SystemStore {
	return cardcatalog.NewSource(fsys, dir, prefix, moduleID, kind)
}

// NewCatalog — sources в порядке подключения модулей к миру.
func NewCatalog(user *Store, sources ...*SystemStore) *Catalog {
	return cardcatalog.New[domain.Condition](user, kind, sources...)
}
