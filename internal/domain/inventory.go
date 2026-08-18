package domain

// InventoryEntry — один слот инвентаря: ссылка на карточку каталога (Item,
// см. item.go) + СНИМОК Name/ImageURL/WeightLb на момент добавления (тот же
// приём, что и у MonsterSpellRef, см. monster.go — переживает удаление или
// правку исходной карточки каталога, второй источник правды не образуется,
// потому что снимок никогда не подтягивается заново, только пишется один
// раз при добавлении).
//
// Общая форма для четырёх разных мест хранения:
//   - инвентарь персонажа — своя SQL-таблица (см. repository.CharacterRepository:
//     ListInventory/AddInventoryEntry/...), НЕ часть CharacterSheet — см.
//     комментарий там же о причине.
//   - Monster.Inventory — шаблон добычи монстра бестиария, целиком внутри
//     JSON-карточки монстра.
//   - Token.Loot — снимок Monster.Inventory, сделанный в момент смерти (см.
//     service.Room: killMonsterCombatant), целиком внутри JSON-состояния сцены.
//   - LootHub.Entries — хаб ДМ, целиком внутри своего JSON-файла (см.
//     repository/scenefile).
type InventoryEntry struct {
	ID string `json:"id"`
	// ItemID — id карточки в общей библиотеке предметов (см. item.go), "" —
	// карточка с тех пор удалена из каталога, либо запись добавлена вручную
	// (не через каталог) и никогда не была с ним связана.
	ItemID   string  `json:"itemId,omitempty"`
	Name     string  `json:"name"`
	ImageURL string  `json:"imageUrl,omitempty"`
	WeightLb float64 `json:"weightLb,omitempty"`
	Quantity int     `json:"quantity"`
	// Equipped — "надето/используется" — имеет смысл только в инвентаре
	// персонажа (Monster.Inventory/Token.Loot/LootHub его не используют, но
	// поле общее, чтобы не заводить отдельный тип только ради одного флага).
	Equipped bool   `json:"equipped,omitempty"`
	Notes    string `json:"notes,omitempty"`
}
