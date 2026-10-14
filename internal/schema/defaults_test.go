package schema

import (
	"encoding/json"
	"testing"

	"beacon-table/internal/domain"
)

func monsterWith(t *testing.T, fields string) (*Schema, error) {
	t.Helper()
	return Parse([]byte(`{"format":"beacon-schema/v1","kind":"monster","fields":{` + fields + `},"layout":[{"fields":["x"]}]}`))
}

func TestDefaultValidation(t *testing.T) {
	good := map[string]string{
		"число":          `"x":{"type":"number","path":"ac","label":"КД","default":10}`,
		"текст":          `"x":{"type":"text","path":"size","label":"Размер","default":"Средний"}`,
		"вложенный ключ": `"x":{"type":"number","path":"abilities.str","label":"Сила","default":10}`,
		"выбор":          `"x":{"type":"select","path":"type","label":"Тип","default":"b","options":[{"value":"a","label":"A"},{"value":"b","label":"B"}]}`,
		"числовой выбор": `"x":{"type":"select","numeric":true,"path":"level","label":"Круг","default":0,"options":[{"value":"0","label":"0"},{"value":"1","label":"1"}]}`,
		"флажок":         `"x":{"type":"bool","path":"flag","label":"Флаг","default":true}`,
	}
	for name, f := range good {
		if _, err := monsterWith(t, f); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
	bad := map[string]string{
		"число у текста":           `"x":{"type":"text","path":"size","label":"Размер","default":5}`,
		"строка у числа":           `"x":{"type":"number","path":"ac","label":"КД","default":"10"}`,
		"нет такого варианта":      `"x":{"type":"select","path":"type","label":"Тип","default":"z","options":[{"value":"a","label":"A"}]}`,
		"число у обычного выбора":  `"x":{"type":"select","path":"type","label":"Тип","default":1,"options":[{"value":"1","label":"A"}]}`,
		"нет варианта у числового": `"x":{"type":"select","numeric":true,"path":"level","label":"Круг","default":7,"options":[{"value":"0","label":"0"}]}`,
		"вычисляемое":              `"x":{"type":"computed","label":"Мод","formula":"1","default":1}`,
		"объект":                   `"x":{"type":"text","path":"size","label":"Размер","default":{"a":1}}`,
	}
	for name, f := range bad {
		if _, err := monsterWith(t, f); err == nil {
			t.Errorf("%s: ожидали ошибку", name)
		}
	}
}

func TestApplyDefaults(t *testing.T) {
	s, err := Parse([]byte(`{"format":"beacon-schema/v1","kind":"monster","fields":{
		"ac":{"type":"number","path":"ac","label":"КД","default":10},
		"hp":{"type":"number","path":"hp","label":"Хиты"},
		"size":{"type":"text","path":"size","label":"Размер","default":"Средний"},
		"str":{"type":"number","path":"abilities.str","label":"Сила","default":10},
		"dex":{"type":"number","path":"abilities.dex","label":"Ловкость","default":10}
	},"layout":[{"fields":["ac","hp","size","str","dex"]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	m := domain.NewMonster("id", "Гоблин")
	if err := s.ApplyDefaults(m); err != nil {
		t.Fatal(err)
	}
	if m.AC != 10 || m.HP != 0 || m.Name != "Гоблин" || m.Extra.String("size") != "Средний" || string(m.Extra["abilities"]) != `{"dex":10,"str":10}` {
		t.Fatalf("значения по умолчанию: %+v %s", m, m.Extra["abilities"])
	}
	// Заполненное не трогается.
	m2 := domain.NewMonster("id2", "Волк")
	m2.AC, m2.Extra = 13, domain.Extra{"size": json.RawMessage(`"Большой"`)}
	if err := s.ApplyDefaults(m2); err != nil {
		t.Fatal(err)
	}
	if m2.AC != 13 || m2.Extra.String("size") != "Большой" || string(m2.Extra["abilities"]) != `{"dex":10,"str":10}` {
		t.Fatalf("заполненное затёрто: %+v", m2)
	}
	// Схема без default карточку не меняет.
	plain, _ := Builtin(KindMonster)
	m3 := domain.NewMonster("id3", "Тень")
	if err := plain.ApplyDefaults(m3); err != nil || m3.AC != 0 || len(m3.Extra) != 0 {
		t.Fatalf("встроенная схема: %v %+v", err, m3)
	}
}
