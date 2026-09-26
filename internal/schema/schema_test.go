package schema

import (
	"encoding/json"
	"strings"
	"testing"
)

// Встроенные схемы «Своей системы» проходят ту же проверку, что и схемы
// модулей, и описывают все поля нынешнего универсального листа.
func TestBuiltinSchemasValid(t *testing.T) {
	for _, k := range Kinds {
		s, err := Builtin(k)
		if err != nil {
			t.Fatalf("%s: %v", k, err)
		}
		if len(s.Raw) == 0 {
			t.Errorf("%s: нет исходного JSON для клиента", k)
		}
	}
	sheet, _ := Builtin(KindSheet)
	paths := map[string]bool{}
	for _, f := range sheet.Fields {
		paths[f.Path] = true
	}
	for _, p := range []string{"combat.hpCurrent", "combat.hpMax", "combat.hpTemp", "combat.ac", "combat.speed", "initiative", "stats", "rolls", "features", "notes.0"} {
		if !paths[p] {
			t.Errorf("универсальный лист: нет поля с путём %s", p)
		}
	}
	for _, target := range []string{"hp.current", "hp.max", "ac", "speed", "initiative"} {
		if sheet.Core[target] == "" {
			t.Errorf("универсальный лист: core.%s не привязан", target)
		}
	}
	widgets := map[string]bool{}
	for _, sec := range sheet.Layout {
		widgets[sec.Widget] = true
	}
	for _, w := range []string{"hp", "statuses", "resources", "inventory", "money"} {
		if !widgets[w] {
			t.Errorf("универсальный лист: нет виджета %s", w)
		}
	}
}

// good — минимальная годная схема листа; каждый плохой случай портит в ней
// одно место.
func good() map[string]any {
	return map[string]any{
		"format": Format,
		"kind":   "sheet",
		"core":   map[string]any{"ac": "ac"},
		"fields": map[string]any{
			"ac":      map[string]any{"type": "number", "path": "combat.ac", "label": "Защита"},
			"str":     map[string]any{"type": "number", "path": "abilities.str", "label": "Сила", "modifierTarget": "abilities.str"},
			"str_mod": map[string]any{"type": "computed", "label": "Мод.", "formula": "floor((@str-10)/2)"},
			"luck":    map[string]any{"type": "number", "path": "luck", "label": "Удача"},
			"deep":    map[string]any{"type": "text", "path": "homebrew.deep.key", "label": "Глубоко"},
			"school": map[string]any{"type": "select", "path": "school", "label": "Школа", "options": []any{
				map[string]any{"value": "fire", "label": "Огонь", "color": "#f00", "glyph": "flame"},
			}},
			"res": map[string]any{"type": "table", "path": "resources", "label": "Ресурсы", "columns": []any{
				map[string]any{"id": "name", "type": "text", "path": "name", "label": "Название"},
				map[string]any{"id": "max", "type": "number", "path": "max", "label": "Макс."},
			}},
			"hit": map[string]any{"type": "roll", "label": "Удар", "roll": "1d20 + @str_mod"},
		},
		"layout": []any{
			map[string]any{"title": "Бой", "fields": []any{"ac", "str", "str_mod"}, "column": 1, "tab": "sheet"},
			map[string]any{"widget": "hp", "mode": "view"},
		},
	}
}

