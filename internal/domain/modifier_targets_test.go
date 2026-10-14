package domain

import (
	"strings"
	"testing"
)

func TestStatKey(t *testing.T) {
	cases := map[string]string{
		"Сила":                  "сила",
		"  Удача  ночью ":       "удача_ночью",
		"Сила (атлетика)!":      "сила_атлетика",
		"HP-bonus_2":            "hp-bonus_2",
		"":                      "",
		"!!!":                   "",
		strings.Repeat("а", 40): strings.Repeat("а", 32),
	}
	for name, want := range cases {
		if got := StatKey(name); got != want {
			t.Errorf("StatKey(%q) = %q, ожидали %q", name, got, want)
		}
	}
	if got := StatTarget("Удача"); got != "stat.удача" {
		t.Errorf("StatTarget: %q", got)
	}
	if got := StatTarget("  "); got != "" {
		t.Errorf("StatTarget пустого названия: %q", got)
	}
}

func TestValidModifierTarget(t *testing.T) {
	for _, ok := range []string{"ac", "hp.max", "stat.удача_ночью", "abilities.str", "system.attributes.ac.bonus"} {
		if !ValidModifierTarget(ok) {
			t.Errorf("%q должна годиться в цель", ok)
		}
	}
	for _, bad := range []string{"", "КД + 2", "stat.", ".ac", "a..b", strings.Repeat("a", 65)} {
		if ValidModifierTarget(bad) {
			t.Errorf("%q не должна годиться в цель", bad)
		}
	}
	if !IsCoreModifierTarget(ModifierTargetAC) || IsCoreModifierTarget("abilities.str") {
		t.Error("цели ядра — только hp.*, ac, speed, initiative")
	}
	if !TargetSupportsPeriod(ModifierTargetHPCurrent) || TargetSupportsPeriod("stat.сила") {
		t.Error("период — только у текущих хитов")
	}
}
