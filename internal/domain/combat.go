package domain

// Combatant — один участник трекера инициативы. Это СНИМОК, а не живая
// ссылка на Token/Character/Monster: имя/арт/HP копируются в момент
// добавления (см. service.Room.handleAddCombatant) и дальше живут своей
// жизнью в трекере — удаление токена с карты не убирает бойца из
// инициативы, и наоборот, снятие с инициативы не трогает токен. TokenID
// сохранён только как обратная ссылка НА БУДУЩЕЕ (например, "показать на
// карте") — сейчас клиент им не пользуется.
//
// AC/HPCurrent/HPMax — единственные поля, которые правит ДМ прямо в трекере
// (см. "set_combatant_ac"/"set_combatant_hp" в domain.ClientMsg), как в
// Foundry/DM Helpmate. Для комбатанта без персонажа/монстра за спиной
// (голый NPC-токен) они начинаются нулями — ДМ либо выставляет их вручную,
// либо просто не пользуется этим полем для данного бойца.
//
// DeathSaveSuccess/DeathSaveFail — спасброски от смерти (0-3 каждое), тоже
// правятся вручную ДМ прямо в трекере ("set_combatant_death_save"), как
// чекбоксы в Foundry — сервер сам кубик не кидает, только хранит отметки и
// разруливает исход по 3-й отметке. Имеют смысл только для бойца с
// CharacterID (игровой персонаж): у монстра/безликого NPC спасбросков от
// смерти не бывает — при HPCurrent<=0 он умирает сразу (см.
// service.Room.killMonsterCombatant), а у персонажа при HPCurrent<=0 ждём
// эти отметки. 3-й успех — персонаж стабилизируется и приходит в себя с 1
// HP, отметки сбрасываются, боец остаётся в инициативе; 3-й провал —
// персонаж умирает, убирается из инициативы и его токен помечается Dead,
// как у монстра (см. service.Room.handleSetCombatantDeathSave).
type Combatant struct {
	ID          string  `json:"id"`
	TokenID     string  `json:"tokenId,omitempty"`
	Name        string  `json:"name"`
	Image       string  `json:"image,omitempty"`
	Color       string  `json:"color,omitempty"`
	OwnerID     string  `json:"ownerId,omitempty"`
	CharacterID string  `json:"characterId,omitempty"`
	MonsterID   string  `json:"monsterId,omitempty"`
	Initiative  float64 `json:"initiative"`
	AC          int     `json:"ac"`
	HPCurrent   int     `json:"hpCurrent"`
	HPMax       int     `json:"hpMax"`
	// Seq — порядковый номер добавления, используется ТОЛЬКО как
	// детерминированный тай-брейк сортировки при равной инициативе (см.
	// service.sortedCombatantIDs) — иначе порядок "кто вперёд" плавал бы от
	// перезапуска к перезапуску (итерация map недетерминирована).
	Seq              int64 `json:"seq,omitempty"`
	DeathSaveSuccess int   `json:"deathSaveSuccess,omitempty"` // 0-3
	DeathSaveFail    int   `json:"deathSaveFail,omitempty"`    // 0-3
}

// CombatState — трекер инициативы всего стола (см. README/план: не
// привязан к конкретной сцене — DM может переключать карты посреди боя, и
// список/текущий ход не сбрасываются). Active — идёт ли бой прямо сейчас
// ("Начать бой"/"Завершить бой"): пока false, трекер — это просто
// собираемый ДМ список с посчитанной инициативой, верхний оверлей хода на
// экранах игроков/TV не показывается. CurrentID — ID Combatant, чей сейчас
// ход; пусто, если бой не активен или участников нет. Порядок ходов НЕ
// хранится отдельным полем — он всегда считается заново сортировкой
// Combatants по Initiative (см. sortedCombatantIDs), чтобы ручная правка
// инициативы посреди боя не могла разойтись с фактическим списком.
//
// ShowHP — общая настройка стола (раздел "Настройки", не привязана к
// конкретной сцене, как и весь CombatState): показывать ли HP в верхнем
// оверлее хода (web/src/vtt/combat-bar.js) игрокам/TV, а не только ДМ. ДМ
// видит HP в трекере и в самом оверлее всегда — этот флаг влияет только на
// то, что получают в combat_state НЕ-ДМ клиенты (см. service.combatPayload).
// LootingEnabled — общий тумблер стола ("Настройки"), тот же принцип, что и
// ShowHP: правит только ДМ через WS ("set_looting_enabled"), но значение не
// секрет — уходит всем ролям, чтобы клиент игрока знал, показывать ли пункт
// "Лутить" на мёртвых токенах (см. web/src/vtt/interaction.js). Сервер
// всё равно перепроверяет флаг сам при обработке "loot_take_item" (см.
// service.Room) — тумблер на клиенте только прячет кнопку, не единственная
// защита.
type CombatState struct {
	Active         bool                  `json:"active"`
	Round          int                   `json:"round"`
	CurrentID      string                `json:"currentId,omitempty"`
	Combatants     map[string]*Combatant `json:"combatants"`
	ShowHP         bool                  `json:"showHp,omitempty"`
	LootingEnabled bool                  `json:"lootingEnabled,omitempty"`
}

// NewCombatState — пустой трекер "из коробки" (первый запуск/нет
// сохранённого combat.json).
func NewCombatState() *CombatState {
	return &CombatState{Combatants: make(map[string]*Combatant)}
}
