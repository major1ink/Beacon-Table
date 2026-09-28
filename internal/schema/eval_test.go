package schema

import (
	"encoding/json"
	"errors"
	"os"
	"testing"

	"beacon-table/internal/domain"
	"beacon-table/internal/formula"
)

// Общие случаи testdata/eval-cases.json гоняет и клиент
// (web/test/schema-formula.test.js: createEvaluator); rowValues (колонки
// таблиц) — только клиент: сервер строки таблиц пока не считает.
type evalCase struct {
	Name   string             `json:"name"`
	Schema *Schema            `json:"schema"`
	Data   any                `json:"data"`
	Mods   []domain.Modifier  `json:"mods"`
	Values map[string]float64 `json:"values"`
	Errors map[string]string  `json:"errors"`
	Rolls  []struct {
		Src   string `json:"src"`
		Roll  string `json:"roll"`
		Error string `json:"error"`
	} `json:"rolls"`
	Static string `json:"static"`
}

func errCode(err error) string {
	var fe *formula.Error
	if errors.As(err, &fe) {
		return fe.Code
	}
	if err != nil {
		return "другая: " + err.Error()
	}
	return ""
}

func TestSharedEvalCases(t *testing.T) {
	data, err := os.ReadFile("testdata/eval-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Cases []evalCase `json:"cases"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}
	for _, c := range file.Cases {
		ev := NewEvaluator(c.Schema, c.Data, c.Mods)
		for id, want := range c.Values {
			if got, err := ev.Value(id); err != nil || got != want {
				t.Errorf("%s: %s = %v (%v), ждали %v", c.Name, id, got, err, want)
			}
		}
		for id, want := range c.Errors {
			if _, err := ev.Value(id); errCode(err) != want {
				t.Errorf("%s: %s — ошибка %q (%v), ждали %s", c.Name, id, errCode(err), err, want)
			}
		}
		for _, r := range c.Rolls {
			got, err := ev.Dice(r.Src)
			if r.Error != "" {
				if errCode(err) != r.Error {
					t.Errorf("%s: бросок %q — ошибка %q, ждали %s", c.Name, r.Src, errCode(err), r.Error)
				}
				continue
			}
			if err != nil || got.Formula != r.Roll {
				t.Errorf("%s: бросок %q = %q (%v), ждали %q", c.Name, r.Src, got.Formula, err, r.Roll)
			}
		}
		if c.Schema != nil {
			if got := errCode(c.Schema.checkFormulas(nil)); got != c.Static {
				t.Errorf("%s: проверка формул — %q, ждали %q", c.Name, got, c.Static)
			}
		}
	}
}

// Значения запоминаются на весь расчёт, а ошибка цикла не зависит от того,
// с какого поля начали.
func TestEvaluatorCycleFromAnyField(t *testing.T) {
	s := &Schema{Fields: map[string]*Field{
		"a": {Type: TypeComputed, Formula: "@b", Label: "a"},
		"b": {Type: TypeComputed, Formula: "@a", Label: "b"},
		"c": {Type: TypeComputed, Formula: "@b", Label: "c"},
	}}
	for _, order := range [][]string{{"a", "b", "c"}, {"c", "b", "a"}, {"b", "c", "a"}} {
		ev := NewEvaluator(s, nil, nil)
		got := map[string]string{}
		for _, id := range order {
			_, err := ev.Value(id)
			got[id] = errCode(err)
		}
		if got["a"] != formula.CodeCycle || got["b"] != formula.CodeCycle || got["c"] != formula.CodeRefError {
			t.Errorf("порядок %v: %v", order, got)
		}
	}
}
