// system.go — карточки заклинаний из модулей (SystemStore, только чтение) и
// Catalog, который склеивает их с библиотекой мира (Store) в один
// репозиторий. Сама логика общая для всех пяти видов карточек — см.
// internal/repository/cardcatalog; здесь только то, чем этот вид отличается
// от остальных: тип карточки и порядок в списке.
package spellfile

import (
	"io/fs"
	"strings"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository/cardcatalog"
)

// systemIDPrefix — префикс id карточек встроенного каталога D&D (как до
// модулей: sys-<имя файла>), см. module.LegacyIDPrefix.
const systemIDPrefix = "sys-"

var kind = cardcatalog.Kind[domain.Spell]{
	SetCatalog: func(c *domain.Spell, id, moduleID string) {
		c.ID, c.System, c.Module = id, true, moduleID
	},
	SetLibrary: func(c *domain.Spell) {
		c.System, c.Module = false, ""
	},
	Less: func(a, b *domain.Spell) bool {
		if a.Level != b.Level {
			return a.Level < b.Level
		}
		return strings.ToLower(a.Name) < strings.ToLower(b.Name)
	},
}

// SystemStore — карточки одного модуля.
type SystemStore = cardcatalog.Source[domain.Spell]

// Catalog — библиотека мира плюс карточки подключённых модулей.
type Catalog = cardcatalog.Catalog[domain.Spell]

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
	return cardcatalog.New[domain.Spell](user, kind, sources...)
}
