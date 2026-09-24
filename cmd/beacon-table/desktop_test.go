//go:build desktop

package main

import "testing"

func TestServerURL(t *testing.T) {
	ok := map[string]string{
		"table.example.ru":               "https://table.example.ru",
		"  https://table.example.ru/  ":  "https://table.example.ru/",
		"http://192.168.1.5:8080":        "http://192.168.1.5:8080",
		"https://demo.beacontable.ru/dm": "https://demo.beacontable.ru/dm",
		"стол.рф":                        "https://стол.рф",
		"localhost:8080":                 "https://localhost:8080",
	}
	for in, want := range ok {
		got, err := serverURL(in)
		if err != nil || got != want {
			t.Errorf("serverURL(%q) = %q, %v; ждали %q", in, got, err, want)
		}
	}
	for _, in := range []string{"", "   ", "ftp://table.example.ru", "https://", "выаыва", "http://table"} {
		if got, err := serverURL(in); err == nil {
			t.Errorf("serverURL(%q) = %q без ошибки", in, got)
		}
	}
}
