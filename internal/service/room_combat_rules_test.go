package service

import (
	"context"
	"encoding/json"
	"testing"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository/memory"
	"beacon-table/internal/schema"
)

// Правила боя приходят от системы мира (domain.CombatRules): комната без
// правил играет по «Своей системе», D&D задаёт свои — те же, что раньше
// были зашиты в ядро (см. cmd/beacon-table/modules.go: dndCombatRules).

func dndTestRules() *domain.CombatRules {
	return &domain.CombatRules{
		Initiative: domain.InitiativeRule{Roll: "1d20 + @dex_mod"},
		ZeroHP: domain.ZeroHPRule{
			Character: domain.ZeroHPDeathSaves, Other: domain.ZeroHPDead,
			DeathSaves: &domain.DeathSavesRule{Success: 3, Fail: 3, StabilizeHP: 1},
		},
		XP: domain.XPRule{Field: "cr", Table: map[string]int{"1/2": 100}},
	}
}

// dexMonsterSchema — схема существа с модификатором Ловкости, на который
// ссылается формула инициативы D&D.
func dexMonsterSchema(t *testing.T) *schema.Schema {
	t.Helper()
	s, err := schema.Parse([]byte(`{
		"format": "beacon-schema/v1", "kind": "monster",
		"fields": {
			"dex": {"type": "number", "path": "abilities.dex", "label": "Ловкость", "modifierTarget": "abilities.dex"},
			"dex_mod": {"type": "computed", "label": "Мод. Ловкости", "formula": "floor((@dex - 10) / 2)"}
		},
		"layout": [{"fields": ["dex", "dex_mod"]}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func hasStatus(list []domain.AppliedStatus, slug string) bool {
	return indexOfStatus(list, slug) >= 0
}

func TestCustomRulesCharacterGoesOutAndWakes(t *testing.T) {
	r := testRoom()
	r.combat.Combatants["c1"] = &domain.Combatant{ID: "c1", TokenID: "tok-1", CharacterID: "char-1", HPCurrent: 5, HPMax: 10}

	r.handleSetCombatantHP("c1", nil, nil, nil, ptr(-7))
	if _, ok := r.combat.Combatants["c1"]; !ok {
		t.Fatal("выбывший персонаж пропал из инициативы")
	}
	if !hasStatus(tokenStatuses(r), domain.ZeroHPOutStatus) {
		t.Fatalf("на 0 хитов нет «без сознания»: %+v", tokenStatuses(r))
	}
	if r.scenes["scene-1"].Tokens["tok-1"].Dead {
		t.Fatal("выбывший не должен становиться костями")
	}

	r.handleSetCombatantHP("c1", nil, nil, nil, ptr(4))
	if hasStatus(tokenStatuses(r), domain.ZeroHPOutStatus) {
		t.Fatal("после лечения «без сознания» не снялось")
	}
}

func TestCustomRulesMonsterDiesWithXPFromCard(t *testing.T) {
	r := testRoom()
	var m domain.Monster
	if err := json.Unmarshal([]byte(`{"id":"shade","name":"Тень","xp":75}`), &m); err != nil {
		t.Fatal(err)
	}
	r.monsters = &fakeMonsters{list: []*domain.Monster{&m}}
	r.combat.Combatants["c1"] = &domain.Combatant{ID: "c1", TokenID: "tok-1", MonsterID: "shade", HPCurrent: 3, HPMax: 3}

	r.handleSetCombatantHP("c1", nil, nil, nil, ptr(-3))
	if _, ok := r.combat.Combatants["c1"]; ok {
		t.Fatal("существо на 0 хитов осталось в инициативе")
	}
	tok := r.scenes["scene-1"].Tokens["tok-1"]
	if !tok.Dead || tok.XP != 75 {
		t.Fatalf("токен: dead=%v xp=%d, ожидали кости и 75 опыта", tok.Dead, tok.XP)
	}
}

func TestCustomRulesIgnoreDeathSaves(t *testing.T) {
	r := testRoom()
	r.combat.Combatants["c1"] = &domain.Combatant{ID: "c1", CharacterID: "char-1"}
	r.handleSetCombatantDeathSave("c1", "fail", 3)
	cmb, ok := r.combat.Combatants["c1"]
	if !ok || cmb.DeathSaveFail != 0 {
		t.Fatal("в системе без спасбросков отметка провала что-то изменила")
	}
}

func TestDnDRulesDeathSaves(t *testing.T) {
	r := testRoom()
	r.rules = dndTestRules()
	r.combat.Combatants["c1"] = &domain.Combatant{ID: "c1", TokenID: "tok-1", CharacterID: "char-1", HPCurrent: 5, HPMax: 10}

	r.handleSetCombatantHP("c1", ptr(0), nil, nil, nil)
	if _, ok := r.combat.Combatants["c1"]; !ok {
		t.Fatal("персонаж на 0 хитов должен ждать спасбросков в инициативе")
	}
	if len(tokenStatuses(r)) != 0 {
		t.Fatal("в D&D на 0 хитов состояние само не вешается")
	}

	r.handleSetCombatantDeathSave("c1", "success", 7) // больше нужного — поджимается
	if got := r.combat.Combatants["c1"]; got.HPCurrent != 1 || got.DeathSaveSuccess != 0 {
		t.Fatalf("3 успеха: хиты %d, отметки %d; ожидали 1 и 0", got.HPCurrent, got.DeathSaveSuccess)
	}

	r.handleSetCombatantHP("c1", ptr(0), nil, nil, nil)
	r.handleSetCombatantDeathSave("c1", "fail", 2)
	if _, ok := r.combat.Combatants["c1"]; !ok {
		t.Fatal("2 провала — ещё жив")
	}
	r.handleSetCombatantDeathSave("c1", "fail", 3)
	if _, ok := r.combat.Combatants["c1"]; ok {
		t.Fatal("3 провала — персонаж должен уйти из инициативы")
	}
	if !r.scenes["scene-1"].Tokens["tok-1"].Dead {
		t.Fatal("3 провала — токен должен стать костями")
	}
}

func TestDnDRulesMonsterXPFromCR(t *testing.T) {
	r := testRoom()
	r.rules = dndTestRules()
	r.monsters = &fakeMonsters{list: []*domain.Monster{{ID: "gob", Name: "Гоблин", CR: "1/2"}}}
	r.combat.Combatants["c1"] = &domain.Combatant{ID: "c1", TokenID: "tok-1", MonsterID: "gob", HPCurrent: 7, HPMax: 7}

	r.handleSetCombatantHP("c1", nil, nil, nil, ptr(-7))
	if tok := r.scenes["scene-1"].Tokens["tok-1"]; !tok.Dead || tok.XP != 100 {
		t.Fatalf("токен: dead=%v xp=%d, ожидали кости и 100 опыта", tok.Dead, tok.XP)
	}
}

func TestInitiativeFollowsRules(t *testing.T) {
	r := testRoom()
	roller := &fixedRoller{total: 15}
	r.dice = roller
	r.monsters = &fakeMonsters{list: []*domain.Monster{{ID: "gob", Name: "Гоблин", Abilities: domain.Abilities{Dex: 14}}}}

	// «Своя система»: у карточки нет поля initiative — ручной ввод.
	r.handleAddCombatant(domain.ClientMsg{MonsterID: "gob"})
	if len(roller.formulas) != 0 {
		t.Fatalf("своя система без поля не должна бросать: %v", roller.formulas)
	}
	for _, cmb := range r.combat.Combatants {
		if cmb.Initiative != 0 {
			t.Fatalf("ручной ввод — боец встаёт с 0, а не %v", cmb.Initiative)
		}
	}

	r.rules = dndTestRules()
	r.schemas = map[string]*schema.Schema{schema.KindMonster: dexMonsterSchema(t)}
	r.handleAddCombatant(domain.ClientMsg{MonsterID: "gob"})
	if len(roller.formulas) != 1 || roller.formulas[0] != "1d20+2" {
		t.Fatalf("D&D, Лов 14: формулы %v", roller.formulas)
	}
}

// Ловкость от состояния меняет инициативу: модификатор abilities.dex
// входит в @dex_mod.
func TestInitiativeDexFromStatus(t *testing.T) {
	r := testRoom()
	roller := &fixedRoller{total: 15}
	r.dice = roller
	r.rules = dndTestRules()
	r.schemas = map[string]*schema.Schema{schema.KindMonster: dexMonsterSchema(t)}
	r.monsters = &fakeMonsters{list: []*domain.Monster{{ID: "gob", Name: "Гоблин", Abilities: domain.Abilities{Dex: 14}}}}
	tok := r.scenes["scene-1"].Tokens["tok-1"]
	tok.MonsterID = "gob"
	tok.Statuses = []domain.AppliedStatus{{Slug: "haste", Modifiers: []domain.Modifier{
		{Target: "abilities.dex", Mode: domain.ModifierAdd, Value: "4"},
	}}}
	r.handleAddCombatant(domain.ClientMsg{TokenID: "tok-1"})
	if len(roller.formulas) != 1 || roller.formulas[0] != "1d20+4" {
		t.Fatalf("Лов 14 + 4 от состояния: формулы %v, ждали 1d20+4", roller.formulas)
	}
}

// Персонаж универсального листа: трекер «Своей системы» бросает формулу из
// поля листа initiative (CharacterSheet.Initiative).
func TestCustomRulesRollInitiativeFromSheet(t *testing.T) {
	r := testRoom()
	roller := &fixedRoller{total: 9}
	r.dice = roller
	chars := memory.NewCharacterStore()
	sheet := domain.DefaultCharacterSheet()
	sheet.Initiative = "1к6+2"
	if err := chars.Create(context.Background(), &domain.Character{ID: "char-1", Name: "Герой", Sheet: sheet}); err != nil {
		t.Fatal(err)
	}
	r.characters = chars

	r.handleAddCombatant(domain.ClientMsg{CharacterID: "char-1"})
	if len(roller.formulas) != 1 || roller.formulas[0] != "1d6+2" {
		t.Fatalf("формулы: %v, ожидали 1d6+2 из листа", roller.formulas)
	}
}

// itemsByID — библиотека предметов для комнаты: нужен только Get.
type itemsByID map[string]*domain.Item

func (m itemsByID) List(context.Context) ([]*domain.Item, error) { return nil, nil }
func (m itemsByID) Get(_ context.Context, id string) (*domain.Item, error) {
	if it, ok := m[id]; ok {
		return it, nil
	}
	return nil, domain.ErrNotFound
}
func (m itemsByID) Create(context.Context, string, *domain.Item) error         { return nil }
func (m itemsByID) Update(context.Context, string, *domain.Item) (bool, error) { return false, nil }
func (m itemsByID) Delete(context.Context, string) error                       { return nil }

// Инициатива со ссылками: сервер считает @stat.<ключ> по схеме листа с
// модификаторами надетых предметов и состояний на токене — то же число,
// что показывает лист.
func TestInitiativeFormulaWithRefs(t *testing.T) {
	r := testRoom()
	roller := &fixedRoller{total: 11}
	r.dice = roller
	ctx := context.Background()
	chars := memory.NewCharacterStore()
	sheet := domain.DefaultCharacterSheet()
	sheet.Initiative = "1к20 + @stat.ловкость"
	sheet.Stats = []domain.FreeStat{{Name: "Ловкость", Value: 3}}
	if err := chars.Create(ctx, &domain.Character{ID: "char-1", AccountID: "acc-1", Name: "Герой", Sheet: sheet}); err != nil {
		t.Fatal(err)
	}
	if _, err := chars.AddInventoryEntry(ctx, "char-1", "acc-1", domain.InventoryEntry{ID: "e1", ItemID: "ring", Name: "Кольцо", Quantity: 1, Equipped: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := chars.AddInventoryEntry(ctx, "char-1", "acc-1", domain.InventoryEntry{ID: "e2", ItemID: "boots", Name: "Сапоги", Quantity: 1}); err != nil {
		t.Fatal(err)
	}
	r.characters = chars
	items := itemsByID{}
	items["ring"] = &domain.Item{ID: "ring", Modifiers: []domain.Modifier{{Target: "stat.ловкость", Mode: domain.ModifierAdd, Value: "1"}}}
	items["boots"] = &domain.Item{ID: "boots", Modifiers: []domain.Modifier{{Target: "stat.ловкость", Mode: domain.ModifierAdd, Value: "10"}}}
	r.items = items
	tok := r.scenes["scene-1"].Tokens["tok-1"]
	tok.CharacterID = "char-1"
	tok.Statuses = []domain.AppliedStatus{{Slug: "haste", Level: 2, Modifiers: []domain.Modifier{
		{Target: "stat.ловкость", Mode: domain.ModifierAdd, Value: "1", PerLevel: true},
	}}}

	r.handleAddCombatant(domain.ClientMsg{TokenID: "tok-1"})
	// 3 + кольцо 1 + состояние 1×2; ненадетые сапоги не считаются.
	if len(roller.formulas) != 1 || roller.formulas[0] != "1d20+6" {
		t.Fatalf("формулы: %v, ждали 1d20+6", roller.formulas)
	}
}

func TestInitiativeFormulaEdgeCases(t *testing.T) {
	add := func(r *Room, m *domain.Monster) float64 {
		r.monsters = &fakeMonsters{list: []*domain.Monster{m}}
		r.combat = domain.NewCombatState()
		r.handleAddCombatant(domain.ClientMsg{MonsterID: m.ID})
		for _, cmb := range r.combat.Combatants {
			return cmb.Initiative
		}
		t.Fatal("боец не добавился")
		return 0
	}
	monster := func(raw string) *domain.Monster {
		var m domain.Monster
		if err := json.Unmarshal([]byte(raw), &m); err != nil {
			t.Fatal(err)
		}
		return &m
	}

	r := testRoom()
	roller := &fixedRoller{total: 9}
	r.dice = roller
	// Число без кубов — это и есть инициатива, бросать нечего.
	if got := add(r, monster(`{"id":"a","name":"Статуя","initiative":"3 + 2"}`)); got != 5 || len(roller.formulas) != 0 {
		t.Fatalf("число: %v, броски %v", got, roller.formulas)
	}
	// Кривая формула — ручной ввод.
	if got := add(r, monster(`{"id":"b","name":"Тень","initiative":"1d20 +"}`)); got != 0 || len(roller.formulas) != 0 {
		t.Fatalf("кривая формула: %v, броски %v", got, roller.formulas)
	}
	// Ссылка на поле карточки из схемы существа.
	if got := add(r, monster(`{"id":"c","name":"Волк","initiative":"1d20 + @speed / 10","speed":"30"}`)); got != 9 || len(roller.formulas) != 1 || roller.formulas[0] != "1d20+3" {
		t.Fatalf("ссылка на поле: %v, броски %v", got, roller.formulas)
	}

	// Система со старым бланком без схем: ссылки — только пути в JSON.
	r = testRoom()
	roller = &fixedRoller{total: 9}
	r.dice = roller
	r.schemas = map[string]*schema.Schema{schema.KindMonster: nil}
	add(r, monster(`{"id":"d","name":"Гоблин","initiative":"1d20 + floor((@abilities.dex - 10) / 2) + @stat.ловкость","abilities":{"dex":14}}`))
	if len(roller.formulas) != 1 || roller.formulas[0] != "1d20+2" {
		t.Fatalf("без схемы: броски %v", roller.formulas)
	}
}

// Общие поля ядра — по схеме системы: КД формулой приходит в трекер уже
// посчитанной (основа, без модификаторов — их трекер накладывает сам).
func TestCombatantCoreFromSchema(t *testing.T) {
	sheetSchema, err := schema.Parse([]byte(`{
		"format": "beacon-schema/v1", "kind": "sheet",
		"core": {"ac": "defense", "hp.current": "hp", "hp.max": "hp_max"},
		"fields": {
			"hp": {"type": "number", "path": "combat.hpCurrent", "label": "Хиты"},
			"hp_max": {"type": "number", "path": "combat.hpMax", "label": "Макс."},
			"defense": {"type": "computed", "formula": "10 + @stat.ловкость", "label": "Защита", "modifierTarget": "ac"},
			"stats": {"type": "table", "path": "stats", "label": "Х", "statRows": {"name": "name", "value": "value"}, "columns": [
				{"id": "name", "type": "text", "path": "name", "label": "Н"},
				{"id": "value", "type": "number", "path": "value", "label": "З"}
			]}
		},
		"layout": [{"fields": ["defense"]}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	monsterSchema, err := schema.Parse([]byte(`{
		"format": "beacon-schema/v1", "kind": "monster",
		"core": {"ac": "armor", "hp.max": "vitality"},
		"fields": {
			"armor": {"type": "computed", "formula": "@base_ac + 2", "label": "Защита"},
			"vitality": {"type": "computed", "formula": "@level * 6", "label": "Хиты"}
		},
		"layout": [{"fields": ["armor", "vitality"]}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	r := testRoom()
	r.dice = &fixedRoller{total: 5}
	r.schemas = map[string]*schema.Schema{schema.KindSheet: sheetSchema, schema.KindMonster: monsterSchema}
	chars := memory.NewCharacterStore()
	sheet := domain.DefaultCharacterSheet()
	sheet.Combat.AC = 99
	sheet.Combat.HPCurrent, sheet.Combat.HPMax = 7, 12
	sheet.Stats = []domain.FreeStat{{Name: "Ловкость", Value: 3}}
	if err := chars.Create(context.Background(), &domain.Character{ID: "char-1", Name: "Герой", Sheet: sheet}); err != nil {
		t.Fatal(err)
	}
	r.characters = chars
	var m domain.Monster
	if err := json.Unmarshal([]byte(`{"id":"ogre","name":"Огр","ac":1,"hp":1,"base_ac":11,"level":4}`), &m); err != nil {
		t.Fatal(err)
	}
	r.monsters = &fakeMonsters{list: []*domain.Monster{&m}}

	r.handleAddCombatant(domain.ClientMsg{CharacterID: "char-1"})
	r.handleAddCombatant(domain.ClientMsg{MonsterID: "ogre"})
	byName := map[string]*domain.Combatant{}
	for _, c := range r.combat.Combatants {
		byName[c.Name] = c
	}
	if c := byName["Герой"]; c == nil || c.AC != 13 || c.HPCurrent != 7 || c.HPMax != 12 {
		t.Fatalf("герой: %+v, ждали КД 13 из формулы и хиты 7/12", c)
	}
	if c := byName["Огр"]; c == nil || c.AC != 13 || c.HPMax != 24 || c.HPCurrent != 24 {
		t.Fatalf("огр: %+v, ждали КД 13 и хиты 24 из формул", c)
	}
}
