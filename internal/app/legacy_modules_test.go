package app

// Мир 0.8.x при переходе на отдельные модули D&D: без модулей данные не
// тронуты и мир запускается; после установки модулей из репозитория
// (BEACON_MODULES_REPO или соседняя папка beacon-table-modules, иначе тест
// пропускается) старые sys-… ссылки снова открывают карточки.

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"beacon-table/internal/domain"
	"beacon-table/internal/modtool"
	"beacon-table/internal/module"
	"beacon-table/internal/module/base"
	"beacon-table/internal/service"
	"beacon-table/internal/testutil"
)

func modulesRepoDir(t *testing.T) string {
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

func TestLegacyWorld_ModulesInstalledLater(t *testing.T) {
	ctx := context.Background()
	repo := modulesRepoDir(t)
	m, root := newTestManager(t)
	m.dice = service.NewDiceRoller()
	m.modules = module.NewRegistry(filepath.Join(root, "modules"), []*module.Module{base.Module()}, nil, "0.9.0")
	t.Cleanup(m.Shutdown)

	res, err := m.ImportWorld(ctx, legacyArchive)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.MissingModules) != 1 || res.MissingModules[0] != domain.SystemDnD5e2024 {
		t.Fatalf("недостающие модули при импорте: %v", res.MissingModules)
	}
	world := res.Company
	before := dumpWorld(t, m, world)

	// Без модулей мир запускается, данные на месте.
	if err := m.Launch(ctx, world.ID); err != nil {
		t.Fatal(err)
	}
	cur := m.Current()
	if len(cur.Modules) != 1 || cur.Modules[0].Manifest.ID != domain.BaseModuleID || len(cur.MissingModules) != 1 {
		t.Fatalf("без модулей: подключено %d, не найдено %v", len(cur.Modules), cur.MissingModules)
	}
	if conds, err := cur.Conditions.List(ctx); err != nil || len(conds) == 0 {
		t.Fatalf("базовые состояния без модуля системы: %d %v", len(conds), err)
	}
	if _, err := cur.Bestiary.Get(ctx, "sys-goblin-voitel-goblin-warrior"); err == nil {
		t.Fatal("карточка D&D нашлась без модуля")
	}

	// Модули из репозитория ставятся архивами, как из файлов без интернета.
	out := t.TempDir()
	for _, id := range []string{"dnd5e-2024", "dnd5e-2024-srd"} {
		p, err := modtool.PackModule(filepath.Join(repo, id), out)
		if err != nil {
			t.Fatalf("%s: %v", id, err)
		}
		if _, err := m.InstallModule(ctx, filepath.Join(out, p.Archive)); err != nil {
			t.Fatalf("%s: %v", id, err)
		}
	}
	if enabled := m.EnabledModules(world); !slices.Contains(enabled, "dnd5e-2024") || !slices.Contains(enabled, "dnd5e-2024-srd") {
		t.Fatalf("включённые модули: %v", enabled)
	}
	if err := m.Launch(ctx, world.ID); err != nil {
		t.Fatal(err)
	}
	cur = m.Current()
	if len(cur.MissingModules) != 0 {
		t.Fatalf("после установки не найдено %v", cur.MissingModules)
	}
	if mon, err := cur.Bestiary.Get(ctx, "sys-goblin-voitel-goblin-warrior"); err != nil || mon.Name == "" {
		t.Fatalf("существо по старой ссылке: %v %v", mon, err)
	}
	if it, err := cur.Items.Get(ctx, "sys-dlinnyi-mech-longsword"); err != nil || it.Name == "" {
		t.Fatalf("предмет по старой ссылке: %v %v", it, err)
	}
	if sp, err := cur.Spells.Get(ctx, "sys-ognennyi-snaryad-fire-bolt"); err != nil || sp.Name == "" {
		t.Fatalf("заклинание по старой ссылке: %v %v", sp, err)
	}
	if c, err := cur.Conditions.Get(ctx, "sys-prone"); err != nil || c.Name == "" {
		t.Fatalf("состояние по старой ссылке: %v %v", c, err)
	}

	// Данные мира не изменились ни на одном шаге.
	after := dumpWorld(t, m, world)
	if diffs := testutil.JSONDiff(before, after); len(diffs) > 0 {
		t.Fatalf("мир изменился после установки модулей:\n%s", strings.Join(diffs, "\n"))
	}
}