func encode(t *testing.T, v any) []byte {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestParseGood(t *testing.T) {
	s, err := Parse(encode(t, good()))
	if err != nil {
		t.Fatal(err)
	}
	if s.Fields["str"].ModifierTarget != "abilities.str" || len(s.Fields["res"].Columns) != 2 {
		t.Errorf("разобрано: %+v", s.Fields)
	}
	// Незнакомые серверу ключи поля уезжают клиенту в Raw как есть.
	withExtra := good()
	withExtra["fields"].(map[string]any)["ac"].(map[string]any)["placeholder"] = "10"
	s, err = Parse(encode(t, withExtra))
	if err != nil || !strings.Contains(string(s.Raw), `"placeholder":"10"`) {
		t.Errorf("Raw без незнакомого ключа: %v %s", err, s.Raw)
	}
}

func TestParseRejects(t *testing.T) {
	type spoil func(m map[string]any)
	field := func(m map[string]any, id string) map[string]any {
		return m["fields"].(map[string]any)[id].(map[string]any)
	}
	cases := map[string]spoil{
		"чужой формат":    func(m map[string]any) { m["format"] = "beacon-schema/v9" },
		"неизвестный вид": func(m map[string]any) { m["kind"] = "vehicle" },
		"нет полей":       func(m map[string]any) { m["fields"] = map[string]any{} },
		"кривой id": func(m map[string]any) {
			m["fields"].(map[string]any)["Bad Id"] = map[string]any{"type": "text", "path": "x", "label": "X"}
		},
		"неизвестный тип":      func(m map[string]any) { field(m, "ac")["type"] = "slider" },
		"нет подписи":          func(m map[string]any) { field(m, "ac")["label"] = " " },
		"без path":             func(m map[string]any) { delete(field(m, "ac"), "path") },
		"path у вычисления":    func(m map[string]any) { field(m, "str_mod")["path"] = "x" },
		"нет формулы":          func(m map[string]any) { delete(field(m, "str_mod"), "formula") },
		"нет броска":           func(m map[string]any) { delete(field(m, "hit"), "roll") },
		"внутрь combat":        func(m map[string]any) { field(m, "ac")["path"] = "combat.shield" },
		"внутрь числа":         func(m map[string]any) { field(m, "ac")["path"] = "combat.ac.value" },
		"select без вариантов": func(m map[string]any) { field(m, "school")["options"] = []any{} },
		"вариант дважды": func(m map[string]any) {
			o := map[string]any{"value": "fire", "label": "Огонь"}
			field(m, "school")["options"] = []any{o, o}
		},
		"таблица без колонок":  func(m map[string]any) { field(m, "res")["columns"] = []any{} },
		"таблица не на список": func(m map[string]any) { field(m, "res")["path"] = "combat" },
		"колонка не из строки": func(m map[string]any) {
			field(m, "res")["columns"] = []any{map[string]any{"id": "shield", "type": "text", "path": "shield", "label": "Щит"}}
		},
		"statRows мимо":      func(m map[string]any) { field(m, "res")["statRows"] = map[string]any{"name": "name", "value": "nope"} },
		"кривая цель":        func(m map[string]any) { field(m, "str")["modifierTarget"] = "Сила + 2" },
		"core не ядра":       func(m map[string]any) { m["core"] = map[string]any{"abilities.str": "str"} },
		"core в пустоту":     func(m map[string]any) { m["core"] = map[string]any{"ac": "nope"} },
		"нет раскладки":      func(m map[string]any) { m["layout"] = []any{} },
		"секция в пустоту":   func(m map[string]any) { m["layout"] = []any{map[string]any{"fields": []any{"nope"}}} },
		"поля и виджет":      func(m map[string]any) { m["layout"] = []any{map[string]any{"fields": []any{"ac"}, "widget": "hp"}} },
		"чужой виджет":       func(m map[string]any) { m["layout"] = []any{map[string]any{"widget": "applies"}} },
		"неизвестный виджет": func(m map[string]any) { m["layout"] = []any{map[string]any{"widget": "radar"}} },
		"колонка 4":          func(m map[string]any) { m["layout"] = []any{map[string]any{"fields": []any{"ac"}, "column": 4}} },
		"кривой режим":       func(m map[string]any) { m["layout"] = []any{map[string]any{"fields": []any{"ac"}, "mode": "print"}} },
		"list у листа":       func(m map[string]any) { m["list"] = map[string]any{"subtitle": "{ac}"} },
	}
	for name, fn := range cases {
		m := good()
		fn(m)
		if _, err := Parse(encode(t, m)); err == nil {
			t.Errorf("%s: ожидали ошибку", name)
		}
	}
	if _, err := Parse(make([]byte, MaxFileSize+1)); err == nil {
		t.Error("слишком большой файл должен быть ошибкой")
	}
}

func TestListRefs(t *testing.T) {
	spell := map[string]any{
		"format": Format, "kind": "spell",
		"fields": map[string]any{"level": map[string]any{"type": "number", "path": "level", "label": "Круг"}},
		"layout": []any{map[string]any{"fields": []any{"level"}}},
		"list":   map[string]any{"subtitle": "{level} круг", "sort": []any{"level", "name"}, "search": []any{"name", "tags"}},
	}
	if _, err := Parse(encode(t, spell)); err != nil {
		t.Fatal(err)
	}
	spell["list"] = map[string]any{"subtitle": "{school}"}
	if _, err := Parse(encode(t, spell)); err == nil {
		t.Error("подпись с неизвестным полем должна быть ошибкой")
	}
}
