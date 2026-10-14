package modtool

// Проверки на настоящих модулях D&D из репозитория модулей: каталог живёт
// там, а не в этом репозитории. Путь — BEACON_MODULES_REPO (корень
// репозитория модулей) или соседняя папка beacon-table-modules; нет
// репозитория — тесты пропускаются (в CI основного репозитория их нет, их
// роль берёт btmod validate в CI репозитория модулей).

import (
	"context"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"beacon-table/internal/domain"
	"beacon-table/internal/module"
	"beacon-table/internal/repository/conditionfile"
	"beacon-table/internal/testutil"
)

func modulesRepo(t *testing.T) string {
	t.Helper()
	root := os.Getenv("BEACON_MODULES_REPO")
	if root == "" {
		root = "../../../beacon-table-modules"
	}
	dir := filepath.Join(root, "modules")
	if _, err := os.Stat(dir); err != nil {
		t.Skip("репозиторий модулей не найден (BEACON_MODULES_REPO)")
	}
	return dir
}

func repoModuleDirs(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(modulesRepo(t))
	if err != nil {
		t.Fatal(err)
	}
	var dirs []string
	for _, e := range entries {
		if e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
			dirs = append(dirs, filepath.Join(modulesRepo(t), e.Name()))
		}
	}
	return dirs
}

