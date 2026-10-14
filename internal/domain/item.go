package domain

import "time"

// Item — карточка библиотеки предметов, общей на весь стол (та же видимость,
// что и у Spell, см. spell.go: и ДМ, и игроки создают/импортируют/правят
// карточки одной общей библиотеки — в отличие от Monster, у которого
// бестиарий инструмент только ДМ). Хранится файлом на диске, один JSON на
// предмет (см. internal/repository/itemfile).
//
// Ядро знает у предмета только общее: название, картинку, источник, вид,
// вес для инвентаря, числа при ношении (Modifiers), описание и теги.
// Остальное (редкость, настройка, стоимость, урон, свойства, заряды…)
// описывает схема игровой системы из модуля и лежит в Extra под теми же
// ключами JSON: ядро хранит эти значения как есть и не проверяет.
type Item struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// System — true для карточек каталога "из коробки" из модулей
	// (см. internal/repository/itemfile.SystemStore) —
	// проставляется сервером при чтении, клиентское значение в Create/Update
	// игнорируется (см. itemfile.Catalog). Такие карточки нельзя
	// редактировать/удалять — только клонировать в общую библиотеку (см.
	// web/src/pages/itembook.js).
	System bool `json:"system,omitempty"`
	// Module — id модуля, из которого пришла карточка (см. internal/module);
	// проставляется сервером при чтении, как и System. Пусто у карточек
	// библиотеки мира.
	Module          string `json:"module,omitempty"`
	ImageURL        string `json:"imageUrl,omitempty"` // иконка предмета
	Source          string `json:"source,omitempty"`   // "DMG", "XGE"...
	FoundryModuleID string `json:"foundryModuleId,omitempty"`

	Type string `json:"type,omitempty"` // "Оружие (длинный меч)", "Чудесный предмет"... — свободный текст

	// WeightValue — вес числом для расчёта суммарного веса инвентаря (см.
	// domain.InventoryEntry); текстовый вес для показа («1 фунт») — поле
	// схемы системы в Extra. Число — в единицах системы мира (SystemUnits.Weight: «фнт» у D&D, «кг»
	// у «Своей системы»), без пересчёта. JSON-ключ "weightLb" — историческое
	// имя формата (когда вес был только в фунтах D&D); его не переименовываем,
	// чтобы не мигрировать базы, файлы миров, архивы и каталоги модулей.
	WeightValue float64 `json:"weightLb,omitempty"`

	// Modifiers — что предмет даёт в числах, ПОКА НАДЕТ (см. domain.Modifier
	// и InventoryEntry.Equipped): «КД 14» у кольчуги, «+2 к КД» у щита,
	// «+2 к Силе» у пояса великанов. Применяет их лист персонажа (см.
	// web/src/pages/character-sheet.js) — он и так считает производные числа
	// по формулам системы, это ещё одно слагаемое в том же расчёте.
	Modifiers []Modifier `json:"modifiers,omitempty"`

	Description string   `json:"description,omitempty"` // markdown/HTML — рендерится тем же marked, что и заметки ДМ (см. web/src/notes/markdown.js)
	Tags        []string `json:"tags,omitempty"`

	UpdatedAt time.Time `json:"updatedAt"`

	// Extra — ключи JSON, которых эта структура не знает (поля схемы
	// игровой системы и т.п.): хранятся и отдаются как есть, см. domain.Extra.
	Extra Extra `json:"-"`
}

// NewItem создаёт пустую карточку предмета с разумными дефолтами — как и
// NewSpell/NewMonster, готова сразу отдаваться на редактирование (или на
// импорт поверх себя, см. web/src/item-import.js).
func NewItem(id, name string) *Item {
	return &Item{ID: id, Name: name}
}
