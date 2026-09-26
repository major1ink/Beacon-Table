package domain

import (
	"encoding/json"
	"testing"
)

func dndRules() *CombatRules {
	return &CombatRules{
		Initiative: InitiativeRule{Roll: "1d20", Bonus: "abilityMod:dex"},
		ZeroHP: ZeroHPRule{
			Character: ZeroHPDeathSaves, Other: ZeroHPDead,
			DeathSaves: &DeathSavesRule{Success: 3, Fail: 3, StabilizeHP: 1},
		},
		XP: XPRule{Field: "cr", Table: map[string]int{"1/2": 100, "5": 1800}},
	}
}

func TestCombatRulesValidate(t *testing.T) {
	if err := CustomCombatRules().Validate(); err != nil {
		t.Fatalf("правила «Своей системы»: %v", err)
	}
	if err := dndRules().Validate(); err != nil {
		t.Fatalf("правила D&D: %v", err)
	}
	bad := map[string]func(r *CombatRules){
		"формула не из кубов":     func(r *CombatRules) { r.Initiative.Roll = "1d20; drop" },
		"неизвестная прибавка":    func(r *CombatRules) { r.Initiative.Bonus = "luck:dex" },
		"прибавка без поля":       func(r *CombatRules) { r.Initiative.Bonus = "field:" },
		"неизвестный режим":       func(r *CombatRules) { r.ZeroHP.Other = "explode" },
		"спасброски без счётчика": func(r *CombatRules) { r.ZeroHP.DeathSaves = nil },
		"ноль успехов":            func(r *CombatRules) { r.ZeroHP.DeathSaves.Success = 0 },
		"слишком много провалов":  func(r *CombatRules) { r.ZeroHP.DeathSaves.Fail = 50 },
		"кривое поле опыта":       func(r *CombatRules) { r.XP.Field = "a..b" },
		"отрицательный опыт":      func(r *CombatRules) { r.XP.Table["5"] = -1 },
	}
	for name, spoil := range bad {
		r := dndRules()
		spoil(r)
		if err := r.Validate(); err == nil {
			t.Errorf("%s: ожидали ошибку", name)
		}
	}
}

func TestInitiativeFormula(t *testing.T) {
	dnd := dndRules()
	sheet := DefaultCharacterSheet()
	sheet.Abilities.Dex = 15
	if got := dnd.InitiativeFormula(sheet, nil); got != "1d20+2" {
		t.Errorf("D&D, Лов 15: %q", got)
	}
	// Голый токен: характеристика 10, но прибавка всё равно пишется — как
	// раньше, "1d20+0".
	if got := dnd.InitiativeFormula(nil, nil); got != "1d20+0" {
		t.Errorf("D&D без листа: %q", got)
	}
	minus2 := func(mod int) int { return mod - 2 }
	if got := dnd.InitiativeFormula(&Monster{Abilities: Abilities{Dex: 8}}, minus2); got != "1d20-3" {
		t.Errorf("D&D, Лов 8 и состояние -2: %q", got)
	}

	custom := CustomCombatRules()
	if got := custom.InitiativeFormula(nil, nil); got != "" {
		t.Errorf("своя система без поля — ручной ввод, а получили %q", got)
	}
	var m Monster
	if err := json.Unmarshal([]byte(`{"name":"Тень","initiative":"1к6+1"}`), &m); err != nil {
		t.Fatal(err)
	}
	if got := custom.InitiativeFormula(m, nil); got != "1d6+1" {
		t.Errorf("своя система, поле карточки: %q", got)
	}
	if got := custom.InitiativeFormula(m, minus2); got != "1d6+1-2" {
		t.Errorf("своя система, поле и состояние: %q", got)
	}
	if err := json.Unmarshal([]byte(`{"name":"Тень","initiative":12}`), &m); err != nil {
		t.Fatal(err)
	}
	if got := custom.InitiativeFormula(m, nil); got != "12" {
		t.Errorf("своя система, число в поле: %q", got)
	}

	byField := &CombatRules{Initiative: InitiativeRule{Roll: "2d6", Bonus: "field:init"}}
	if err := json.Unmarshal([]byte(`{"name":"Тень","init":3}`), &m); err != nil {
		t.Fatal(err)
	}
	if got := byField.InitiativeFormula(m, nil); got != "2d6+3" {
		t.Errorf("прибавка из поля: %q", got)
	}
}

func TestXPFor(t *testing.T) {
	dnd := dndRules()
	if got := dnd.XPFor(&Monster{CR: " 1/2 "}); got != 100 {
		t.Errorf("D&D, CR 1/2: %d", got)
	}
	if got := dnd.XPFor(&Monster{CR: "страшный"}); got != 0 {
		t.Errorf("D&D, CR не из таблицы: %d", got)
	}
	var m Monster
	if err := json.Unmarshal([]byte(`{"name":"Тень","xp":75}`), &m); err != nil {
		t.Fatal(err)
	}
	custom := CustomCombatRules()
	if got := custom.XPFor(m); got != 75 {
		t.Errorf("своя система, поле xp: %d", got)
	}
	if got := custom.XPFor(&Monster{Name: "Без опыта"}); got != 0 {
		t.Errorf("своя система без поля: %d", got)
	}
}
