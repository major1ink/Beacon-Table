package service

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"beacon-table/internal/domain"
)

// Пределы общие, а не поимённые: поле, о котором санитайзер ничего не знает
// (здесь — поля тестовой структуры), ограничено так же, как описание
// карточки.
type limitsProbe struct {
	Title  string
	Nested struct{ Text string }
	Rows   []struct{ Note string }
	Fixed  [2]string
	Ptr    *struct{ Text string }
	Names  []string
	Counts map[string]int
	hidden string
}

func TestClampCardWalksEverything(t *testing.T) {
	long := strings.Repeat("я", maxText+10)
	p := limitsProbe{Title: long, Fixed: [2]string{"ок", long}, Ptr: &struct{ Text string }{long}, Counts: map[string]int{"a": 1}, hidden: long}
	p.Nested.Text = long
	for i := 0; i < maxRows+5; i++ {
		p.Rows = append(p.Rows, struct{ Note string }{long})
		p.Names = append(p.Names, long)
	}
	clampCard(&p)

	n := func(s string) int { return len([]rune(s)) }
	if n(p.Title) != maxText || n(p.Nested.Text) != maxText || n(p.Fixed[1]) != maxText || n(p.Ptr.Text) != maxText {
		t.Errorf("строки не обрезаны: %d %d %d %d", n(p.Title), n(p.Nested.Text), n(p.Fixed[1]), n(p.Ptr.Text))
	}
	if p.Fixed[0] != "ок" {
		t.Errorf("короткая строка испорчена: %q", p.Fixed[0])
	}
	if len(p.Rows) != maxRows || len(p.Names) != maxRows {
		t.Errorf("списки: %d и %d, ожидали %d", len(p.Rows), len(p.Names), maxRows)
	}
	if n(p.Rows[0].Note) != maxText || n(p.Names[maxRows-1]) != maxText {
		t.Error("строки внутри списков не обрезаны")
	}
	if p.Counts["a"] != 1 || n(p.hidden) != maxText+10 {
		t.Error("словари и неэкспортируемые поля трогать не должны")
	}
}

func TestClampExtra(t *testing.T) {
	e := domain.Extra{
		"ok":                    json.RawMessage(`1`),
		strings.Repeat("k", 65): json.RawMessage(`1`),
		"huge":                  json.RawMessage(`"` + strings.Repeat("x", maxExtraValue) + `"`),
		"stats":                 json.RawMessage(`{"str":10}`),
	}
	got := clampExtra(e)
	if len(got) != 2 || got["ok"] == nil || got["stats"] == nil {
		t.Fatalf("осталось %d ключей: %v", len(got), keysOf(got))
	}
	many := domain.Extra{}
	for i := 0; i < maxExtraKeys+10; i++ {
		many[fmt.Sprintf("k%03d", i)] = json.RawMessage(`1`)
	}
	got = clampExtra(many)
	if len(got) != maxExtraKeys || got["k000"] == nil || got[fmt.Sprintf("k%03d", maxExtraKeys)] != nil {
		t.Errorf("лишние ключи: осталось %d, ожидали первые %d по алфавиту", len(got), maxExtraKeys)
	}
}

func keysOf(e domain.Extra) []string {
	out := make([]string, 0, len(e))
	for k := range e {
		out = append(out, k)
	}
	return out
}

// Правила D&D ушли из санитайзеров — остались санитарные пределы.
func TestSanitizersWithoutDnDRanges(t *testing.T) {
	sp := sanitizeSpell(domain.Spell{Level: 12})
	if sp.Level != 12 {
		t.Errorf("уровень заклинания 12 — не мусор, а система с другими уровнями: %d", sp.Level)
	}
	if got := sanitizeSpell(domain.Spell{Level: 500}).Level; got != maxLevel {
		t.Errorf("уровень 500 → %d, ожидали %d", got, maxLevel)
	}
	if got := sanitizeSpell(domain.Spell{Level: -1}).Level; got != 0 {
		t.Errorf("уровень -1 → %d", got)
	}
	m := sanitizeMonster(domain.Monster{Size: strings.Repeat("о", 1000), Spells: []domain.MonsterSpellRef{{Name: " Щит ", Level: 15}}})
	if len([]rune(m.Size)) != 1000 {
		t.Errorf("«короткие» поля больше не режутся на 300: %d", len([]rune(m.Size)))
	}
	if m.Spells[0].Level != 15 || m.Spells[0].Name != "Щит" {
		t.Errorf("заклинание статблока: %+v", m.Spells[0])
	}
	sheet := domain.DefaultCharacterSheet()
	sheet.Combat.DeathSaveFail = 5
	sheet.Combat.Exhaustion = 50
	got := sanitizeSheet(sheet)
	if got.Combat.DeathSaveFail != 5 || got.Combat.Exhaustion != maxSheetExhaustion {
		t.Errorf("счётчики листа: спасброски %d, истощение %d", got.Combat.DeathSaveFail, got.Combat.Exhaustion)
	}
}

// Незнакомые ключи карточки проходят через санитайзер (блок 2), но в
// пределах clampExtra.
func TestSanitizersKeepBoundedExtra(t *testing.T) {
	it := domain.Item{Extra: domain.Extra{"bulk": json.RawMessage(`3`), strings.Repeat("z", 100): json.RawMessage(`1`)}}
	got := sanitizeItem(it)
	if len(got.Extra) != 1 || string(got.Extra["bulk"]) != "3" {
		t.Errorf("Extra предмета: %v", keysOf(got.Extra))
	}
}
