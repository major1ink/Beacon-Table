package base

import (
	"encoding/json"
	"io/fs"
	"strings"
	"testing"

	"beacon-table/internal/domain"
	"beacon-table/internal/module"
)

// Базовые состояния: каждая карточка разбирается, slug совпадает с именем
// файла (по slug'у метка находит карточку и сопоставляется импорт Foundry),
// модификаторы — только из списка ядра.
func TestBaseConditions(t *testing.T) {
	m := Module()
	if m.Manifest.ID != ID || m.Manifest.Type != module.TypeContent {
		t.Fatalf("манифест: %+v", m.Manifest)
	}
	entries, err := fs.ReadDir(m.FS, m.ContentDir(module.KindConditions))
	if err != nil {
		t.Fatal(err)
	}
	slugs := map[string]bool{}
	for _, e := range entries {
		data, err := fs.ReadFile(m.FS, m.ContentDir(module.KindConditions)+"/"+e.Name())
		if err != nil {
			t.Fatal(err)
		}
		var c domain.Condition
		if err := json.Unmarshal(data, &c); err != nil {
			t.Fatalf("%s: %v", e.Name(), err)
		}
		if c.Slug+".json" != e.Name() || c.Name == "" || c.Icon == "" || c.Description == "" {
			t.Errorf("%s: slug/имя/значок/описание: %+v", e.Name(), c)
		}
		for _, mod := range c.Modifiers {
			if !domain.ValidModifierTarget(mod.Target) || strings.HasPrefix(mod.Target, "abilities.") {
				t.Errorf("%s: цель модификатора %q не из ядра", e.Name(), mod.Target)
			}
		}
		slugs[c.Slug] = true
	}
	for _, need := range []string{"dead", "unconscious", "prone", "stunned", "blinded", "burning", "bleeding", "concentrating"} {
		if !slugs[need] {
			t.Errorf("нет базового состояния %s", need)
		}
	}
	// Зависимые состояния ссылаются на существующие.
	for _, e := range entries {
		data, _ := fs.ReadFile(m.FS, m.ContentDir(module.KindConditions)+"/"+e.Name())
		var c domain.Condition
		_ = json.Unmarshal(data, &c)
		for _, r := range c.Riders {
			if !slugs[r] {
				t.Errorf("%s: зависимое состояние %q не найдено", e.Name(), r)
			}
		}
	}
}
