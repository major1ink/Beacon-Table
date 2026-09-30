package domain

import "time"

// Monster — карточка бестиария ДМ: существо или NPC для быстрой справки и
// вывода на сцену. Хранится файлом на диске, один JSON на существо (см.
// internal/repository/monsterfile).
//
// Ядро знает у существа только общее: КД, хиты, скорость, описание, теги,
// заклинания и добычу. Статблок системы (характеристики, опасность, блоки
// способностей…) описывает схема игровой системы из модуля и лежит в Extra
// под теми же ключами JSON: ядро хранит эти значения как есть и не
// проверяет. Текстовые блоки — markdown (рендерятся тем же `marked`, что и
// заметки ДМ, см. web/src/notes/markdown.js).
type Monster struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// System — true для карточек каталога "из коробки", зашитого в бинарник
	// на этапе компиляции (см. internal/repository/monsterfile.SystemStore) —
	// в отличие от остального Monster, это не то, что ввёл ДМ, а то, что
	// проставляет сервер при чтении (см. monsterfile.Catalog); значение,
	// присланное клиентом в Create/Update, всегда игнорируется. Такие
	// карточки нельзя редактировать/удалять (см. monsterfile.Catalog.Update/
	// Delete — domain.ErrForbidden) — только клонировать в пользовательскую
	// библиотеку (см. web/src/pages/bestiary.js).
	System bool `json:"system,omitempty"`
	// Module — id модуля, из которого пришла карточка (см. internal/module);
	// проставляется сервером при чтении, как и System. Пусто у карточек
	// библиотеки мира.
	Module          string `json:"module,omitempty"`
	FoundryModuleID string `json:"foundryModuleId,omitempty"`
	// FoundryActorID — id актёра Foundry, из документа которого собрана эта
	// карточка. Нужен ровно для одного: связать её с токенами, уже
	// стоящими на импортированных сценах того же модуля — см.
	// domain.Token.FoundryActorID, там же и о том, почему связывание
	// отложенное. Проставляется клиентским импортёром ПОСЛЕ сравнения
	// "не изменилась ли карточка" (web/src/pages/foundry-import.js), той же
	// причине, что и FoundryModuleID выше: служебная метка не должна сама
	// превращать совпадающую карточку в конфликт.
	FoundryActorID string `json:"foundryActorId,omitempty"`
	ImageURL       string `json:"imageUrl,omitempty"` // токен-арт — та же /uploads/tokens категория, что у аватаров персонажей

	AC    int    `json:"ac"`
	HP    int    `json:"hp"`
	Speed string `json:"speed,omitempty"` // "30 фт., полёт 60 фт. (парит)"

	Description string `json:"description,omitempty"` // лор/фон — не влияет на игромеханику

	Tags []string `json:"tags,omitempty"` // произвольные метки (биом/источник/кампания) — фильтр в панели бестиария
	// Summonable — игрок может попросить призвать это существо на карту
	// (см. service.Room.handleSummonRequest): фамильяры, звери для
	// «Призыва животных». Флаг — точечный доступ, когда весь бестиарий
	// открывать не хочется (спойлеры модуля); общий тумблер стола
	// CombatState.SummonAll открывает всё разом. Для карточек «из коробки»
	// флаг не хранится (они не редактируются) — только тумблер.
	Summonable bool `json:"summonable,omitempty"`

	// Spells — список заклинаний монстра (см. врождённое/подготовленное
	// колдовство статблоков), ссылки на карточки общей библиотеки заклинаний
	// (domain.Spell, см. spell.go) — добавляются из панели "Заклинания" ДМ,
	// не отсюда (см. web/src/pages/dm.js). Имя/уровень дублируются на момент
	// добавления, чтобы список не осиротел, если исходную карточку из
	// библиотеки потом удалят.
	Spells []MonsterSpellRef `json:"spells,omitempty"`

	// Inventory — шаблон добычи этого монстра (см. domain.InventoryEntry) —
	// список предметов каталога, которые есть при себе у монстра. Правится
	// целиком в редакторе бестиария (web/src/pages/bestiary.js), как и
	// остальные поля статблока. Когда экземпляр этого монстра умирает в бою,
	// содержимое КОПИРУЕТСЯ (не ссылкой) в Token.Loot убитого токена (см.
	// service.Room.killCombatant) — лутание одного трупа не трогает
	// "склад" шаблона и других уже стоящих на карте токенов того же монстра.
	Inventory []InventoryEntry `json:"inventory,omitempty"`

	UpdatedAt time.Time `json:"updatedAt"`

	// Extra — ключи JSON, которых эта структура не знает (поля схемы
	// игровой системы и т.п.): хранятся и отдаются как есть, см. domain.Extra.
	Extra Extra `json:"-"`
}

// MonsterSpellRef — одна строка списка "Заклинания" статблока монстра.
type MonsterSpellRef struct {
	SpellID string `json:"spellId,omitempty"` // id в библиотеке заклинаний, "" если ссылка осиротела/введена вручную
	Name    string `json:"name"`
	Level   int    `json:"level"`
}

// NewMonster создаёт пустую карточку существа. Значения новой карточки
// (размер, КД, характеристики…) задаёт схема системы мира (default у поля,
// см. schema.Schema.ApplyDefaults), а не ядро.
func NewMonster(id, name string) *Monster {
	return &Monster{ID: id, Name: name}
}
