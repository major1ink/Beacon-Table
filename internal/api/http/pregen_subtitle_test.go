package http

import (
	"testing"

	"beacon-table/internal/domain"
	"beacon-table/internal/schema"
)

// Подпись готового персонажа: по шаблону list.subtitle схемы листа, у
// бланка D&D без схем — «вид, класс N ур.».
func TestPregenSubtitle(t *testing.T) {
	p := &domain.Pregen{Name: "Шила", Sheet: domain.DefaultCharacterSheet()}
	p.Sheet.Info.Class, p.Sheet.Info.Level, p.Sheet.Info.Race = "Плут", 3, "Эльф"
	if got := pregenSubtitle(p, nil); got != "Эльф, Плут 3 ур." {
		t.Errorf("D&D: %q", got)
	}
	p.Sheet.Info.Level = 0
	if got := pregenSubtitle(p, nil); got != "Эльф, Плут" {
		t.Errorf("D&D без уровня: %q", got)
	}
	sheet, err := schema.Parse([]byte(`{
		"format": "beacon-schema/v1", "kind": "sheet",
		"fields": {"hp_max": {"type": "number", "path": "combat.hpMax", "label": "Хиты"}},
		"layout": [{"fields": ["hp_max"]}],
		"list": {"subtitle": "Хиты {hp_max}"}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	p.Sheet.Combat.HPMax = 14
	if got := pregenSubtitle(p, sheet); got != "Хиты 14" {
		t.Errorf("по схеме: %q", got)
	}
	builtin, _ := schema.Builtin(schema.KindSheet)
	if got := pregenSubtitle(p, builtin); got != "" {
		t.Errorf("у встроенного листа шаблона нет — подписи нет, а получили %q", got)
	}
}