// Модули репозитория проходят проверку целиком, собираются в архивы и
// ставятся реестром программы.
func TestRepoModulesValidatePackInstall(t *testing.T) {
	dirs := repoModuleDirs(t)
	for _, dir := range dirs {
		if r := ValidateModule(dir, Options{}); !r.OK() {
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
	srd, err := reg.Get("dnd5e-2024-srd")
	if err != nil {
		t.Fatal(err)
	}
	for kind, min := range map[string]int{"bestiary": 300, "spells": 300, "items": 400, "references": 250} {
		if got := srd.Counts()[kind]; got < min {
			t.Errorf("%s: %d карточек, ожидали не меньше %d", kind, got, min)
		}
	}
}

// Каждая карточка каталога разбирается в свою структуру без потерь: поле,
// которого структура не знает, молча выпало бы при чтении.
func TestRepoCardsDecodeWithoutLoss(t *testing.T) {
	kinds := map[string]func() any{
		"bestiary":   func() any { return &domain.Monster{} },
		"spells":     func() any { return &domain.Spell{} },
		"items":      func() any { return &domain.Item{} },
		"references": func() any { return &domain.Reference{} },
		"conditions": func() any { return &domain.Condition{} },
	}
	checked := 0
	for _, dir := range repoModuleDirs(t) {
		for kind, newCard := range kinds {
			root := filepath.Join(dir, kind)
			if _, err := os.Stat(root); err != nil {
				continue
			}
			err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
				if err != nil || d.IsDir() || !strings.HasSuffix(path, ".json") {
					return err
				}
				raw, err := os.ReadFile(path) //nolint:gosec // путь из обхода каталога
				if err != nil {
					return err
				}
				var src any
				if err := json.Unmarshal(raw, &src); err != nil {
					t.Errorf("%s: не JSON: %v", path, err)
					return nil
				}
				card := newCard()
				if err := json.Unmarshal(raw, card); err != nil {
					t.Errorf("%s: не разбирается в %T: %v", path, card, err)
					return nil
				}
				back, _ := json.Marshal(card)
				var got any
				_ = json.Unmarshal(back, &got)
				// id и updatedAt проставляет хранилище, в файле их нет.
				if m, ok := got.(map[string]any); ok {
					delete(m, "id")
					delete(m, "updatedAt")
				}
				for _, diff := range testutil.JSONDiff(dropZero(src), dropZero(got)) {
					if !strings.Contains(diff, "появилось") {
						t.Errorf("%s: %s", filepath.ToSlash(path), diff)
					}
				}
				checked++
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	if checked == 0 {
		t.Fatal("не нашли ни одной карточки")
	}
}

// dropZero убирает пустые строки, нули, false, null и пустые списки/объекты —
// всё, что omitempty не пишет обратно.
func dropZero(v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := map[string]any{}
		for k, e := range x {
			if e = dropZero(e); e != nil {
				out[k] = e
			}
		}
		if len(out) == 0 {
			return nil
		}
		return out
	case []any:
		if len(x) == 0 {
			return nil
		}
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = dropZero(e)
		}
		return out
	case string:
		if x == "" {
			return nil
		}
	case float64:
		if x == 0 {
			return nil
		}
	case bool:
		if !x {
			return nil
		}
	}
	return v
}

// Схемы систем: все пять видов на месте, новая карточка и новый лист
// получают значения по умолчанию.
func TestRepoSystemSchemas(t *testing.T) {
	systems := 0
	for _, dir := range repoModuleDirs(t) {
		data, err := os.ReadFile(filepath.Join(dir, "module.json")) //nolint:gosec // тестовые данные
		if err != nil {
			t.Fatal(err)
		}
		man, err := module.ParseManifest(data)
		if err != nil || man.Type != module.TypeSystem {
			continue
		}
		systems++
		schemas, err := module.LoadSchemas(os.DirFS(dir), "schemas", man)
		if err != nil {
			t.Fatalf("%s: %v", man.ID, err)
		}
		for _, kind := range []string{"sheet", "monster", "spell", "item", "reference"} {
			if schemas[kind] == nil {
				t.Errorf("%s: нет схемы %s", man.ID, kind)
			}
		}
		sheet := domain.DefaultCharacterSheet()
		if err := schemas["sheet"].ApplyDefaults(&sheet); err != nil {
			t.Fatal(err)
		}
		abilities := `{"cha":10,"con":10,"dex":10,"int":10,"str":10,"wis":10}`
		if string(sheet.Extra["abilities"]) != abilities || string(sheet.Extra["info"]) != `{"level":1}` {
			t.Errorf("%s: новый лист %s %s", man.ID, sheet.Extra["abilities"], sheet.Extra["info"])
		}
		mon := domain.NewMonster("m", "Гоблин")
		if err := schemas["monster"].ApplyDefaults(mon); err != nil {
			t.Fatal(err)
		}
		if mon.Extra.String("size") != "Средний" || mon.AC != 10 || string(mon.Extra["abilities"]) != abilities {
			t.Errorf("%s: новое существо %+v %s", man.ID, mon, mon.Extra["abilities"])
		}
	}
	if systems == 0 {
		t.Fatal("в репозитории нет ни одной системы")
	}
}

// Состояния системы: имена, slug и значки на месте, зависимые состояния
// существуют, истощение — шесть уровней.
func TestRepoConditions(t *testing.T) {
	found := 0
	for _, dir := range repoModuleDirs(t) {
		if _, err := os.Stat(filepath.Join(dir, "conditions")); err != nil {
			continue
		}
		found++
		store := conditionfile.NewModuleStore(os.DirFS(dir), "conditions", "sys-", "")
		list, err := store.List(context.Background())
		if err != nil || len(list) == 0 {
			t.Fatalf("%s: состояния %d, %v", filepath.Base(dir), len(list), err)
		}
		bySlug := map[string]bool{}
		for _, c := range list {
			switch {
			case c.Name == "" || c.Slug == "":
				t.Errorf("%s: пустое имя или slug", c.ID)
			case c.Icon == "" && c.ImageURL == "":
				t.Errorf("%s: нет ни глифа, ни картинки", c.ID)
			case bySlug[c.Slug]:
				t.Errorf("slug %q встречается дважды", c.Slug)
			}
			bySlug[c.Slug] = true
		}
		for _, c := range list {
			for _, rider := range c.Riders {
				if !bySlug[rider] {
					t.Errorf("%s: зависимое состояние %q отсутствует", c.Slug, rider)
				}
			}
			if c.Slug == "exhaustion" && c.Levels != 6 {
				t.Errorf("истощение: levels = %d, ожидалось 6", c.Levels)
			}
		}
	}
	if found == 0 {
		t.Fatal("в репозитории нет состояний")
	}
}
