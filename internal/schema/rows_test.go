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
		"levels у числа":          func(m map[string]any) { field(m, "dex")["levels"] = 2 },
		"шкала без max":           func(m map[string]any) { delete(field(m, "fails"), "max") },
		"шкала на 99":             func(m map[string]any) { field(m, "fails")["max"] = 99 },
		"кривой тон":              func(m map[string]any) { field(m, "fails")["tone"] = "loud" },
		"roll у текста":           func(m map[string]any) { field(m, "dex")["type"] = "text"; field(m, "dex")["roll"] = "1d20" },
		"битый бросок у числа":    func(m map[string]any) { field(m, "dex")["roll"] = "1d20 +" },
		"бросок у числа в никуда": func(m map[string]any) { field(m, "dex")["roll"] = "1d20 + @stats.0.shield" },
		"rollable не в колонке":   func(m map[string]any) { field(m, "dex")["type"] = "text"; field(m, "dex")["rollable"] = "check" },
		"rollable у числа":        func(m map[string]any) { column(m, "prepared", 1)["rollable"] = "check" },
		"кривой rollable":         func(m map[string]any) { column(m, "prepared", 0)["rollable"] = "always" },
		"xp без привязки":         func(m map[string]any) { m["layout"] = append(m["layout"].([]any), map[string]any{"widget": "xp"}) },
		"xp не в число": func(m map[string]any) {
			m["layout"] = append(m["layout"].([]any), map[string]any{"widget": "xp", "bind": map[string]any{"xp": "prof"}})
		},
		"ability не select": func(m map[string]any) { section(m, 2)["bind"].(map[string]any)["ability"] = "dex" },
		"signed у шкалы":    func(m map[string]any) { field(m, "fails")["signed"] = true },
		"max у числа":       func(m map[string]any) { field(m, "dex")["max"] = 3 },
		"счётчик в число":   func(m map[string]any) { field(m, "slots")["path"] = "combat" },
		"путь без ключа":    func(m map[string]any) { column(m, "skills", 0)["path"] = "acrobatics" },
		"ключ дважды": func(m map[string]any) {
			field(m, "saves")["rows"] = []any{map[string]any{"key": "a", "label": "A"}, map[string]any{"key": "a", "label": "B"}}
		},
		"кривой ключ":          func(m map[string]any) { field(m, "saves")["rows"].([]any)[0].(map[string]any)["key"] = "a.b" },
		"строка без подписи":   func(m map[string]any) { field(m, "saves")["rows"].([]any)[0].(map[string]any)["label"] = "" },
		"rows у числа":         func(m map[string]any) { field(m, "dex")["rows"] = []any{map[string]any{"key": "a", "label": "A"}} },
		"rows вместо statRows": func(m map[string]any) { field(m, "saves")["statRows"] = map[string]any{"name": "on", "value": "on"} },
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
			field(m, "skills")["rows"].([]any)[0].(map[string]any)["formulas"] = map[string]any{"base": "@stats.0.shield"}
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

func TestParseSelectFormulas(t *testing.T) {
	m := goodRows(t)
	fields := m["fields"].(map[string]any)
	fields["ability"] = map[string]any{"type": "select", "path": "spellcasting.ability", "label": "Характеристика", "options": []any{
		map[string]any{"value": "dex", "label": "Ловкость", "formula": "@dex_mod"},
		map[string]any{"value": "none", "label": "Нет"},
	}}
	fields["dc"] = map[string]any{"type": "computed", "label": "СЛ", "formula": "8 + @prof + @ability", "roll": "1d20 + @dc", "signed": true}
	m["layout"].([]any)[2].(map[string]any)["bind"].(map[string]any)["ability"] = "ability"
	if _, err := Parse(encode(t, m)); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(){
		"битая формула варианта": func() {
			fields["ability"].(map[string]any)["options"].([]any)[0].(map[string]any)["formula"] = "@dex_mod +"
		},
		"цикл через вариант": func() { fields["ability"].(map[string]any)["options"].([]any)[0].(map[string]any)["formula"] = "@dc" },
		"вариант в никуда": func() {
			fields["ability"].(map[string]any)["options"].([]any)[0].(map[string]any)["formula"] = "@stats.0.shield"
		},
	} {
		bad := goodRows(t)
		bf := bad["fields"].(map[string]any)
		bf["ability"] = map[string]any{"type": "select", "path": "spellcasting.ability", "label": "X", "options": []any{map[string]any{"value": "dex", "label": "Л"}}}
		bf["dc"] = map[string]any{"type": "computed", "label": "СЛ", "formula": "8 + @ability"}
		fields = bf
		mutate()
		if _, err := Parse(encode(t, bad)); err == nil {
			t.Errorf("%s: ожидали ошибку", name)
		}
	}
}

