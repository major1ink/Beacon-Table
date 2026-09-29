package schema

import (
	"encoding/json"
	"os"
	"testing"
)

// goodRows — годная схема листа со строками из testdata; каждый плохой случай
// портит в ней одно место.
func goodRows(t *testing.T) map[string]any {
	t.Helper()
	data, err := os.ReadFile("testdata/rows-schema.json")
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestParseRowsGood(t *testing.T) {
	s, err := Parse(encode(t, goodRows(t)))
	if err != nil {
		t.Fatal(err)
	}
	skills := s.Fields["skills"]
	if len(skills.Rows) != 3 || skills.Rows[0].Formulas["base"] != "@dex_mod" {
		t.Errorf("строки: %+v", skills.Rows)
	}
	if s.Fields["fails"].Max != 3 || s.Layout[2].Bind["slots"] != "slots" {
		t.Errorf("шкала или привязка не разобраны: %+v %+v", s.Fields["fails"], s.Layout[2])
	}
}

func TestParseRowsRejects(t *testing.T) {
	field := func(m map[string]any, id string) map[string]any {
		return m["fields"].(map[string]any)[id].(map[string]any)
	}
	column := func(m map[string]any, id string, i int) map[string]any {
		return field(m, id)["columns"].([]any)[i].(map[string]any)
	}
	section := func(m map[string]any, i int) map[string]any {
		return m["layout"].([]any)[i].(map[string]any)
	}
	cases := map[string]func(m map[string]any){
		"владение без levels":     func(m map[string]any) { delete(column(m, "skills", 0), "levels") },
		"владение из 4 состояний": func(m map[string]any) { column(m, "skills", 0)["levels"] = 4 },
		"флажок в числе":          func(m map[string]any) { column(m, "skills", 0)["levels"] = 2 },
		"тройка в флажке":         func(m map[string]any) { column(m, "saves", 0)["levels"] = 3 },
		"levels у числа":          func(m map[string]any) { field(m, "dex")["levels"] = 2 },
		"шкала без max":           func(m map[string]any) { delete(field(m, "fails"), "max") },
		"шкала на 99":             func(m map[string]any) { field(m, "fails")["max"] = 99 },
		"шкала не в число":        func(m map[string]any) { field(m, "fails")["path"] = "info.class" },
		"кривой тон":              func(m map[string]any) { field(m, "fails")["tone"] = "loud" },
		"signed у шкалы":          func(m map[string]any) { field(m, "fails")["signed"] = true },
		"max у числа":             func(m map[string]any) { field(m, "dex")["max"] = 3 },
		"счётчик не в строку":     func(m map[string]any) { column(m, "slots", 0)["path"] = "{key}.x" },
		"счётчик в число":         func(m map[string]any) { field(m, "slots")["path"] = "combat" },
		"путь без ключа":          func(m map[string]any) { column(m, "skills", 0)["path"] = "acrobatics" },
		"путь в никуда":           func(m map[string]any) { field(m, "slots")["rows"].([]any)[0].(map[string]any)["key"] = "x" },
		"ключ дважды": func(m map[string]any) {
			field(m, "saves")["rows"] = []any{map[string]any{"key": "a", "label": "A"}, map[string]any{"key": "a", "label": "B"}}
		},
		"кривой ключ":          func(m map[string]any) { field(m, "saves")["rows"].([]any)[0].(map[string]any)["key"] = "a.b" },
		"строка без подписи":   func(m map[string]any) { field(m, "saves")["rows"].([]any)[0].(map[string]any)["label"] = "" },
		"rows у числа":         func(m map[string]any) { field(m, "dex")["rows"] = []any{map[string]any{"key": "a", "label": "A"}} },
		"rows вместо statRows": func(m map[string]any) { field(m, "saves")["statRows"] = map[string]any{"name": "on", "value": "on"} },
		"rows на строку":       func(m map[string]any) { field(m, "saves")["path"] = "info.class" },
		"формула строки не колонке": func(m map[string]any) {
			field(m, "skills")["rows"].([]any)[0].(map[string]any)["formulas"] = map[string]any{"nope": "1"}
		},
		"формула строки в число": func(m map[string]any) {
			field(m, "skills")["rows"].([]any)[0].(map[string]any)["formulas"] = map[string]any{"level": "1"}
		},
		"битая формула строки": func(m map[string]any) {
			field(m, "skills")["rows"].([]any)[1].(map[string]any)["formulas"] = map[string]any{"base": "@dex_mod +"}
		},
		"цикл из формулы строки": func(m map[string]any) {
			field(m, "skills")["rows"].([]any)[1].(map[string]any)["formulas"] = map[string]any{"base": "@bonus"}
		},
		"формула строки в никуда": func(m map[string]any) {
			field(m, "skills")["rows"].([]any)[0].(map[string]any)["formulas"] = map[string]any{"base": "@combat.shield"}
		},
		"bind у другого виджета": func(m map[string]any) {
			section(m, 0)["widget"] = "hp"
			delete(section(m, 0), "fields")
			section(m, 0)["bind"] = map[string]any{"a": "b"}
		},
		"spellbook без заклинаний": func(m map[string]any) {
			section(m, 2)["bind"] = map[string]any{"slots": "slots"}
		},
		"spellbook без привязки": func(m map[string]any) { delete(section(m, 2), "bind") },
		"чужая роль":             func(m map[string]any) { section(m, 2)["bind"].(map[string]any)["colour"] = "dex" },
		"заклинания не таблица":  func(m map[string]any) { section(m, 2)["bind"].(map[string]any)["spells"] = "dex" },
		"заклинания без колонок": func(m map[string]any) { section(m, 2)["bind"].(map[string]any)["spells"] = "saves" },
		"ячейки без rows":        func(m map[string]any) { section(m, 2)["bind"].(map[string]any)["slots"] = "prepared" },
		"модификатор не числом":  func(m map[string]any) { section(m, 2)["bind"].(map[string]any)["modifier"] = "prepared" },
		"привязка в никуда":      func(m map[string]any) { section(m, 2)["bind"].(map[string]any)["level"] = "nope" },
		"spellbook у существа":   func(m map[string]any) { m["kind"] = "monster" },
	}
	for name, fn := range cases {
		m := goodRows(t)
		fn(m)
		if _, err := Parse(encode(t, m)); err == nil {
			t.Errorf("%s: ожидали ошибку", name)
		}
	}
}
