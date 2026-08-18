package domain

// CharacterSheet — структурированный лист персонажа D&D 2024 (PHB 2024),
// в стиле бланка "Long Story Short" (4 страницы). Хранится как единый JSON
// в колонке characters.sheet_json (см. internal/repository/sqlite/characters.go) —
// заводить отдельные таблицы под навыки/оружие/заклинания избыточно: лист
// всегда читается/пишется целиком одним игроком, между полями нет
// реляционных запросов.
//
// Философия "умный бланк" (см. README): бэкенд не знает ничего о видах,
// классах, фонах, чертах и заклинаниях PHB — это всё свободный текст,
// который вводит игрок, как и в бумажном бланке. Автоматически на фронтенде
// считаются только производные числа по формулам PHB 2024 (модификаторы,
// бонус владения, бонусы навыков/спасбросков и т.п., см.
// web/src/pages/character-sheet.js: rules.js-блок) — сервер их не
// валидирует и не пересчитывает, только хранит то, что прислал клиент.
type CharacterSheet struct {
	Info      SheetInfo       `json:"info"`
	Abilities Abilities       `json:"abilities"`
	SaveProf  map[string]bool `json:"saveProf"`  // ключ характеристики ("str".."cha") -> владение спасброском
	SkillProf map[string]int  `json:"skillProf"` // ключ навыка -> 0 нет / 1 владение / 2 экспертиза

	Armor          ArmorWeaponProf `json:"armor"`
	ToolsLanguages string          `json:"toolsLanguages"`

	Combat  CombatStats `json:"combat"`
	Weapons []WeaponRow `json:"weapons"`

	Features      string `json:"features"`      // "Умения и способности"
	AttacksSpells string `json:"attacksSpells"` // "Атаки и заклинания"
	Feats         string `json:"feats"`         // "Черты"

	Goals              string    `json:"goals"`              // "Цели и задачи"
	Allies             string    `json:"allies"`             // "Союзники и организации"
	AdditionalFeatures string    `json:"additionalFeatures"` // "Дополнительные способности и умения"
	Treasure           string    `json:"treasure"`           // "Сокровища"
	Notes              [6]string `json:"notes"`              // 6 блоков "Заметки"

	Spellcasting   SpellcastingInfo `json:"spellcasting"`
	PreparedSpells []SpellRow       `json:"preparedSpells"`

	Size       string `json:"size"`
	Appearance string `json:"appearance"` // "Внешность" — свободный текст-описание
	Background string `json:"background"` // "Предыстория" — история персонажа (нарратив); черты характера/идеалы/привязанности/слабости — отдельно, см. PersonalityTraits/Ideals/Bonds/Flaws ниже
	Alignment  string `json:"alignment"`  // "Мировоззрение"
	Equipment  string `json:"equipment"`  // "Снаряжение"
	Coins      Coins  `json:"coins"`

	// Physical — физические данные персонажа (возраст/рост/вес/глаза/кожа/
	// волосы), терминология и состав полей — как в бланке "Long Story Short"
	// (см. lss-import.js: subInfo). Отдельно от Appearance (там — свободное
	// текстовое описание внешности).
	Physical Physical `json:"physical"`

	// Traits — видовые/расовые черты (то, что даёт вид/раса персонажа сами
	// по себе, вне классовых умений). Отдельное понятие от Features (умения
	// класса/подкласса), Feats (черты-фиты, приобретаемые по ходу игры) и
	// PersonalityTraits (черты ХАРАКТЕРА персонажа, роль-плей) — четыре
	// разных существующих поля этой структуры, которые легко перепутать
	// только по названию в UI.
	Traits string `json:"traits"`

	// ProficiencyNotes — сводный текст владений одним блоком (доспехи/
	// оружие/инструменты/языки/сопротивления вперемешку прозой), как на
	// бланке "Long Story Short". Дополняет, а не заменяет структурированные
	// чекбоксы Armor и поле ToolsLanguages — те остаются источником правды
	// для расчётов (которых на бэкенде и так нет, см. философию "умного
	// бланка"), это поле — просто место для текста, который не ложится в
	// чекбоксы буквально.
	ProficiencyNotes string `json:"proficiencyNotes"`

	// Resources — трекер ресурсов класса (очки чародейства, ярость, ки и
	// т.п.): у листа раньше не было для этого места вообще, кроме общего
	// текста Features. Динамическая таблица, как Weapons.
	Resources []ResourceRow `json:"resources"`

	// AttunementItems — именованные предметы настройки (заменяет собой
	// прежние безымянные 3 чекбокса "Настройка на магические предметы" —
	// то поле называлось Attunement [3]bool и было убрано из структуры при
	// переходе на этот список, см. git-историю и
	// internal/repository/sqlite/characters.go: decodeSheet про то, почему
	// старый JSON-ключ просто перестаёт использоваться, а не переиспользуется
	// с другим типом). Динамическая таблица, как Weapons — не жёстко 3
	// строки, фронт по умолчанию заводит 3 пустых для привычного UX.
	AttunementItems []AttunementItem `json:"attunementItems"`

	// PersonalityTraits/Ideals/Bonds/Flaws — четыре отдельные графы личных
	// качеств персонажа: "Черты характера", "Идеалы", "Привязанности",
	// "Слабости". Изначально показывались только на бланке D&D 5e 2014
	// (Character.System == SystemDnD5e2014), но реальные экспорты бланка
	// 2024 (см. lss-import.js) тоже присылают их отдельными полями — теперь
	// UI показывает их для обеих систем (см.
	// web/src/pages/character-sheet.js: renderTab1/renderTab4), просто в
	// разных местах листа. Сервер их не валидирует и не использует ни для
	// чего, кроме хранения (та же философия "умного бланка", что и у
	// остальных полей этой структуры).
	PersonalityTraits string `json:"personalityTraits"`
	Ideals            string `json:"ideals"`
	Bonds             string `json:"bonds"`
	Flaws             string `json:"flaws"`
}

