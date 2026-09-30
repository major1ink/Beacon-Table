package modtool

import (
	"os"
	"path/filepath"
	"testing"

	"beacon-table/internal/module"
)

const systemdata = "../../cmd/beacon-table/systemdata"

func copyTree(t *testing.T, from, to string) {
	t.Helper()
	entries, err := os.ReadDir(from)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(to, 0o750); err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		src, dst := filepath.Join(from, e.Name()), filepath.Join(to, e.Name())
		if e.IsDir() {
			copyTree(t, src, dst)
			continue
		}
		data, err := os.ReadFile(src) //nolint:gosec // тестовые данные каталога
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(dst, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

// Вшитый каталог D&D, разложенный по модулям (система отдельно от контента),
// проходит проверку целиком, собирается в архивы и ставится реестром
// программы с теми же счётчиками.
func TestSystemdataAsModules(t *testing.T) {
	root := t.TempDir()
	const changelog = "## 1.0.0 — 2026-09-30\nПервый выпуск.\n"
	manifest := func(id, typ, extra string) string {
		return `{"format":"beacon-module/v1","id":"` + id + `","type":"` + typ + `","title":"` + id + `","version":"1.0.0","legacyIds":true` + extra + `}`
	}
	var dirs []string
	for _, system := range []string{"dnd5e-2014", "dnd5e-2024"} {
		dir := filepath.Join(root, system)
		copyTree(t, filepath.Join(systemdata, "schemas", system), filepath.Join(dir, "schemas"))
		copyTree(t, filepath.Join(systemdata, "conditions", system), filepath.Join(dir, "conditions"))
		write(t, dir, map[string]string{"module.json": manifest(system, "system", `,"systems":["`+system+`"]`), "CHANGELOG.md": changelog})
		dirs = append(dirs, dir)
	}
	srd := filepath.Join(root, "dnd5e-2024-srd")
	for _, kind := range []string{"bestiary", "spells", "items", "references"} {
		copyTree(t, filepath.Join(systemdata, kind, "dnd5e-2024"), filepath.Join(srd, kind))
	}
	write(t, srd, map[string]string{
		"module.json":  manifest("dnd5e-2024-srd", "content", `,"systems":["dnd5e-2024"],"requires":[{"id":"dnd5e-2024"}]`),
		"CHANGELOG.md": changelog,
	})
	dirs = append(dirs, srd)

	for _, dir := range dirs {
		r := ValidateModule(dir, Options{})
		if !r.OK() {
			t.Fatalf("%s: %v", filepath.Base(dir), r.Errors)
		}
	}
	if p := ValidateSet(dirs); len(p) != 0 {
		t.Fatalf("набор: %v", p)
	}

	out := t.TempDir()
	reg := module.NewRegistry(t.TempDir(), nil, nil, "0.9.0")
	for _, dir := range dirs {
		p, err := PackModule(dir, out)
		if err != nil {
			t.Fatalf("%s: %v", filepath.Base(dir), err)
		}
		if _, err := reg.Install(filepath.Join(out, p.Archive)); err != nil {
			t.Fatalf("%s: %v", filepath.Base(dir), err)
		}
	}
	got, err := reg.Get("dnd5e-2024-srd")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]int{"bestiary": 331, "spells": 322, "items": 452, "references": 261}
	for kind, n := range want {
		if got.Counts()[kind] != n {
			t.Errorf("%s: %d карточек, ожидали %d", kind, got.Counts()[kind], n)
		}
	}
	sys, err := reg.Get("dnd5e-2024")
	if err != nil {
		t.Fatal(err)
	}
	if len(sys.Schemas) != 5 || sys.Counts()["conditions"] != 21 {
		t.Errorf("система: схем %d, состояний %d", len(sys.Schemas), sys.Counts()["conditions"])
	}
}
