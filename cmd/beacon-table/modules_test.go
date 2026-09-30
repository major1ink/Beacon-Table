package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"

	"beacon-table/internal/domain"
	"beacon-table/internal/module"
)

func TestModuleAssetsHandler(t *testing.T) {
	root := t.TempDir()
	extra := filepath.Join(root, "extra")
	if err := os.MkdirAll(filepath.Join(extra, "assets", "bestiary"), 0o750); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(extra, "module.json"), []byte(`{"format":"beacon-module/v1","id":"extra","type":"content","title":"Доп","version":"1.0.0"}`), 0o600)
	_ = os.WriteFile(filepath.Join(extra, "assets", "bestiary", "owlbear.webp"), []byte("owl"), 0o600)
	_ = os.WriteFile(filepath.Join(extra, "secret.txt"), []byte("не картинка"), 0o600)

	builtin := builtinModules(fstest.MapFS{
		"systemdata/assets/dnd5e-2024/items/sword.webp": {Data: []byte("sword")},
	})
	mux := http.NewServeMux()
	mux.Handle(moduleAssetsURL, moduleAssetsHandler(module.NewRegistry(root, builtin, nil, "")))
	srv := httptest.NewServer(mux)
	defer srv.Close()

	get := func(p string) (int, string) {
		resp, err := srv.Client().Get(srv.URL + p)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}
	if code, body := get("/module-assets/extra/bestiary/owlbear.webp"); code != 200 || body != "owl" {
		t.Fatalf("картинка модуля: %d %q", code, body)
	}
	if code, body := get("/module-assets/dnd5e-2024/items/sword.webp"); code != 200 || body != "sword" {
		t.Fatalf("картинка встроенного модуля: %d %q", code, body)
	}
	for _, p := range []string{
		"/module-assets/extra/../secret.txt",
		"/module-assets/extra/%2e%2e/secret.txt",
		"/module-assets/extra/",
		"/module-assets/nope/x.webp",
		"/module-assets/extra",
	} {
		if code, body := get(p); code == http.StatusOK {
			t.Errorf("%s: отдан файл вне assets или несуществующего модуля: %q", p, body)
		}
	}
}

func TestBuiltinModulesHaveSchemas(t *testing.T) {
	for _, m := range builtinModules(systemFiles) {
		if got := m.Manifest.Importers; len(got) != 2 || got[0] != "foundry-dnd5e" || got[1] != "lss" {
			t.Errorf("%s: импортёры %v", m.Manifest.ID, got)
		}
		for _, kind := range []string{"sheet", "monster", "spell", "item", "reference"} {
			if m.Schemas[kind] == nil {
				t.Errorf("%s: нет схемы %s", m.Manifest.ID, kind)
			}
		}
	}
}

func TestBuiltinMonsterDefaults(t *testing.T) {
	for _, m := range builtinModules(systemFiles) {
		mon := domain.NewMonster("m", "Гоблин")
		if err := m.Schemas["monster"].ApplyDefaults(mon); err != nil {
			t.Fatal(err)
		}
		if mon.Size != "Средний" || mon.AC != 10 || mon.Abilities != (domain.Abilities{Str: 10, Dex: 10, Con: 10, Int: 10, Wis: 10, Cha: 10}) {
			t.Errorf("%s: новое существо %+v", m.Manifest.ID, mon)
		}
	}
}
