package main

import (
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"beacon-table/internal/domain"
	"beacon-table/internal/module"
	"beacon-table/internal/testutil"
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
		for _, kind := range []string{"sheet", "monster", "spell", "item", "reference"} {
			if m.Schemas[kind] == nil {
				t.Errorf("%s: нет схемы %s", m.Manifest.ID, kind)
			}
		}
	}
}

func TestBuiltinSheetDefaults(t *testing.T) {
	for _, m := range builtinModules(systemFiles) {
		sheet := domain.DefaultCharacterSheet()
		if err := m.Schemas["sheet"].ApplyDefaults(&sheet); err != nil {
			t.Fatal(err)
		}
		abilities := `{"cha":10,"con":10,"dex":10,"int":10,"str":10,"wis":10}`
		if string(sheet.Extra["abilities"]) != abilities || string(sheet.Extra["info"]) != `{"level":1}` {
			t.Errorf("%s: новый лист %s %s", m.Manifest.ID, sheet.Extra["abilities"], sheet.Extra["info"])
		}
	}
}

func TestBuiltinMonsterDefaults(t *testing.T) {
	for _, m := range builtinModules(systemFiles) {
		mon := domain.NewMonster("m", "Гоблин")
		if err := m.Schemas["monster"].ApplyDefaults(mon); err != nil {
			t.Fatal(err)
		}
		abilities := `{"cha":10,"con":10,"dex":10,"int":10,"str":10,"wis":10}`
		if mon.Extra.String("size") != "Средний" || mon.AC != 10 || string(mon.Extra["abilities"]) != abilities {
			t.Errorf("%s: новое существо %+v %s", m.Manifest.ID, mon, mon.Extra["abilities"])
		}
	}
}

// Существа, заклинания, предметы и справочник из systemdata читаются и пишутся назад без потерь:
// поля системы лежат в Extra под теми же ключами.
func TestSystemCatalogRoundTrip(t *testing.T) {
	check := func(dir string, into func() any, minCount int) {
		n := 0
		err := fs.WalkDir(systemFiles, path.Join("systemdata", dir), func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(p, ".json") {
				return err
			}
			raw, err := systemFiles.ReadFile(p)
			if err != nil {
				return err
			}
			card := into()
			if err := json.Unmarshal(raw, card); err != nil {
				t.Errorf("%s: %v", p, err)
				return nil
			}
			back, err := json.Marshal(card)
			if err != nil {
				t.Errorf("%s: %v", p, err)
				return nil
			}
			var want, got any
			_ = json.Unmarshal(raw, &want)
			_ = json.Unmarshal(back, &got)
			// Пустые строки, списки и нули не сравниваем: imageUrl, tags и
			// weightLb при записи опускаются (omitempty), а поля системы в Extra остаются как были.
			for _, tree := range []any{want, got} {
				for k, v := range tree.(map[string]any) {
					if list, ok := v.([]any); (ok && len(list) == 0) || v == "" || v == float64(0) {
						delete(tree.(map[string]any), k)
					}
				}
			}
			// id и updatedAt проставляет хранилище, в файле каталога их нет.
			delete(got.(map[string]any), "id")
			delete(got.(map[string]any), "updatedAt")
			if diff := testutil.JSONDiff(want, got); len(diff) > 0 {
				t.Errorf("%s: %v", p, diff)
			}
			n++
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		if n < minCount {
			t.Errorf("%s: карточек %d, ожидали не меньше %d", dir, n, minCount)
		}
	}
	check("bestiary", func() any { return &domain.Monster{} }, 300)
	check("spells", func() any { return &domain.Spell{} }, 300)
	check("items", func() any { return &domain.Item{} }, 400)
	check("references", func() any { return &domain.Reference{} }, 250)
}
