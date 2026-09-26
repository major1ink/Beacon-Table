package service

import (
	"context"
	"encoding/json"
	"testing"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository/memory"
)

// Правила боя приходят от системы мира (domain.CombatRules): комната без
// правил играет по «Своей системе», D&D задаёт свои — те же, что раньше
// были зашиты в ядро (см. cmd/beacon-table/modules.go: dndCombatRules).

func dndTestRules() *domain.CombatRules {
	return &domain.CombatRules{
		Initiative: domain.InitiativeRule{Roll: "1d20", Bonus: "abilityMod:dex"},
		ZeroHP: domain.ZeroHPRule{
			Character: domain.ZeroHPDeathSaves, Other: domain.ZeroHPDead,
			DeathSaves: &domain.DeathSavesRule{Success: 3, Fail: 3, StabilizeHP: 1},
		},
		XP: domain.XPRule{Field: "cr", Table: map[string]int{"1/2": 100}},
	}
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
	r.handleAddCombatant(domain.ClientMsg{MonsterID: "gob"})
	if len(roller.formulas) != 1 || roller.formulas[0] != "1d20+2" {
		t.Fatalf("D&D, Лов 14: формулы %v", roller.formulas)
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
