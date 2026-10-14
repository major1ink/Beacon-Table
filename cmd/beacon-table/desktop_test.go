//go:build desktop

package main

import (
	"path/filepath"
	"strings"
	"testing"
)

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

func TestFolderPath(t *testing.T) {
	if _, err := folderPath("data"); err == nil {
		t.Error("относительный путь пропущен — папка легла бы туда, откуда запустили программу")
	}
	if _, err := folderPath("  "); err == nil {
		t.Error("пустой путь пропущен")
	}
	got, err := folderPath("~/Beacon Table/")
	if err != nil || !filepath.IsAbs(got) || filepath.Base(got) != "Beacon Table" {
		t.Errorf("folderPath(~/Beacon Table/) = %q, %v", got, err)
	}
}

func TestUseFolder(t *testing.T) {
	var p desktopPrefs
	for _, d := range []string{"/a", "/b", "/c", "/d", "/e", "/f", "/b"} {
		p.useFolder(d)
	}
	want := []string{"/b", "/f", "/e", "/d", "/c"}
	if strings.Join(p.Folders, " ") != strings.Join(want, " ") {
		t.Errorf("недавние папки %v, ждали %v", p.Folders, want)
	}
}

func TestOriginOf(t *testing.T) {
	cases := map[string]string{
		"http://127.0.0.1:8080/dm.html":  "http://127.0.0.1:8080",
		"https://Table.Example.ru:443/x": "https://table.example.ru",
		"https://стол.рф":                "https://xn--k1afie.xn--p1ai",
		"https://xn--k1afie.xn--p1ai/dm": "https://xn--k1afie.xn--p1ai",
		"http://[::1]:8095/":             "http://[::1]:8095",
		"wails://localhost/":             "",
		"javascript:alert(1)":            "",
		"":                               "",
	}
	for in, want := range cases {
		if got := originOf(in); got != want {
			t.Errorf("originOf(%q) = %q; ждали %q", in, got, want)
		}
	}
}

func TestPopoutURL(t *testing.T) {
	const origin = "http://127.0.0.1:8080"
	ok := map[string]string{
		"/journal.html?id=5#Глава": origin + "/journal.html?id=5#Глава",
		"/gm-screen.html":          origin + "/gm-screen.html",
	}
	for in, want := range ok {
		if got, good := popoutURL(origin, in); !good || got != want {
			t.Errorf("popoutURL(%q) = %q, %v; ждали %q", in, got, good, want)
		}
	}
	// Путь вроде "/@evil.example" — всё равно путь на этом сервере.
	if got, good := popoutURL(origin, "/@evil.example"); !good || got != origin+"/@evil.example" {
		t.Errorf("popoutURL(/@evil.example) = %q, %v", got, good)
	}
	for _, in := range []string{
		"", "journal.html", "//evil.example/x", "/\\evil.example", "https://evil.example/",
		"/x\nHost: evil", "javascript:alert(1)",
	} {
		if got, good := popoutURL(origin, in); good {
			t.Errorf("popoutURL(%q) = %q пропущен", in, got)
		}
	}
	if _, good := popoutURL("", "/dm.html"); good {
		t.Error("без выбранного сервера окно открывать некуда")
	}
}

func TestPopoutKey(t *testing.T) {
	for _, k := range []string{"journal", "sheet-3f2a", "catalog-spell", "gm-screen", "a:b.c_d"} {
		if !popoutKey(k) {
			t.Errorf("ключ %q отвергнут", k)
		}
	}
	for _, k := range []string{"", "лист", "a b", "a/b", strings.Repeat("a", 200)} {
		if popoutKey(k) {
			t.Errorf("ключ %q пропущен", k)
		}
	}
}

func TestTableMessageJS(t *testing.T) {
	js, ok := tableMessageJS(`{"type":"beacon:switchScene","name":"</script><b>"}`)
	if !ok || strings.Contains(js, "</script>") {
		t.Errorf("tableMessageJS = %q, %v", js, ok)
	}
	for _, in := range []string{`{"type":"other"}`, `"beacon:x"`, `[1]`, `{"type":1}`, `alert(1)`} {
		if js, ok := tableMessageJS(in); ok {
			t.Errorf("tableMessageJS(%q) = %q пропущен", in, js)
		}
	}
}
