package domain

import "time"

// Monster — карточка бестиария ДМ: статблок монстра/NPC для быстрой
// справки и вывода на сцену. Хранится файлом на диске, один JSON на монстра
// (см. internal/repository/monsterfile) — та же идея, что и у Note: реальные
// файлы, легко бэкапятся/переносятся вне приложения.
//
// Как и CharacterSheet (см. character_sheet.go), это "умный бланк": сервер
// не знает никаких правил D&D (что такое КД/опасность/спасброски), не
// пересчитывает и не валидирует их — просто хранит то, что ввёл ДМ.
// Числовые поля (AC/HP/характеристики/бонус мастерства) — то немногое, что
// реально нужно показывать как число (например, для будущей быстрой правки
// текущих HP на токене); всё остальное — свободный текст, отражающий
// разнообразие формулировок настоящих статблоков (сопротивления, чувства,
// языки и т.п. не раскладываются на структуру без потери гибкости).
//
// Текстовые блоки способностей (Traits/Actions/.../Description) — markdown
// (рендерятся тем же `marked`, что и заметки ДМ, см.
// web/src/notes/markdown.js), а не собственный тег-движок с бросками
// костей/ссылками на заклинания, как в DM Helpmate — несоразмерно объёму
// задачи, DM бросает атаки/урон вручную через уже существующий roller (см.
// web/src/dice.js), как и с оружием персонажа (WeaponRow).
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
	FoundryModuleID string `json:"foundryModuleId,omitempty"`
	ImageURL        string `json:"imageUrl,omitempty"` // токен-арт — та же /uploads/tokens категория, что у аватаров персонажей

	Size      string `json:"size,omitempty"`      // "Средний", "Большой"... — свободный текст
	Type      string `json:"type,omitempty"`      // "гуманоид", "нежить"...
	Alignment string `json:"alignment,omitempty"` // "хаотично-злое"...
	AC        int    `json:"ac"`
	ACNote    string `json:"acNote,omitempty"` // "природный доспех", "кольчуга"...
	HP        int    `json:"hp"`
	HitDice   string `json:"hitDice,omitempty"` // "8d8+16"
	Speed     string `json:"speed,omitempty"`   // "30 фт., полёт 60 фт. (парит)"

	Abilities Abilities `json:"abilities"` // переиспользуем тип из character_sheet.go — те же 6 характеристик 1-30

	SavingThrows          string `json:"savingThrows,omitempty"`
	Skills                string `json:"skills,omitempty"`
	DamageVulnerabilities string `json:"damageVulnerabilities,omitempty"`
	DamageResistances     string `json:"damageResistances,omitempty"`
	DamageImmunities      string `json:"damageImmunities,omitempty"`
	ConditionImmunities   string `json:"conditionImmunities,omitempty"`
	Senses                string `json:"senses,omitempty"`
	Languages             string `json:"languages,omitempty"`
	CR                    string `json:"cr,omitempty"` // "1/2", "5"... — не число: дробные степени опасности
	ProficiencyBonus      int    `json:"proficiencyBonus,omitempty"`

	Traits                string `json:"traits,omitempty"` // особенности/врождённые способности
	Actions               string `json:"actions,omitempty"`
	BonusActions          string `json:"bonusActions,omitempty"`
	Reactions             string `json:"reactions,omitempty"`
	LegendaryActionsIntro string `json:"legendaryActionsIntro,omitempty"` // вступительный текст ("может совершить 3 легендарных действия...")
	LegendaryActions      string `json:"legendaryActions,omitempty"`
	LairActions           string `json:"lairActions,omitempty"` // действия и эффекты логова одним блоком
	Description           string `json:"description,omitempty"` // лор/фон — не влияет на игромеханику

	Tags []string `json:"tags,omitempty"` // произвольные метки (биом/источник/кампания) — фильтр в панели бестиария

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
	// service.Room.killMonsterCombatant) — лутание одного трупа не трогает
	// "склад" шаблона и других уже стоящих на карте токенов того же монстра.
	Inventory []InventoryEntry `json:"inventory,omitempty"`

	UpdatedAt time.Time `json:"updatedAt"`
}

// MonsterSpellRef — одна строка списка "Заклинания" статблока монстра.
type MonsterSpellRef struct {
	SpellID string `json:"spellId,omitempty"` // id в библиотеке заклинаний, "" если ссылка осиротела/введена вручную
	Name    string `json:"name"`
	Level   int    `json:"level"`
}

// NewMonster создаёт пустую карточку монстра с разумными дефолтами "из
// коробки" — все характеристики по 10 (модификатор +0), КД 10, размер
// "Средний", как у пустого бланка персонажа (DefaultCharacterSheet).
func NewMonster(id, name string) *Monster {
	return &Monster{
		ID:        id,
		Name:      name,
		Size:      "Средний",
		AC:        10,
		Abilities: Abilities{Str: 10, Dex: 10, Con: 10, Int: 10, Wis: 10, Cha: 10},
	}
}
