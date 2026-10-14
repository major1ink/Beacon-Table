package domain

import (
	"encoding/json"
	"testing"
)

func dndRules() *CombatRules {
	return &CombatRules{
		Initiative: InitiativeRule{Roll: "1d20 + @dex_mod"},
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
	withRefs := dndRules()
	withRefs.Initiative = InitiativeRule{Roll: "1d20 + floor((@abilities.dex - 10) / 2) + @stat.удача"}
	if err := withRefs.Validate(); err != nil {
		t.Fatalf("формула со ссылками: %v", err)
	}
	bad := map[string]func(r *CombatRules){
		"формула не из кубов":     func(r *CombatRules) { r.Initiative.Roll = "1d20; drop" },
		"кубы в умножении":        func(r *CombatRules) { r.Initiative.Roll = "2 * 1d20" },
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
	if got := dnd.InitiativeFormula(DefaultCharacterSheet(), nil); got != "1d20 + @dex_mod" {
		t.Errorf("D&D: %q", got)
	}
	minus2 := func(mod int) int { return mod - 2 }
	if got := dnd.InitiativeFormula(nil, minus2); got != "1d20 + @dex_mod-2" {
		t.Errorf("D&D и состояние -2: %q", got)
	}

	custom := CustomCombatRules()
	if got := custom.InitiativeFormula(nil, nil); got != "" {
		t.Errorf("своя система без поля — ручной ввод, а получили %q", got)
	}
	var m Monster
	if err := json.Unmarshal([]byte(`{"name":"Тень","initiative":"1к6+1"}`), &m); err != nil {
		t.Fatal(err)
	}
	if got := custom.InitiativeFormula(m, nil); got != "1к6+1" {
		t.Errorf("своя система, поле карточки: %q", got)
	}
	if got := custom.InitiativeFormula(m, minus2); got != "1к6+1-2" {
		t.Errorf("своя система, поле и состояние: %q", got)
	}
	if err := json.Unmarshal([]byte(`{"name":"Тень","initiative":12}`), &m); err != nil {
		t.Fatal(err)
	}
	if got := custom.InitiativeFormula(m, nil); got != "12" {
		t.Errorf("своя система, число в поле: %q", got)
	}
}

func TestXPFor(t *testing.T) {
	dnd := dndRules()
	var cr Monster
	if err := json.Unmarshal([]byte(`{"name":"Гоблин","cr":" 1/2 "}`), &cr); err != nil {
		t.Fatal(err)
	}
	if got := dnd.XPFor(&cr); got != 100 {
		t.Errorf("D&D, CR 1/2: %d", got)
	}
	if err := json.Unmarshal([]byte(`{"name":"Гоблин","cr":"страшный"}`), &cr); err != nil {
		t.Fatal(err)
	}
	if got := dnd.XPFor(&cr); got != 0 {
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
