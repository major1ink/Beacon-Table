package domain

import "time"

// Spell — карточка библиотеки заклинаний, общей на весь стол (её видят и
// правят и ДМ, и игроки — в отличие от Monster, у которого бестиарий
// инструмент только ДМ). Хранится файлом на диске, один JSON на заклинание
// (см. internal/repository/spellfile).
//
// Ядро знает у заклинания только общее: название, источник, описание, теги и
// состояния, которые оно накладывает. Остальное (круг, школа, компоненты,
// урон…) описывает схема игровой системы из модуля и лежит в Extra под теми
// же ключами JSON: ядро хранит эти значения как есть и не проверяет.
type Spell struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// System — true для карточек каталога "из коробки" из модулей
	// (см. internal/repository/spellfile.SystemStore) —
	// проставляется сервером при чтении, клиентское значение в Create/Update
	// игнорируется (см. spellfile.Catalog). Такие карточки нельзя
	// редактировать/удалять — только клонировать в общую библиотеку (см.
	// web/src/pages/spellbook.js).
	System bool `json:"system,omitempty"`
	// Module — id модуля, из которого пришла карточка (см. internal/module);
	// проставляется сервером при чтении, как и System. Пусто у карточек
	// библиотеки мира.
	Module          string `json:"module,omitempty"`
	Source          string `json:"source,omitempty"` // "PHB'24", "MHH"...
	FoundryModuleID string `json:"foundryModuleId,omitempty"`

	Description string   `json:"description,omitempty"` // markdown/HTML — рендерится тем же marked, что и заметки ДМ (см. web/src/notes/markdown.js); из импорта приходит готовый HTML, marked пропускает его как есть
	Tags        []string `json:"tags,omitempty"`

	// Statuses — какие состояния это заклинание накладывает (см.
	// domain.Condition). Заполняется в основном импортом: в экспорте Foundry
	// у заклинания лежит массив effects[] с ActiveEffect-документами, у
	// которых есть statuses: ["restrained"] и duration.rounds — разбор, как
	// и всё остальное, целиком на клиенте (web/src/spell-import.js), сервер
	// про формат Foundry по-прежнему ничего не знает. Правится и руками в
	// карточке заклинания.
	//
	// Само НАЛОЖЕНИЕ не автоматическое: сервер спасброски не кидает и цели
	// заклинания не знает (это ровно то, за чем в Foundry идут в MidiQOL) —
	// список тут превращается в кликабельные чипы «Накладывает: …» в
	// карточке, и ДМ вешает метку на выделенные токены одним кликом (см.
	// web/src/status-palette.js).
	Statuses []SpellStatusRef `json:"statuses,omitempty"`

	UpdatedAt time.Time `json:"updatedAt"`

	// Extra — ключи JSON, которых эта структура не знает (поля схемы
	// игровой системы и т.п.): хранятся и отдаются как есть, см. domain.Extra.
	Extra Extra `json:"-"`
}

// SpellStatusRef — одна строка списка «Накладывает» карточки заклинания.
// Slug — ссылка на Condition.Slug, Name — снимок имени на момент импорта/
// добавления (тот же приём, что у MonsterSpellRef: осиротевшая ссылка не
// оставляет строку безымянной).
type SpellStatusRef struct {
	Slug   string `json:"slug"`
	Name   string `json:"name"`
	Rounds int    `json:"rounds,omitempty"` // 0 — бессрочно/по описанию
	Note   string `json:"note,omitempty"`   // «при провале спасброска Ловкости»
}

// NewSpell создаёт пустую карточку заклинания с разумными дефолтами — как и
// NewMonster/DefaultCharacterSheet, готова сразу отдаваться на редактирование
// (или на импорт поверх себя, см. web/src/spell-import.js).
func NewSpell(id, name string) *Spell {
	return &Spell{ID: id, Name: name}
}
