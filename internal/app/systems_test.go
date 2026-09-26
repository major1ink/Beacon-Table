package app

import (
	"testing"
	"testing/fstest"

	"beacon-table/internal/domain"
	"beacon-table/internal/module"
)

// Цели модификаторов и правила боя мира берутся из модуля его системы;
// «Своя система» и мир без модуля на сервере получают только ядро.
func TestWorldTargetsAndRulesFromSystemModule(t *testing.T) {
	m, _ := newTestManager(t)
	rules := &domain.CombatRules{
		Initiative: domain.InitiativeRule{Roll: "2d6"},
		ZeroHP:     domain.ZeroHPRule{Character: domain.ZeroHPNone, Other: domain.ZeroHPDead},
	}
	m.modules = module.NewRegistry("", append(testSystems(), module.Builtin(fstest.MapFS{}, "systemdata", "luckworld", &module.Manifest{
		Format: module.Format, ID: "luckworld", Type: module.TypeSystem, Title: "Удача", Version: "1.0.0",
		Combat:          rules,
		ModifierTargets: []domain.ModifierTargetInfo{{Target: "luck", Label: "Удача", System: true}},
		Units:           &domain.SystemUnits{Weight: "камн"},
		Sheet:           "luck-sheet",
		Currencies:      []domain.Currency{{Key: "shells", Label: "Ракушки"}},
	})), nil, "")

	custom := &domain.Company{System: domain.SystemCustom}
	if got := m.ModifierTargets(custom); len(got) != len(domain.CoreModifierTargets) {
		t.Errorf("«Своя система»: целей %d, ожидали только ядро (%d)", len(got), len(domain.CoreModifierTargets))
	}
	if got := m.combatRules(custom); got.ZeroHP.Character != domain.ZeroHPOut {
		t.Errorf("«Своя система»: правила %+v", got.ZeroHP)
	}

	luck := &domain.Company{System: "luckworld"}
	got := m.ModifierTargets(luck)
	if last := got[len(got)-1]; last.Target != "luck" || !last.System {
		t.Errorf("цели мира на системе: %+v", got)
	}
	if m.combatRules(luck) != rules {
		t.Error("правила боя мира должны браться из модуля системы")
	}

	gone := &domain.Company{System: "no-such-system"}
	if got := m.ModifierTargets(gone); len(got) != len(domain.CoreModifierTargets) {
		t.Errorf("мир без модуля системы: целей %d", len(got))
	}
	if got := m.combatRules(gone); got.ZeroHP.Character != domain.ZeroHPOut {
		t.Errorf("мир без модуля системы: правила %+v", got.ZeroHP)
	}

	// Единицы и валюты: у системы — свои, у «Своей системы» и мира без
	// модуля — «кг» и «Деньги».
	if p := m.SystemProfile(luck); p.Title != "Удача" || p.Sheet != "luck-sheet" || p.Units.Weight != "камн" || len(p.Currencies) != 1 || p.Currencies[0].Key != "shells" {
		t.Errorf("профиль системы: %+v", p)
	}
	for name, c := range map[string]*domain.Company{"своя": custom, "без модуля": gone, "мир не запущен": nil} {
		p := m.SystemProfile(c)
		if p.Sheet != domain.SheetUniversal || p.Units.Weight != "кг" || len(p.Currencies) != 1 || p.Currencies[0].Key != "money" {
			t.Errorf("%s: профиль %+v", name, p)
		}
	}
	// Система без units/currencies в module.json — умолчания «Своей системы».
	if p := m.SystemProfile(&domain.Company{System: domain.SystemDnD5e2024}); p.Sheet != domain.SheetUniversal || p.Units.Weight != "кг" || p.Currencies[0].Key != "money" {
		t.Errorf("система без единиц: %+v", p)
	}
}
