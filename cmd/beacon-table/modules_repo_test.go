package main

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"beacon-table/internal/modtool"
	"beacon-table/internal/module"
)

// cardFiles — карточки раздела модуля: имя файла → содержимое.
func cardFiles(t *testing.T, m *module.Module, kind string) map[string][]byte {
	t.Helper()
	entries, err := fs.ReadDir(m.FS, m.ContentDir(kind))
	if err != nil {
		return nil
	}
	out := map[string][]byte{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := fs.ReadFile(m.FS, m.ContentDir(kind)+"/"+e.Name())
		if err != nil {
			t.Fatal(err)
		}
		out[e.Name()] = data
	}
	return out
}

func sameCards(t *testing.T, label string, got, want map[string][]byte) {
	t.Helper()
	if len(got) != len(want) {
		t.Errorf("%s: %d карточек в модуле, %d во встроенном каталоге", label, len(got), len(want))
	}
	for name, data := range want {
		if !bytes.Equal(got[name], data) {
			t.Errorf("%s/%s: содержимое расходится со встроенным", label, name)
		}
	}
}

// manifestKey — манифест без полей, которые у модуля из репозитория
// отличаются намеренно (описание, лицензия, минимальная версия программы).
func manifestKey(t *testing.T, man module.Manifest) string {
	t.Helper()
	man.Description, man.License, man.MinAppVersion = "", "", ""
	data, err := json.Marshal(man)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// TestModulesRepoMatchesBuiltin — разовая проверка переноса D&D в
// репозиторий модулей (BEACON_MODULES_REPO=<корень репозитория>): модули из
// modules/ собираются в архивы, ставятся обычным реестром и совпадают со
// встроенным каталогом — правила и схемы систем, все карточки. Живёт до
// выноса D&D из бинарника.
func TestModulesRepoMatchesBuiltin(t *testing.T) {
	repo := os.Getenv("BEACON_MODULES_REPO")
	if repo == "" {
		t.Skip("BEACON_MODULES_REPO не задан")
	}
	builtin := map[string]*module.Module{}
	for _, m := range builtinModules(systemFiles) {
		builtin[m.Manifest.ID] = m
	}
	dirs, err := filepath.Glob(filepath.Join(repo, "modules", "*"))
	if err != nil || len(dirs) != 3 {
		t.Fatalf("модули репозитория: %v %v", dirs, err)
	}
	reg := module.NewRegistry(t.TempDir(), nil, nil, "0.9.0")
	out := t.TempDir()
	for _, dir := range dirs {
		if r := modtool.ValidateModule(dir, modtool.Options{}); !r.OK() {
			t.Fatalf("%s: %v", filepath.Base(dir), r.Errors)
		}
		p, err := modtool.PackModule(dir, out)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := reg.Install(filepath.Join(out, p.Archive)); err != nil {
			t.Fatal(err)
		}
	}

	for _, id := range []string{"dnd5e-2014", "dnd5e-2024"} {
		got, err := reg.Get(id)
		if err != nil {
			t.Fatal(err)
		}
		want := builtin[id]
		if g, w := manifestKey(t, *got.Manifest), manifestKey(t, *want.Manifest); g != w {
			t.Errorf("%s: манифест расходится:\n%s\n%s", id, g, w)
		}
		if len(got.Schemas) != len(want.Schemas) {
			t.Errorf("%s: схем %d, во встроенном %d", id, len(got.Schemas), len(want.Schemas))
		}
		for kind, s := range want.Schemas {
			if g := got.Schemas[kind]; g == nil || !bytes.Equal(g.Raw, s.Raw) {
				t.Errorf("%s: схема %s расходится", id, kind)
			}
		}
		sameCards(t, id+"/conditions", cardFiles(t, got, module.KindConditions), cardFiles(t, want, module.KindConditions))
	}

	srd, err := reg.Get("dnd5e-2024-srd")
	if err != nil {
		t.Fatal(err)
	}
	want := builtin["dnd5e-2024"]
	for _, kind := range []string{module.KindBestiary, module.KindSpells, module.KindItems, module.KindReferences} {
		sameCards(t, "dnd5e-2024-srd/"+kind, cardFiles(t, srd, kind), cardFiles(t, want, kind))
	}
	if !srd.Manifest.LegacyIDs || srd.Manifest.Type != module.TypeContent {
		t.Errorf("контент: %+v", srd.Manifest)
	}
}
