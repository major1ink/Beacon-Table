package app

import (
	"regexp"

	"beacon-table/internal/domain"
	"beacon-table/internal/module"
)

// SystemInfo — игровая система, на которой можно создать мир.
type SystemInfo struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	// Builtin — «Своя система», встроенная в ядро; остальные — системные
	// модули на сервере.
	Builtin bool `json:"builtin,omitempty"`
}

// Systems — «Своя система» и все системные модули, установленные на сервере.
func (m *CompanyManager) Systems() []SystemInfo {
	out := []SystemInfo{{ID: domain.SystemCustom, Title: "Своя система (без правил)", Builtin: true}}
	mods, _ := m.modules.List()
	for _, mod := range mods {
		if mod.Manifest.Type == module.TypeSystem {
			out = append(out, SystemInfo{ID: mod.Manifest.ID, Title: mod.Manifest.Title})
		}
	}
	return out
}

// systemInstalled — можно ли создать мир на этой системе прямо сейчас.
func (m *CompanyManager) systemInstalled(id string) bool {
	if id == domain.SystemCustom {
		return true
	}
	mod, err := m.modules.Get(id)
	return err == nil && mod.Manifest.Type == module.TypeSystem
}

// validSystemID — id системы из архива мира: «custom» или id модуля. Сама
// система может быть не установлена — мир всё равно импортируется (см.
// ImportWorld), а модуль предложит поставить интерфейс.
var validSystemID = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

// defaultModules — модули нового мира: у «Своей системы» — базовые
// состояния, у мира на системном модуле — сам этот модуль (базовые
// состояния туда не подмешиваются: у системы свои, с теми же slug'ами).
func defaultModules(system string) []string {
	if system == domain.SystemCustom {
		return []string{domain.BaseModuleID}
	}
	return []string{system}
}