// Physical — см. CharacterSheet.Physical.
type Physical struct {
	Age    string `json:"age"`
	Height string `json:"height"`
	Weight string `json:"weight"`
	Eyes   string `json:"eyes"`
	Skin   string `json:"skin"`
	Hair   string `json:"hair"`
}

// ResourceRow — строка таблицы "Ресурсы" (см. CharacterSheet.Resources).
// Current/Max — числа (не текст, в отличие от HitDice*): ресурсы класса
// обычно однородные очки, не составные кости разных типов. Recovery —
// свободный текст ("коротк. отдых", "долгий отдых", "1/день" и т.п.) —
// условия восстановления в PHB слишком разнообразны для чекбокса.
type ResourceRow struct {
	Name     string `json:"name"`
	Current  int    `json:"current"`
	Max      int    `json:"max"`
	Recovery string `json:"recovery"`
}

// AttunementItem — строка таблицы "Настройка на магические предметы" (см.
// CharacterSheet.AttunementItems).
type AttunementItem struct {
	Name    string `json:"name"`
	Attuned bool   `json:"attuned"`
}

// SheetInfo — текстовые поля шапки, не дублирующие Character.Name/AvatarURL.
type SheetInfo struct {
	Background string `json:"background"` // "Предыстория" (класс происхождения, не путать с CharacterSheet.Background — история персонажа)
	Class      string `json:"class"`
	Subclass   string `json:"subclass"`
	Species    string `json:"species"` // "Вид" — терминология бланка D&D 2024 (Character.System == SystemDnD5e2024)
	Race       string `json:"race"`    // "Раса" — терминология бланка D&D 5e 2014 (Character.System == SystemDnD5e2014), см. Species
	Level      int    `json:"level"`
	XP         int    `json:"xp"`
	// PlayerName — имя игрока (не путать с именем персонажа, Character.Name,
	// которое правится отдельной формой в "Мои персонажи"/панели ДМ).
	PlayerName string `json:"playerName"`
}

// Abilities — шесть базовых характеристик, значения по шкале 1-30 (обычно
// 1-20 у игровых персонажей). Модификатор = floor((score-10)/2), считается
// на фронтенде — здесь только сырые значения.
type Abilities struct {
	Str int `json:"str"`
	Dex int `json:"dex"`
	Con int `json:"con"`
	Int int `json:"int"`
	Wis int `json:"wis"`
	Cha int `json:"cha"`
}

// ArmorWeaponProf — владение категориями доспехов/оружия (чекбоксы бланка)
// плюс свободный текст для "другое" оружие/особые владения.
type ArmorWeaponProf struct {
	LightArmor     bool   `json:"lightArmor"`
	MediumArmor    bool   `json:"mediumArmor"`
	HeavyArmor     bool   `json:"heavyArmor"`
	Shield         bool   `json:"shield"`
	SimpleWeapons  bool   `json:"simpleWeapons"`
	MartialWeapons bool   `json:"martialWeapons"`
	OtherWeapons   string `json:"otherWeapons"`
}

