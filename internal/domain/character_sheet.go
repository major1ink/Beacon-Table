package domain

// CharacterSheet — лист персонажа. Хранится как единый JSON в колонке
// characters.sheet_json (см. internal/repository/sqlite/characters.go):
// лист всегда читается и пишется целиком одним игроком, между полями нет
// реляционных запросов.
//
// Ядро знает у листа только общее: хиты, защиту и скорость (Combat), деньги,
// ресурсы, заметки, умения и универсальные поля «Своей системы» (инициатива,
// свободные характеристики, броски). Остальное (характеристики, навыки,
// заклинания, снаряжение…) описывает схема игровой системы из модуля и лежит
// в Extra под теми же ключами JSON: ядро хранит эти значения как есть и не
// проверяет. Производные числа (модификаторы, бонусы) считает клиент по
// формулам схемы, сервер их не пересчитывает.
type CharacterSheet struct {
	Combat CombatStats `json:"combat"`

	Features string    `json:"features"` // "Умения и способности"
	Notes    [6]string `json:"notes"`    // 6 блоков "Заметки"
	Coins    Coins     `json:"coins"`

	// Resources — таблица «Ресурсы»: очки, заряды и прочее с максимумом и
	// условием восстановления.
	Resources []ResourceRow `json:"resources"`

	// Initiative — формула броска инициативы или число: «1d20+2», «2d6»,
	// «3». Её бросает трекер по правилам системы (CombatRules, rollField
	// "initiative"); пусто — ДМ вписывает инициативу вручную.
	Initiative string `json:"initiative,omitempty"`
	// Stats — свободные характеристики: название, значение, модификатор.
	// Модификаторы состояний и предметов меняют значение через цель
	// stat.<StatKey(название)>.
	Stats []FreeStat `json:"stats,omitempty"`
	// Rolls — броски из листа: название и формула («Меч», «1d8+3»).
	Rolls []SheetRoll `json:"rolls,omitempty"`

	// Extra — ключи JSON, которых эта структура не знает (поля схемы
	// игровой системы и т.п.): хранятся и отдаются как есть, см. domain.Extra.
	Extra Extra `json:"-"`
}

// CombatStats — то, что трекер боя читает и пишет у персонажа: защита, хиты
// (в том числе временные), скорость. Остальные ключи combat (у D&D — кости
// хитов, спасброски от смерти, истощение) лежат в Extra.
type CombatStats struct {
	AC        int `json:"ac"`
	HPCurrent int `json:"hpCurrent"`
	HPTemp    int `json:"hpTemp"`
	HPMax     int `json:"hpMax"`
	Speed     int `json:"speed"`

	// Extra — ключи combat, которых эта структура не знает: хранятся и
	// отдаются как есть, см. domain.Extra.
	Extra Extra `json:"-"`
}

// ResourceRow — строка таблицы «Ресурсы» (см. CharacterSheet.Resources).
// Current/Max — числа; Recovery — свободный текст («коротк. отдых»,
// «1/день»): условия восстановления слишком разнообразны для чекбокса.
type ResourceRow struct {
	Name     string `json:"name"`
	Current  int    `json:"current"`
	Max      int    `json:"max"`
	Recovery string `json:"recovery"`
}

// FreeStat — свободная характеристика универсального листа. Mod —
// необязательный модификатор (nil — не задан), просто число рядом со
// значением: как он получается, решает игрок или система.
type FreeStat struct {
	Name  string `json:"name"`
	Value int    `json:"value"`
	Mod   *int   `json:"mod,omitempty"`
}

// SheetRoll — бросок из универсального листа: подпись и формула кубов.
type SheetRoll struct {
	Name    string `json:"name"`
	Formula string `json:"formula"`
}

// Coins — деньги листа: ключ валюты → количество. Какие валюты есть,
// задаёт система мира (Currency, раздел currencies в module.json: у D&D —
// cp/sp/ep/gp/pp, у «Своей системы» — одна «money»). Ключи, которых система
// не знает (лист перенесли из мира на другой системе), хранятся как есть —
// лист показывает их отдельно. Старые листы с пятью монетами D&D читаются
// без миграции: это тот же JSON-объект.
type Coins map[string]int

// DefaultCharacterSheet — пустой лист персонажа. Значения нового листа
// (уровень, характеристики…) задаёт схема системы мира (default у поля, см.
// schema.Schema.ApplyDefaults), а не ядро.
func DefaultCharacterSheet() CharacterSheet {
	return CharacterSheet{Coins: Coins{}}
}
