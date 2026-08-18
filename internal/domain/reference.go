package domain

import "time"

// Reference — карточка справочника: класс/архетип/происхождение/вид/черта и
// т.п. Один каталог на ВСЕ виды записи (см. Kind), а не отдельная сущность
// на каждый — та же логика, что у Item.Type/Monster.Type: свободный текст,
// не enum, сервер не обязан заранее знать, какие виды записей заведёт ДМ.
// Хранится файлом на диске, один JSON на запись (см.
// internal/repository/referencefile) — та же идея, что у Monster/Spell/Item,
// с тем же делением на каталог "из коробки" (System) и общую пользовательскую
// библиотеку (и ДМ, и игроки создают/импортируют/правят, см.
// web/src/pages/referencebook.js — та же видимость, что у Item/Spell).
//
// Тот же "умный бланк", что и у Item/Monster: сервер не знает правил D&D —
// не проверяет, какие черты доступны какому классу, не считает прогрессию
// по уровням. Description — единственное содержательное поле большинства
// записей (полный текст класса/архетипа/черты), остальное — минимальная
// структура для навигации/фильтрации (Kind, ParentName).
type Reference struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// System — true для карточек каталога "из коробки", зашитого в бинарник
	// на этапе компиляции (см. internal/repository/referencefile.SystemStore) —
	// проставляется сервером при чтении, клиентское значение в Create/Update
	// игнорируется (см. referencefile.Catalog). Такие карточки нельзя
	// редактировать/удалять — только клонировать в общую библиотеку.
	System   bool   `json:"system,omitempty"`
	ImageURL string `json:"imageUrl,omitempty"`
	Source   string `json:"source,omitempty"` // "PHB 2024", "DMG 2024"...

	// Kind — "класс" | "архетип" | "происхождение" | "вид" | "черта класса" |
	// ... свободный текст. Используется и для фильтра-чипов в UI справочника
	// (web/src/pages/dm.js), и чтобы подтянуть нужные подсказки в нужное поле
	// листа персонажа (web/src/pages/character-sheet.js: "Класс" читает
	// Kind=="класс", "Вид" — Kind=="вид" и т.д.) — сервер сам смысл Kind не
	// знает, просто хранит и отдаёт как есть.
	Kind string `json:"kind,omitempty"`
	// ParentName — для архетипа: ИМЯ класса-родителя (не ID — тот же приём
	// снапшота, что у MonsterSpellRef/InventoryEntry: переименование или
	// удаление исходной карточки класса не оставляет архетип с битой
	// ссылкой). Пусто у видов записи, для которых родитель не имеет смысла.
	ParentName string `json:"parentName,omitempty"`

	Description string   `json:"description,omitempty"` // markdown/HTML, рендерится тем же marked, что и остальные карточки
	Tags        []string `json:"tags,omitempty"`

	UpdatedAt time.Time `json:"updatedAt"`
}

// NewReference создаёт пустую карточку справочника с разумными дефолтами —
// как и NewItem/NewMonster/NewSpell, готова сразу отдаваться на редактирование.
func NewReference(id, name string) *Reference {
	return &Reference{ID: id, Name: name}
}
