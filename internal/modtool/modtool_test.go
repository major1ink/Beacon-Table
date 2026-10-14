package modtool

import (
	"archive/zip"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"beacon-table/internal/module"
)

const goodManifest = `{"format":"beacon-module/v1","id":"sample","type":"content","title":"Пример","version":"1.1.0",
 "systems":["sample-system"],"description":"Проверочный модуль","license":"CC-BY-4.0"}`

const goodChangelog = "# Изменения\n\n## 1.1.0 — 2026-09-30\nДобавлен волк.\n\n## 1.0.0 — 2026-09-01\nПервый выпуск.\n"

var goodFiles = map[string]string{
	"module.json":          goodManifest,
	"CHANGELOG.md":         goodChangelog,
	"LICENSE":              "CC-BY-4.0",
	"README.md":            "описание",
	"bestiary/goblin.json": `{"name":"Гоблин","ac":15,"hp":7,"cr":"1/4","imageUrl":"/module-assets/sample/goblin.webp"}`,
	"bestiary/wolf.json":   `{"name":"Волк","ac":13,"hp":11}`,
	"spells/spark.json":    `{"name":"Искра","level":1}`,
	"assets/goblin.webp":   "png",
}

func write(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for name, content := range files {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func goodModule(t *testing.T, patch map[string]string) string {
	t.Helper()
	files := map[string]string{}
	for k, v := range goodFiles {
		files[k] = v
	}
	dir := t.TempDir()
	write(t, dir, files)
	for k, v := range patch {
		if v == "" {
			if err := os.RemoveAll(filepath.Join(dir, filepath.FromSlash(k))); err != nil {
				t.Fatal(err)
			}
			continue
		}
		write(t, dir, map[string]string{k: v})
	}
	return dir
}

func TestValidateGoodModule(t *testing.T) {
	r := ValidateModule(goodModule(t, nil), Options{Tag: "sample/v1.1.0"})
	if !r.OK() || len(r.Warnings) != 0 {
		t.Fatalf("ошибки %v, предупреждения %v", r.Errors, r.Warnings)
	}
}

func TestValidateRejects(t *testing.T) {
	cases := map[string]struct {
		patch map[string]string
		opts  Options
		want  string
	}{
		"нет module.json":         {map[string]string{"module.json": ""}, Options{}, "нет module.json"},
		"битый манифест":          {map[string]string{"module.json": `{"format":"x"}`}, Options{}, "module.json"},
		"лишняя папка":            {map[string]string{"beastiary/a.json": `{"name":"А"}`}, Options{}, "лишняя папка"},
		"лишний файл":             {map[string]string{"notes.txt": "x"}, Options{}, "лишний файл"},
		"вложенная папка раздела": {map[string]string{"bestiary/old/a.json": `{"name":"А"}`}, Options{}, "вложенные папки"},
		"не json в разделе":       {map[string]string{"bestiary/readme.md": "x"}, Options{}, "файл .json"},
		"битая карточка":          {map[string]string{"bestiary/bad.json": `{"name":`}, Options{}, "не JSON-объект"},
		"карточка с id":           {map[string]string{"bestiary/a.json": `{"id":"x","name":"А"}`}, Options{}, `нет "id"`},
		"карточка с updatedAt":    {map[string]string{"bestiary/a.json": `{"updatedAt":"2026-01-01T00:00:00Z","name":"А"}`}, Options{}, "updatedAt"},
		"кривое имя файла":        {map[string]string{"bestiary/Гоблин.json": `{"name":"Г"}`}, Options{}, "имя файла"},
		"нет имени":               {map[string]string{"bestiary/a.json": `{"ac":1}`}, Options{}, "нет имени"},
		"неверный тип поля ядра":  {map[string]string{"bestiary/a.json": `{"name":"А","hp":"много"}`}, Options{}, "bestiary/a.json"},
		"slug состояния":          {map[string]string{"conditions/burning.json": `{"name":"Горение","slug":"fire"}`}, Options{}, "совпадать с именем файла"},
		"слишком большой ключ":    {map[string]string{"bestiary/a.json": `{"name":"А","lore":"` + strings.Repeat("я", 70000) + `"}`}, Options{}, "не поместится"},
		"картинка в никуда":       {map[string]string{"assets/goblin.webp": ""}, Options{}, "нет картинки"},
		"чужой модуль":            {map[string]string{"bestiary/wolf.json": `{"name":"Волк","imageUrl":"/module-assets/other/wolf.webp"}`}, Options{}, "чужой модуль"},
		"нет CHANGELOG":           {map[string]string{"CHANGELOG.md": ""}, Options{}, "нет CHANGELOG.md"},
		"CHANGELOG не той версии": {map[string]string{"CHANGELOG.md": "## 1.0.0 — 2026-09-01\nx\n"}, Options{}, "первая запись — 1.0.0"},
		"CHANGELOG без даты":      {map[string]string{"CHANGELOG.md": "## 1.1.0\nx\n"}, Options{}, "первая запись должна быть"},
		"тег не тот":              {nil, Options{Tag: "sample/v1.0.0"}, "не совпадает"},
		"версия ниже прошлой":     {nil, Options{Prev: &Summary{Version: "2.0.0"}}, "ниже прошлой"},
		"пропал slug без major": {
			nil,
			Options{Prev: &Summary{Version: "1.0.0", Slugs: map[string][]string{"bestiary": {"goblin", "wolf", "orc"}}}},
			"только с повышением major",
		},
	}
	for name, c := range cases {
		r := ValidateModule(goodModule(t, c.patch), c.opts)
		if r.OK() {
			t.Errorf("%s: ожидали ошибку", name)
			continue
		}
		if !strings.Contains(strings.Join(r.Errors, "\n"), c.want) {
			t.Errorf("%s: ошибки %v, ждали «%s»", name, r.Errors, c.want)
		}
	}
}

func TestValidateSlugRemovedWithMajor(t *testing.T) {
	dir := goodModule(t, map[string]string{
		"module.json":  strings.Replace(goodManifest, `"1.1.0"`, `"2.0.0"`, 1),
		"CHANGELOG.md": "## 2.0.0 — 2026-10-01\nУдалён орк.\n",
	})
	prev := &Summary{Version: "1.1.0", Slugs: map[string][]string{"bestiary": {"goblin", "orc", "wolf"}}}
	if r := ValidateModule(dir, Options{Prev: prev}); !r.OK() {
		t.Fatalf("удаление карточки при повышении major допустимо: %v", r.Errors)
	}
}

func TestValidateWarnings(t *testing.T) {
	dir := goodModule(t, map[string]string{
		"bestiary/wolf.json": `{"name":"Волк","imageUrl":"https://example.com/w.png"}`,
		"assets/unused.png":  "x",
	})
	r := ValidateModule(dir, Options{})
	if !r.OK() {
		t.Fatalf("ошибки: %v", r.Errors)
	}
	all := strings.Join(r.Warnings, "\n")
	if !strings.Contains(all, "внешняя ссылка") || !strings.Contains(all, "unused.png") {
		t.Fatalf("предупреждения: %v", r.Warnings)
	}
}

func TestSummarize(t *testing.T) {
	s, err := Summarize(goodModule(t, nil))
	if err != nil {
		t.Fatal(err)
	}
	if s.ID != "sample" || s.Counts["bestiary"] != 2 || s.Counts["spells"] != 1 {
		t.Fatalf("счётчики: %+v", s.Counts)
	}
	if strings.Join(s.Names["bestiary"], ",") != "Волк,Гоблин" || strings.Join(s.Slugs["bestiary"], ",") != "goblin,wolf" {
		t.Fatalf("имена и slug'и: %v %v", s.Names, s.Slugs)
	}
	if s.Changelog != "Добавлен волк." || s.Systems[0] != "sample-system" {
		t.Fatalf("changelog %q, systems %v", s.Changelog, s.Systems)
	}
}

func TestPackIsDeterministicAndInstallable(t *testing.T) {
	dir := goodModule(t, nil)
	out1, out2 := t.TempDir(), t.TempDir()
	p1, err := PackModule(dir, out1)
	if err != nil {
		t.Fatal(err)
	}
	p2, err := PackModule(dir, out2)
	if err != nil {
		t.Fatal(err)
	}
	if p1.SHA256 != p2.SHA256 || p1.Archive != "sample-1.1.0.btmod" {
		t.Fatalf("архив недетерминирован: %s и %s (%s)", p1.SHA256, p2.SHA256, p1.Archive)
	}
	zr, err := zip.OpenReader(filepath.Join(out1, p1.Archive))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, f := range zr.File {
		names = append(names, f.Name)
	}
	_ = zr.Close()
	all := strings.Join(names, ",")
	if !strings.Contains(all, "module.json") || !strings.Contains(all, "CHANGELOG.md") || !strings.Contains(all, "LICENSE") || strings.Contains(all, "README.md") {
		t.Fatalf("состав архива: %v", names)
	}
	sum, err := os.ReadFile(filepath.Join(out1, p1.Sum))
	if err != nil || !strings.HasPrefix(string(sum), p1.SHA256) {
		t.Fatalf("sha256-файл: %q %v", sum, err)
	}
	// Собранный модуль ставится обычным реестром программы.
	reg := module.NewRegistry(t.TempDir(), nil, nil, "0.9.0")
	m, err := reg.Install(filepath.Join(out1, p1.Archive))
	if err != nil {
		t.Fatal(err)
	}
	if m.Manifest.ID != "sample" || m.Counts()["bestiary"] != 2 || m.Counts()["spells"] != 1 {
		t.Fatalf("установленный модуль: %+v %v", m.Manifest, m.Counts())
	}
}

func TestBuildIndexMerges(t *testing.T) {
	out := t.TempDir()
	if _, err := PackModule(goodModule(t, nil), out); err != nil {
		t.Fatal(err)
	}
	old := &Index{Format: IndexFormat, Modules: []IndexEntry{{ID: "other", Version: "1.0.0"}, {ID: "sample", Version: "1.0.0"}}}
	idx, err := BuildIndex(out, "https://example.com/dl/", old)
	if err != nil {
		t.Fatal(err)
	}
	if len(idx.Modules) != 2 || idx.Modules[0].ID != "other" || idx.Modules[1].ID != "sample" || idx.Modules[1].Version != "1.1.0" {
		t.Fatalf("каталог: %+v", idx.Modules)
	}
	e := idx.Modules[1]
	if e.URL != "https://example.com/dl/sample%2Fv1.1.0/sample-1.1.0.btmod" || e.SHA256 == "" || e.Size == 0 {
		t.Fatalf("запись: %+v", e)
	}
	if !strings.HasSuffix(e.SummaryURL, "/sample-1.1.0.summary.json") || len(e.SHA256) != 64 {
		t.Fatalf("запись: %+v", e)
	}
}

func TestValidateSet(t *testing.T) {
	system := `{"format":"beacon-module/v1","id":"sample-system","type":"system","title":"Система","version":"1.0.0"}`
	mk := func(files map[string]string) string {
		dir := t.TempDir()
		write(t, dir, files)
		return dir
	}
	sys := mk(map[string]string{"module.json": system})
	content := mk(map[string]string{"module.json": strings.Replace(goodManifest, `"systems":["sample-system"],`, `"systems":["sample-system"],"requires":[{"id":"sample-system","minVersion":"1.0.0"}],`, 1)})
	if p := ValidateSet([]string{sys, content}); len(p) != 0 {
		t.Fatalf("годный набор: %v", p)
	}
	if p := ValidateSet([]string{content}); len(p) != 2 {
		t.Fatalf("нет системы: %v", p)
	}
	newer := mk(map[string]string{"module.json": strings.Replace(goodManifest, `"systems":["sample-system"],`, `"systems":["sample-system"],"requires":[{"id":"sample-system","minVersion":"2.0.0"}],`, 1)})
	if p := ValidateSet([]string{sys, newer}); len(p) != 1 || !strings.Contains(p[0], "не ниже 2.0.0") {
		t.Fatalf("зависимость новее: %v", p)
	}
	dup := mk(map[string]string{"module.json": system})
	if p := ValidateSet([]string{sys, dup}); len(p) != 1 || !strings.Contains(p[0], "у двух модулей") {
		t.Fatalf("дубль id: %v", p)
	}
}
