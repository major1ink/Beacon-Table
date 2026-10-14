package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeModule(t *testing.T, version string) string {
	t.Helper()
	dir := t.TempDir()
	files := map[string]string{
		"module.json":        `{"format":"beacon-module/v1","id":"sample","type":"content","title":"Пример","version":"` + version + `"}`,
		"CHANGELOG.md":       "## " + version + " — 2026-09-30\nПервый выпуск.\n",
		"bestiary/wolf.json": `{"name":"Волк","ac":13,"hp":11}`,
	}
	for name, content := range files {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func call(args ...string) (int, string, string) {
	var out, errOut bytes.Buffer
	code := run(args, &out, &errOut)
	return code, out.String(), errOut.String()
}

func TestValidateExitCodes(t *testing.T) {
	good := writeModule(t, "1.0.0")
	if code, out, _ := call("validate", "--tag", "sample/v1.0.0", good); code != 0 || !strings.Contains(out, "ок") {
		t.Fatalf("годный модуль: код %d, вывод %q", code, out)
	}
	if code, _, errOut := call("validate", "--tag", "sample/v9.9.9", good); code != 1 || !strings.Contains(errOut, "не совпадает") {
		t.Fatalf("плохой тег: код %d, ошибки %q", code, errOut)
	}
	if code, _, _ := call(); code != 2 {
		t.Fatalf("без команды: код %d", code)
	}
	if code, _, _ := call("validate"); code != 2 {
		t.Fatalf("validate без папки: код %d", code)
	}
}

func TestPackAndIndex(t *testing.T) {
	dir, out := writeModule(t, "1.0.0"), t.TempDir()
	if code, stdout, errOut := call("pack", "-o", out, dir); code != 0 || !strings.Contains(stdout, "sample-1.0.0.btmod") {
		t.Fatalf("pack: код %d, %q %q", code, stdout, errOut)
	}
	index := filepath.Join(t.TempDir(), "index.json")
	if code, stdout, errOut := call("index", "-o", index, "--base-url", "https://example.com/dl", out); code != 0 || !strings.Contains(stdout, "модулей 1") {
		t.Fatalf("index: код %d, %q %q", code, stdout, errOut)
	}
	data, err := os.ReadFile(index) //nolint:gosec // временный файл теста
	if err != nil || !strings.Contains(string(data), "sample%2Fv1.0.0") {
		t.Fatalf("index.json: %s %v", data, err)
	}
	// Второй запуск с --merge сохраняет записи прежнего каталога.
	if code, _, errOut := call("index", "-o", index, "--base-url", "https://example.com/dl", "--merge", index, out); code != 0 {
		t.Fatalf("index --merge: код %d, %q", code, errOut)
	}
	notes, err := os.ReadFile(filepath.Join(out, "sample-1.0.0.notes.md")) //nolint:gosec // временный файл теста
	if err != nil || strings.TrimSpace(string(notes)) != "Первый выпуск." {
		t.Fatalf("заметки выпуска: %q %v", notes, err)
	}
	if code, stdout, _ := call("info", dir); code != 0 || stdout != "sample\t1.0.0\tПример\n" {
		t.Fatalf("info: код %d, %q", code, stdout)
	}
	broken := writeModule(t, "1.0.0")
	if err := os.Remove(filepath.Join(broken, "CHANGELOG.md")); err != nil {
		t.Fatal(err)
	}
	if code, _, _ := call("pack", "-o", t.TempDir(), broken); code != 1 {
		t.Fatalf("pack без CHANGELOG: код %d", code)
	}
}
