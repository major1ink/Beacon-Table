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
