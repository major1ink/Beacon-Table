package domain

import (
	"reflect"
	"testing"
)

func TestResolveJSONPath(t *testing.T) {
	sheet := reflect.TypeOf(CharacterSheet{})
	ok := map[string]reflect.Type{
		"combat.ac":      reflect.TypeOf(0),
		"COMBAT.AC":      reflect.TypeOf(0), // без учёта регистра, как encoding/json
		"abilities.str":  reflect.TypeOf(0),
		"notes.0":        reflect.TypeOf(""),
		"resources":      reflect.TypeOf([]ResourceRow{}),
		"stats.3.name":   reflect.TypeOf(""),
		"coins.gp":       reflect.TypeOf(0),
		"luck":           nil, // незнакомый ключ верхнего уровня — Extra
		"homebrew.a.b.c": nil,
	}
	for path, want := range ok {
		got, err := ResolveJSONPath(sheet, path)
		if err != nil {
			t.Errorf("%s: %v", path, err)
			continue
		}
		if got != want {
			t.Errorf("%s: тип %v, ожидали %v", path, got, want)
		}
	}
	for _, bad := range []string{"", "combat.shield", "combat.ac.value", "notes.first", "a..b"} {
		if _, err := ResolveJSONPath(sheet, bad); err == nil {
			t.Errorf("%q: ожидали ошибку", bad)
		}
	}
	// У строки таблицы нет Extra — незнакомый ключ там не сохранится.
	if _, err := ResolveJSONPath(reflect.TypeOf(ResourceRow{}), "shield"); err == nil {
		t.Error("незнакомое поле строки таблицы должно быть ошибкой")
	}
}
