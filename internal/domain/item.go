package domain

import "time"

// Item — карточка библиотеки предметов, общей на весь стол (та же видимость,
// что и у Spell, см. spell.go: и ДМ, и игроки создают/импортируют/правят
// карточки одной общей библиотеки — в отличие от Monster, у которого
// бестиарий инструмент только ДМ). Хранится файлом на диске, один JSON на
// предмет (см. internal/repository/itemfile) — та же идея, что и у
// Monster/Spell/Note.
//
// Тот же "умный бланк", что и у Monster/Spell (см. соответствующие файлы):
// сервер не знает правил D&D — не считает бонус атаки от свойств оружия, не
// проверяет разрешённые классы для настройки, не парсит формулы урона.
// Предметы даже разнообразнее заклинаний по структуре (оружие/доспех/зелье/
// чудесный предмет/свиток — у каждого свой набор осмысленных характеристик),
// поэтому специфичные для типа поля (Damage/ArmorClass/Charges) — тоже
// свободный текст и просто пустуют у предметов, которым не подходят, а не
// разложены на typed-варианты через какой-то тип предмета.
//
// В отличие от Spell, у 5e14.ttg.club карточки предметов не имеют кнопки
// "Экспортировать в FvTT" — импорт (см. web/src/item-import.js) разбирает
// произвольный экспорт предмета из самого Foundry VTT (dnd5e), а не с сайта.
type Item struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// System — true для карточек каталога "из коробки", зашитого в бинарник
	// на этапе компиляции (см. internal/repository/itemfile.SystemStore) —
	// проставляется сервером при чтении, клиентское значение в Create/Update
	// игнорируется (см. itemfile.Catalog). Такие карточки нельзя
	// редактировать/удалять — только клонировать в общую библиотеку (см.
	// web/src/pages/itembook.js).
	System   bool   `json:"system,omitempty"`
	ImageURL string `json:"imageUrl,omitempty"` // иконка предмета
	Source   string `json:"source,omitempty"`   // "DMG", "XGE"...
	FoundryModuleID string `json:"foundryModuleId,omitempty"`

	Type   string `json:"type,omitempty"`   // "Оружие (длинный меч)", "Доспех (кольчуга)", "Чудесный предмет"... — свободный текст
	Rarity string `json:"rarity,omitempty"` // "обычный", "необычный", "редкий"... — свободный текст

	RequiresAttunement bool   `json:"requiresAttunement"`
	AttunementNote     string `json:"attunementNote,omitempty"` // "колдуном", "существом доброго мировоззрения"...

	Cost   string `json:"cost,omitempty"`   // "50 зм."
	Weight string `json:"weight,omitempty"` // "1 фунт" — свободный текст для отображения в карточке
	// WeightLb — тот же вес, но числом (в фунтах), для расчёта суммарного веса
	// инвентаря (см. domain.InventoryEntry) — сервер их не синхронизирует,
	// оба поля правятся в редакторе предмета независимо, как Weight выше.
	WeightLb   float64 `json:"weightLb,omitempty"`
	Activation string  `json:"activation,omitempty"` // "1 действие", "Особое (см. описание)" — как использовать предмет

	Damage     string `json:"damage,omitempty"`     // "1к8 рубящий" — для оружия, пусто у прочего
	ArmorClass string `json:"armorClass,omitempty"` // "14 + Лов (макс 2)" — для доспехов
	Properties string `json:"properties,omitempty"` // "лёгкое, фехтовальное" и т.п. свойства оружия/доспеха
	Charges    string `json:"charges,omitempty"`    // "3 заряда, восстанавливает 1к3 на рассвете"

	// Modifiers — что предмет даёт в числах, ПОКА НАДЕТ (см. domain.Modifier
	// и InventoryEntry.Equipped): «КД 14» у кольчуги, «+2 к КД» у щита,
	// «+2 к Силе» у пояса великанов. Применяет их лист персонажа (см.
	// web/src/pages/character-sheet.js) — он и так считает производные числа
	// по формулам PHB, это ещё одно слагаемое в том же расчёте.
	//
	// ArmorClass выше при этом остаётся: там текстовая формулировка целиком
	// («14 + Лов (макс 2)»), которую человек читает, а здесь — та её часть,
	// которую приложение умеет посчитать. Заполнять оба поля не обязательно.
	Modifiers []Modifier `json:"modifiers,omitempty"`

	Description string   `json:"description,omitempty"` // markdown/HTML — рендерится тем же marked, что и заметки ДМ (см. web/src/notes/markdown.js)
	Tags        []string `json:"tags,omitempty"`

	UpdatedAt time.Time `json:"updatedAt"`
}

// NewItem создаёт пустую карточку предмета с разумными дефолтами — как и
// NewSpell/NewMonster, готова сразу отдаваться на редактирование (или на
// импорт поверх себя, см. web/src/item-import.js).
func NewItem(id, name string) *Item {
	return &Item{ID: id, Name: name}
}
