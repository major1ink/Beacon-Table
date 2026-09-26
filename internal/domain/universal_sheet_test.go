package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

// Поля универсального листа хранятся и читаются без потерь, а лист D&D, у
// которого их нет, пишется в прежнем формате — без новых ключей.
func TestUniversalSheetFieldsRoundTrip(t *testing.T) {
	mod := 2
	in := DefaultCharacterSheet()
	in.Initiative = "1d20+2"
	in.Stats = []FreeStat{{Name: "Удача", Value: 5, Mod: &mod}, {Name: "Сила", Value: 3}}
	in.Rolls = []SheetRoll{{Name: "Меч", Formula: "1d8+3"}}
	data, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	var out CharacterSheet
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	if out.Initiative != "1d20+2" || len(out.Stats) != 2 || out.Stats[0].Mod == nil || *out.Stats[0].Mod != 2 || out.Stats[1].Mod != nil || out.Rolls[0].Formula != "1d8+3" {
		t.Fatalf("прочитано: %+v", out)
	}
	if len(out.Extra) != 0 {
		t.Errorf("поля листа не должны уходить в Extra: %v", out.Extra)
	}

	plain, err := json.Marshal(DefaultCharacterSheet())
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{`"initiative"`, `"stats"`, `"rolls"`} {
		if strings.Contains(string(plain), key) {
			t.Errorf("пустой лист D&D не должен получать ключ %s", key)
		}
	}
}

// Ключ initiative, сохранённый раньше как незнакомый (Extra), читается
// полем листа — формат JSON тот же.
func TestUniversalSheetReadsOldExtraKeys(t *testing.T) {
	var s CharacterSheet
	if err := json.Unmarshal([]byte(`{"initiative":"2d6","stats":[{"name":"Воля","value":4}]}`), &s); err != nil {
		t.Fatal(err)
	}
	if s.Initiative != "2d6" || len(s.Stats) != 1 || s.Stats[0].Name != "Воля" || len(s.Extra) != 0 {
		t.Fatalf("прочитано: %+v", s)
	}
}