// CombatStats — боевые показатели. AC и Speed — свободный ввод (расчёт AC
// зависит от надетых доспехов/заклинаний/черт, вне рамок "умного бланка").
// HitDiceTotal/HitDiceCurrent — текст ("3к8"), а не число: у мультиклассовых
// персонажей кости хитов разных типов.
type CombatStats struct {
	AC               int    `json:"ac"`
	HPCurrent        int    `json:"hpCurrent"`
	HPTemp           int    `json:"hpTemp"`
	HPMax            int    `json:"hpMax"`
	HitDiceTotal     string `json:"hitDiceTotal"`
	HitDiceCurrent   string `json:"hitDiceCurrent"`
	DeathSaveSuccess int    `json:"deathSaveSuccess"` // 0-3
	DeathSaveFail    int    `json:"deathSaveFail"`    // 0-3
	Exhaustion       int    `json:"exhaustion"`       // 0-6 (PHB 2024)
	Inspiration      bool   `json:"inspiration"`      // "Героическое вдохновение"
	Speed            int    `json:"speed"`
	Darkvision       int    `json:"darkvision"` // футы, 0 = нет тёмного зрения
	// IsDying — ручной флаг "при смерти/без сознания" бланка "Long Story
	// Short". Не выводится ни из чего автоматически (в отличие от того, как
	// LSS сам считает это на своей стороне по HP) — та же философия
	// "умного бланка", что и у остальных полей: сервер и клиент хранят то,
	// что явно проставил игрок.
	IsDying    bool   `json:"isDying"`
	Conditions string `json:"conditions"` // "Состояния" — свободный текст
}

// WeaponRow — строка таблицы "Оружие и боевые заговоры". Bonus — свободный
// текст колонки "Бонус / Сложность" бланка ("+5" для атаки или "СЛ 13" для
// спасброска цели) — фронт сам решает, показывать ли кнопку 🎲-броска: она
// появляется, только если Bonus распознаётся как чистое число со знаком
// (см. web/src/pages/character-sheet.js: parseAtkBonus).
type WeaponRow struct {
	Name   string `json:"name"`
	Bonus  string `json:"bonus"`
	Damage string `json:"damage"` // урон/вид ("1к8 рубящий")
	Notes  string `json:"notes"`
}

// SpellcastingInfo — заклинательная характеристика и ячейки заклинаний по
// уровням (1-9). Ability — "" (нет), "str".."cha". SlotsByLevel — свободный
// текст на уровень ("4" или "4/2" всего/использовано) — прогрессия ячеек по
// классам вне "умного бланка", игрок ведёт их вручную, как в бумажном листе.
type SpellcastingInfo struct {
	Ability      string    `json:"ability"`
	SlotsByLevel [9]string `json:"slotsByLevel"`
}

// SpellRow — строка таблицы "Заговоры и подготовленные заклинания" (стр. 4
// бланка). C/R/M — Концентрация/Ритуал/Материальный компонент.
type SpellRow struct {
	Level         int    `json:"level"`
	Name          string `json:"name"`
	CastTime      string `json:"castTime"`
	Range         string `json:"range"`
	Concentration bool   `json:"concentration"`
	Ritual        bool   `json:"ritual"`
	Material      bool   `json:"material"`
	Notes         string `json:"notes"`
}

// Coins — монеты по номиналам (ММ медь/СМ серебро/ЗМ золото/ЭМ электрум/ПМ платина).
type Coins struct {
	CP int `json:"cp"`
	SP int `json:"sp"`
	GP int `json:"gp"`
	EP int `json:"ep"`
	PP int `json:"pp"`
}

// abilityKeys — канонический порядок ключей характеристик, используется и
// для SaveProf, и как источник правды о допустимых ключах.
var abilityKeys = [6]string{"str", "dex", "con", "int", "wis", "cha"}

// DefaultCharacterSheet — пустой лист персонажа: характеристики по 10
// (модификатор +0, совпадает с пустым бланком PDF), без владений.
func DefaultCharacterSheet() CharacterSheet {
	saveProf := make(map[string]bool, len(abilityKeys))
	for _, k := range abilityKeys {
		saveProf[k] = false
	}
	return CharacterSheet{
		Abilities: Abilities{Str: 10, Dex: 10, Con: 10, Int: 10, Wis: 10, Cha: 10},
		SaveProf:  saveProf,
		SkillProf: map[string]int{},
		Info:      SheetInfo{Level: 1},
	}
}
