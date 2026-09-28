package formula

import (
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
)

// Общие случаи testdata/cases.json гоняет и клиент
// (web/test/schema-formula.test.js): так две реализации языка не
// расходятся.
type sharedCase struct {
	Src   string             `json:"src"`
	Vars  map[string]float64 `json:"vars"`
	Value *float64           `json:"value"`
	Roll  *string            `json:"roll"`
	Dice  int                `json:"dice"`
	Const int                `json:"const"`
	Error string             `json:"error"`
	Pos   int                `json:"pos"`
}

func loadCases(t *testing.T) (expr, dice []sharedCase) {
	t.Helper()
	data, err := os.ReadFile("testdata/cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var all struct {
		Expr []sharedCase `json:"expr"`
		Dice []sharedCase `json:"dice"`
	}
	if err := json.Unmarshal(data, &all); err != nil {
		t.Fatal(err)
	}
	return all.Expr, all.Dice
}

func varsResolver(vars map[string]float64) Resolver {
	return func(name string) (float64, error) {
		v, ok := vars[name]
		if !ok {
			return 0, &Error{Code: CodeNotNumber, Detail: name}
		}
		return v, nil
	}
}

func checkErr(t *testing.T, c sharedCase, err error) {
	t.Helper()
	var fe *Error
	if !errors.As(err, &fe) {
		t.Fatalf("%q: ждали ошибку %s, получили %v", c.Src, c.Error, err)
	}
	if fe.Code != c.Error || (c.Pos != 0 && fe.Pos != c.Pos) {
		t.Fatalf("%q: ошибка %s в символе %d (%v), ждали %s в %d", c.Src, fe.Code, fe.Pos, fe, c.Error, c.Pos)
	}
}

func TestSharedExprCases(t *testing.T) {
	cases, _ := loadCases(t)
	for _, c := range cases {
		e, err := Parse(c.Src, false)
		var v float64
		if err == nil {
			v, err = e.Eval(varsResolver(c.Vars))
		}
		if c.Error != "" {
			checkErr(t, c, err)
			continue
		}
		if err != nil {
			t.Fatalf("%q: %v", c.Src, err)
		}
		if c.Value == nil || v != *c.Value {
			t.Fatalf("%q = %v, ждали %v", c.Src, v, c.Value)
		}
	}
}

func TestSharedDiceCases(t *testing.T) {
	_, cases := loadCases(t)
	for _, c := range cases {
		e, err := Parse(c.Src, true)
		var r Roll
		if err == nil {
			r, err = e.Dice(varsResolver(c.Vars))
		}
		if c.Error != "" {
			checkErr(t, c, err)
			continue
		}
		if err != nil {
			t.Fatalf("%q: %v", c.Src, err)
		}
		if c.Roll == nil || r.Formula != *c.Roll || r.Dice != c.Dice || r.Const != c.Const {
			t.Fatalf("%q = %+v, ждали %v (кубов %d, константа %d)", c.Src, r, c.Roll, c.Dice, c.Const)
		}
	}
}

func TestTooLong(t *testing.T) {
	_, err := Parse(strings.Repeat("1+", MaxLen/2)+"1", false)
	var fe *Error
	if !errors.As(err, &fe) || fe.Code != CodeTooLong {
		t.Fatalf("длинная формула: %v", err)
	}
	if _, err := Parse(strings.Repeat("1+", MaxLen/2-1)+"1", false); err != nil {
		t.Fatalf("формула в пределе: %v", err)
	}
}

func TestRefs(t *testing.T) {
	e, err := Parse("@a + @stat.сила * @a + @combat.hpMax", false)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := e.Refs(), []string{"a", "stat.сила", "combat.hpMax"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("ссылки %v, ждали %v", got, want)
	}
}

func TestErrorMessages(t *testing.T) {
	_, err := Parse("flor(2)", false)
	if err == nil || err.Error() != "неизвестная функция «flor» (символ 1)" {
		t.Fatalf("сообщение: %v", err)
	}
	_, err = Parse("1 +", false)
	if err == nil || err.Error() != "формула оборвалась (символ 4)" {
		t.Fatalf("сообщение: %v", err)
	}
}
