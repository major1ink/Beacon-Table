package domain

import "time"

// Reference — карточка справочника: запись для чтения и подсказок (у D&D —
// класс, архетип, происхождение, вид, черта). Один каталог на ВСЕ виды
// записи, а не отдельная сущность на каждый. Хранится файлом на диске, один
// JSON на запись (см. internal/repository/referencefile), с тем же делением
// на каталог модуля (System) и общую пользовательскую библиотеку (и ДМ, и
// игроки создают/импортируют/правят, см. web/src/pages/referencebook.js).
//
// Ядро знает у записи только общее: название, картинку, источник, описание
// и теги. Вид записи, родитель и прочее описывает схема игровой системы из
// модуля и лежит в Extra под теми же ключами JSON: ядро хранит эти значения
// как есть и не проверяет.
type Reference struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// System — true для карточек каталога "из коробки", зашитого в бинарник
	// на этапе компиляции (см. internal/repository/referencefile.SystemStore) —
	// проставляется сервером при чтении, клиентское значение в Create/Update
	// игнорируется (см. referencefile.Catalog). Такие карточки нельзя
	// редактировать/удалять — только клонировать в общую библиотеку.
	System bool `json:"system,omitempty"`
	// Module — id модуля, из которого пришла карточка (см. internal/module);
	// проставляется сервером при чтении, как и System. Пусто у карточек
	// библиотеки мира.
	Module          string `json:"module,omitempty"`
	ImageURL        string `json:"imageUrl,omitempty"`
	Source          string `json:"source,omitempty"` // "PHB 2024", "DMG 2024"...
	FoundryModuleID string `json:"foundryModuleId,omitempty"`

	Description string   `json:"description,omitempty"` // markdown/HTML, рендерится тем же marked, что и остальные карточки
	Tags        []string `json:"tags,omitempty"`

	UpdatedAt time.Time `json:"updatedAt"`

	// Extra — ключи JSON, которых эта структура не знает (поля схемы
	// игровой системы и т.п.): хранятся и отдаются как есть, см. domain.Extra.
	Extra Extra `json:"-"`
}

// NewReference создаёт пустую карточку справочника с разумными дефолтами —
// как и NewItem/NewMonster/NewSpell, готова сразу отдаваться на редактирование.
func NewReference(id, name string) *Reference {
	return &Reference{ID: id, Name: name}
}
