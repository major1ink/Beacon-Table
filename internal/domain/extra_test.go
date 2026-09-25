package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestExtraKeysSurvive(t *testing.T) {
	in := `{"id":"m1","name":"Совомедведь","ac":13,"Name":"дубль в другом регистре",` +
		`"stats":{"сила":14,"мощь":[1,2]},"zzz":true,"aaa":null}`
	var m Monster
	if err := json.Unmarshal([]byte(in), &m); err != nil {
		t.Fatal(err)
	}
	if m.Name != "дубль в другом регистре" || m.AC != 13 {
		t.Fatalf("известные поля: %+v", m)
	}
	if len(m.Extra) != 3 || string(m.Extra["stats"]) != `{"сила":14,"мощь":[1,2]}` {
		t.Fatalf("незнакомые ключи: %v", m.Extra)
	}
	out, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	// Известные поля — в своём порядке, незнакомые — следом по алфавиту.
	if !strings.HasPrefix(s, `{"id":"m1","name":"дубль в другом регистре"`) ||
		!strings.HasSuffix(s, `,"aaa":null,"stats":{"сила":14,"мощь":[1,2]},"zzz":true}`) ||
		strings.Count(s, `"name"`) != 1 || strings.Contains(s, `"Name"`) {
		t.Fatalf("запись: %s", s)
	}
	// И через указатель, и после второго круга — то же самое.
	again, _ := json.Marshal(&m)
	var m2 Monster
	_ = json.Unmarshal(again, &m2)
	if third, _ := json.Marshal(m2); string(third) != s {
		t.Fatalf("второй круг разошёлся:\n%s\n%s", s, third)
	}
}

func TestExtraOnSheetKeepsDefaults(t *testing.T) {
	// Лист читается ПОВЕРХ листа по умолчанию (см. sqlite.decodeSheet):
	// незнакомый ключ не должен сбивать это поведение.
	sheet := DefaultCharacterSheet()
	if err := json.Unmarshal([]byte(`{"info":{"level":3},"sanity":{"value":60,"max":99}}`), &sheet); err != nil {
		t.Fatal(err)
	}
	if sheet.Info.Level != 3 || sheet.Abilities.Str != 10 {
		t.Fatalf("известные поля: %+v %+v", sheet.Info, sheet.Abilities)
	}
	out, _ := json.Marshal(sheet)
	if !strings.HasSuffix(string(out), `,"sanity":{"value":60,"max":99}}`) {
		t.Fatalf("незнакомый ключ листа потерян: %s", out)
	}
}

func TestExtraEmptyAndBroken(t *testing.T) {
	var c Condition
	if err := json.Unmarshal([]byte(`{"name":"Горит"}`), &c); err != nil || c.Extra != nil {
		t.Fatalf("без лишних ключей Extra пуст: %v %v", c.Extra, err)
	}
	c.Extra = Extra{"bad": json.RawMessage("{не json"), "slug": json.RawMessage(`"подмена"`)}
	c.Slug = "burning"
	out, err := json.Marshal(c)
	if err != nil || !strings.Contains(string(out), `"bad":null`) || !strings.Contains(string(out), `"slug":"burning"`) || strings.Contains(string(out), "подмена") {
		t.Fatalf("битое значение и совпадение с известным полем: %s %v", out, err)
	}
	if err := json.Unmarshal([]byte(`{"name":1}`), &c); err == nil {
		t.Fatal("неверный тип известного поля — ошибка, как и раньше")
	}
}