func goodCard() map[string]any {
	return map[string]any{
		"format": Format,
		"kind":   "monster",
		"fields": map[string]any{
			"ac":   map[string]any{"type": "number", "path": "ac", "label": "КД"},
			"note": map[string]any{"type": "text", "path": "acNote", "label": "Пометка", "facet": "beforeParen", "suggest": map[string]any{"reference": "класс", "parentField": "kind"}},
			"kind": map[string]any{"type": "text", "path": "type", "label": "Тип"},
			"cr": map[string]any{"type": "select", "path": "cr", "label": "ПО", "options": []any{
				map[string]any{"value": "1", "label": "1", "glyph": "flame", "color": "#f00"},
			}},
			"boss":    map[string]any{"type": "bool", "path": "summonable", "label": "Призыв"},
			"ac_line": map[string]any{"type": "template", "label": "Класс доспеха", "template": "{ac}[ ({note})]"},
			"str":     map[string]any{"type": "number", "path": "abilities.str", "label": "Сила", "short": "Сил"},
			"str_mod": map[string]any{"type": "computed", "label": "Мод.", "formula": "floor((@str - 10) / 2)"},
		},
		"layout": []any{
			map[string]any{"title": "Бой", "fields": []any{"ac_line"}},
			map[string]any{"cells": []any{[]any{"str", "str_mod"}}},
		},
		"list": map[string]any{
			"subtitle":   "{ac_line}",
			"badges":     []any{"cr"},
			"flags":      []any{map[string]any{"field": "boss", "mark": "П", "title": "Призыв"}},
			"medallion":  map[string]any{"field": "cr"},
			"categories": map[string]any{"field": "kind", "other": "Прочее", "rules": []any{map[string]any{"label": "Нежить", "contains": []any{"нежить"}}}},
		},
	}
}

func TestParseCardExtras(t *testing.T) {
	good := goodCard()
	good["fields"].(map[string]any)["lvl"] = map[string]any{"type": "select", "path": "hp", "label": "Круг", "numeric": true, "options": []any{
		map[string]any{"value": "0", "label": "Заговор"}, map[string]any{"value": "1", "label": "1-й круг"},
	}}
	good["list"].(map[string]any)["pills"] = []any{"lvl", "boss"}
	if _, err := Parse(encode(t, good)); err != nil {
		t.Fatal(err)
	}
	field := func(m map[string]any, id string) map[string]any {
		return m["fields"].(map[string]any)[id].(map[string]any)
	}
	list := func(m map[string]any) map[string]any { return m["list"].(map[string]any) }
	layout := func(m map[string]any, i int) map[string]any { return m["layout"].([]any)[i].(map[string]any) }
	cases := map[string]func(m map[string]any){
		"шаблон без template": func(m map[string]any) { delete(field(m, "ac_line"), "template") },
		"template у числа":    func(m map[string]any) { field(m, "ac")["template"] = "{ac}" },
		"шаблон в шаблон": func(m map[string]any) {
			field(m, "ac")["type"] = "template"
			delete(field(m, "ac"), "path")
			field(m, "ac")["template"] = "{ac_line}"
		},
		"шаблон в никуда":  func(m map[string]any) { field(m, "ac_line")["template"] = "{nope}" },
		"facet у числа":    func(m map[string]any) { field(m, "ac")["facet"] = "beforeParen" },
		"кривой facet":     func(m map[string]any) { field(m, "note")["facet"] = "first" },
		"suggest у числа":  func(m map[string]any) { field(m, "ac")["suggest"] = map[string]any{"reference": "класс"} },
		"suggest без вида": func(m map[string]any) { field(m, "note")["suggest"] = map[string]any{} },
		"suggest на чужого": func(m map[string]any) {
			field(m, "note")["suggest"] = map[string]any{"reference": "класс", "parentField": "ac"}
		},
		"пустая плитка":   func(m map[string]any) { layout(m, 1)["cells"] = []any{[]any{}} },
		"плитка из пяти":  func(m map[string]any) { layout(m, 1)["cells"] = []any{[]any{"str", "str", "str", "str", "str"}} },
		"плитка в никуда": func(m map[string]any) { layout(m, 1)["cells"] = []any{[]any{"nope"}} },
		"плитка и поля":   func(m map[string]any) { layout(m, 1)["fields"] = []any{"ac"} },
		"плашка в никуда": func(m map[string]any) { list(m)["badges"] = []any{"nope"} },
		"буква не булева": func(m map[string]any) { list(m)["flags"] = []any{map[string]any{"field": "ac", "mark": "П"}} },
		"длинная буква": func(m map[string]any) {
			list(m)["flags"] = []any{map[string]any{"field": "boss", "mark": "Призыв"}}
		},
		"медальон выбор с правилами": func(m map[string]any) {
			list(m)["medallion"].(map[string]any)["rules"] = []any{map[string]any{"contains": []any{"x"}}}
		},
		"медальон текст без правил": func(m map[string]any) { list(m)["medallion"] = map[string]any{"field": "kind"} },
		"медальон в никуда":         func(m map[string]any) { list(m)["medallion"] = map[string]any{"field": "nope"} },
		"категории без правил":      func(m map[string]any) { list(m)["categories"].(map[string]any)["rules"] = []any{} },
		"категория без подписи": func(m map[string]any) {
			list(m)["categories"].(map[string]any)["rules"] = []any{map[string]any{"contains": []any{"x"}}}
		},
		"правило без подстрок": func(m map[string]any) {
			list(m)["categories"].(map[string]any)["rules"] = []any{map[string]any{"label": "Х"}}
		},
		"numeric у числа": func(m map[string]any) { field(m, "ac")["numeric"] = true },
		"numeric на строке": func(m map[string]any) {
			field(m, "cr")["path"] = "speed"
			field(m, "cr")["numeric"] = true
		},
		"numeric не число": func(m map[string]any) {
			field(m, "cr")["path"] = "hp"
			field(m, "cr")["numeric"] = true
			field(m, "cr")["options"] = []any{map[string]any{"value": "abc", "label": "abc"}}
		},
		"плашка шапки в никуда": func(m map[string]any) { list(m)["pills"] = []any{"nope"} },
		"категории по числу":    func(m map[string]any) { list(m)["categories"].(map[string]any)["field"] = "ac" },
	}
	for name, fn := range cases {
		m := goodCard()
		fn(m)
		if _, err := Parse(encode(t, m)); err == nil {
			t.Errorf("%s: ожидали ошибку", name)
		}
	}
}
