package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

// Старый лист с пятью монетами D&D читается и пишется без изменений: Coins
// стал словарём, а JSON остался тем же объектом.
func TestCoinsOldJSONRoundTrip(t *testing.T) {
	raw := `{"cp":1,"ep":0,"gp":25,"pp":0,"sp":3}`
	var c Coins
	if err := json.Unmarshal([]byte(raw), &c); err != nil {
		t.Fatal(err)
	}
	if c["gp"] != 25 || c["sp"] != 3 || len(c) != 5 {
		t.Fatalf("разобрано: %v", c)
	}
	out, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != raw {
		t.Fatalf("записано %s, ожидали %s", out, raw)
	}
}

func TestSanitizeCoins(t *testing.T) {
	got := SanitizeCoins(Coins{"gp": 10, "money": -5, "Bad Key": 3, "shells": 7})
	want := Coins{"gp": 10, "money": 0, "shells": 7}
	if len(got) != len(want) {
		t.Fatalf("получили %v, ожидали %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %d, ожидали %d", k, got[k], v)
		}
	}
	many := Coins{}
	for i := 0; i < MaxCurrencies+5; i++ {
		many[strings.Repeat("a", i+1)] = 1
	}
	if n := len(SanitizeCoins(many)); n != MaxCurrencies {
		t.Errorf("валют осталось %d, ожидали %d", n, MaxCurrencies)
	}
	if got := SanitizeCoins(nil); got == nil || len(got) != 0 {
		t.Errorf("пустые деньги — пустой словарь, а не nil: %v", got)
	}
}

func TestValidateCurrencies(t *testing.T) {
	if err := ValidateCurrencies(CustomCurrencies()); err != nil {
		t.Fatalf("валюты «Своей системы»: %v", err)
	}
	bad := map[string][]Currency{
		"кривой ключ": {{Key: "Gold", Label: "З"}},
		"дважды":      {{Key: "gp", Label: "ЗМ"}, {Key: "gp", Label: "ЗМ"}},
		"без подписи": {{Key: "gp", Label: " "}},
	}
	for name, list := range bad {
		if err := ValidateCurrencies(list); err == nil {
			t.Errorf("%s: ожидали ошибку", name)
		}
	}
	if err := ValidateUnits(&SystemUnits{Weight: strings.Repeat("ф", 20)}); err == nil {
		t.Error("слишком длинная единица веса должна быть ошибкой")
	}
}
