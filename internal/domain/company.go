package domain

import "time"

// SystemCustom — «Своя система (без правил)»: единственная игровая система,
// встроенная в ядро. Все остальные приходят системными модулями (см.
// internal/module, Manifest.Type == "system"), и id системы мира — это id
// такого модуля. Ядро не знает ни одной игровой системы.
const SystemCustom = "custom"

// BaseModuleID — встроенный модуль «Базовые состояния» (см.
// internal/module/base): его получает мир «Своей системы».
const BaseModuleID = "base"

// SystemDnD5e2014/SystemDnD5e2024 — id модулей D&D. В ядре нужны только
// миграции старых установок (до миров всё было на D&D 2024, см.
// app.CompanyManager.Bootstrap) и тестам; уйдут вместе с выносом D&D из
// бинарника.
const (
	SystemDnD5e2014 = "dnd5e-2014"
	SystemDnD5e2024 = "dnd5e-2024"
)

// Company — один "мир"/стол: изолированный набор сцен, бестиария,
// заклинаний, предметов, заметок, плейлистов и персонажей игроков,
// привязанных к нему (Account.CompanyID). На сервере в любой момент
// запущена (см. service.CompanyManager) не более одной компании — это не
// параллельные тенанты, а Foundry-подобное переключение "какой мир сейчас
// на столе".
type Company struct {
	ID     string
	Name   string
	System string // SystemDnD5e2014 | SystemDnD5e2024
	// Modules — id модулей контента, подключённых к миру (см.
	// internal/module), в порядке подключения: при совпадении id карточек
	// побеждает подключённый раньше. nil — мир создан до модулей, см.
	// EnabledModules.
	Modules   []string
	CreatedAt time.Time
}

// EnabledModules — модули, чьи карточки видны в мире. У миров, созданных до
// модулей, список пуст, и тогда подключён модуль их системы — ровно тот
// каталог «из коробки», который они видели раньше.
func (c *Company) EnabledModules() []string {
	if c.Modules != nil {
		return c.Modules
	}
	switch c.System {
	case "":
		return nil
	case SystemCustom:
		return []string{BaseModuleID}
	}
	return []string{c.System}
}
