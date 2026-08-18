package domain

import "time"

// Система правил, по которой ведётся мир (World.System) — только это
// значение отличает форму листа персонажа и то, какая подпапка
// systemdata/{bestiary,spells,items}/<system> подключается как каталог "из
// коробки" (см. internal/repository/monsterfile/spellfile/itemfile: system.go
// и internal/service/company.go: Launch). Новые системы добавляются сюда
// плюс в web/src/pages/worlds.js (выпадающий список) — больше нигде
// специального ветвления по системе в коде нет, всё остальное — общие для
// D&D 5e поля "умного бланка" (см. character_sheet.go).
const (
	SystemDnD5e2014 = "dnd5e-2014"
	SystemDnD5e2024 = "dnd5e-2024"
)

// ValidSystem — есть ли такая система в списке поддерживаемых (используется
// при создании компании, см. service.CompanyManager.Create).
func ValidSystem(system string) bool {
	return system == SystemDnD5e2014 || system == SystemDnD5e2024
}

// Company — один "мир"/стол: изолированный набор сцен, бестиария,
// заклинаний, предметов, заметок, плейлистов и персонажей игроков,
// привязанных к нему (Account.CompanyID). На сервере в любой момент
// запущена (см. service.CompanyManager) не более одной компании — это не
// параллельные тенанты, а Foundry-подобное переключение "какой мир сейчас
// на столе".
type Company struct {
	ID        string
	Name      string
	System    string // SystemDnD5e2014 | SystemDnD5e2024
	CreatedAt time.Time
}
