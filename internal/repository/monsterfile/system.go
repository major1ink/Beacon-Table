// system.go — карточки существ из модулей (SystemStore, только чтение) и
// Catalog, который склеивает их с библиотекой мира (Store) в один
// репозиторий. Сама логика общая для всех пяти видов карточек — см.
// internal/repository/cardcatalog; здесь только то, чем этот вид отличается
// от остальных: тип карточки и порядок в списке.
package monsterfile

import (
	"io/fs"
	"strings"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository/cardcatalog"
)

// systemIDPrefix — префикс id карточек встроенного каталога D&D (как до
// модулей: sys-<имя файла>), см. module.LegacyIDPrefix.
const systemIDPrefix = "sys-"

var kind = cardcatalog.Kind[domain.Monster]{
	SetCatalog: func(c *domain.Monster, id, moduleID string) {
		c.ID, c.System, c.Module = id, true, moduleID
	},
	SetLibrary: func(c *domain.Monster) {
		c.System, c.Module = false, ""
	},
	Less: func(a, b *domain.Monster) bool {
		return strings.ToLower(a.Name) < strings.ToLower(b.Name)
	},
}

// SystemStore — карточки одного модуля.
type SystemStore = cardcatalog.Source[domain.Monster]

// Catalog — библиотека мира плюс карточки подключённых модулей.
type Catalog = cardcatalog.Catalog[domain.Monster]

// NewSystemStore — встроенный каталог D&D: id вида sys-<имя файла>.
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
	return cardcatalog.New[domain.Monster](user, kind, sources...)
}
