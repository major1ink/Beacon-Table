package app

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"beacon-table/internal/domain"
	"beacon-table/internal/module"
	"beacon-table/internal/service"
)

// modulesManager — менеджер с реестром: встроенный «D&D» в раскладке
// systemdata (как сейчас в бинарнике) и установленный модуль extra.
func modulesManager(t *testing.T) *CompanyManager {
	t.Helper()
	m, root := newTestManager(t)
	m.dice = service.NewDiceRoller()
	builtin := fstest.MapFS{
		"systemdata/bestiary/dnd5e-2024/goblin.json":  {Data: []byte(`{"name":"Гоблин"}`)},
		"systemdata/conditions/dnd5e-2024/prone.json": {Data: []byte(`{"name":"Лежит","slug":"prone"}`)},
	}
	dnd := module.Builtin(builtin, "systemdata", "dnd5e-2024", &module.Manifest{
		Format: module.Format, ID: "dnd5e-2024", Type: module.TypeSystem, Title: "D&D", Version: "1.0.0", LegacyIDs: true,
	})
	installed := filepath.Join(root, "modules")
	extra := filepath.Join(installed, "extra")
	writeFile(t, filepath.Join(extra, "module.json"),
		`{"format":"beacon-module/v1","id":"extra","type":"content","title":"Доп","version":"1.2.0"}`)
	writeFile(t, filepath.Join(extra, "bestiary", "owlbear.json"), `{"name":"Совомедведь"}`)
	m.modules = module.NewRegistry(installed, []*module.Module{dnd}, nil, "")
	return m
}

func monsterIDs(t *testing.T, w *ActiveWorld) []string {
	t.Helper()
	list, err := w.Bestiary.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, mon := range list {
		ids = append(ids, mon.ID+"@"+mon.Module)
	}
	return ids
}

func TestLaunch_ModulesOfWorld(t *testing.T) {
	ctx := context.Background()
	m := modulesManager(t)
	t.Cleanup(m.Shutdown)

	// Мир до модулей (Modules == nil): виден модуль его системы — тот же
	// каталог «из коробки», что и раньше, с теми же id.
	old, err := m.Create(ctx, "Старый мир", domain.SystemDnD5e2024)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Launch(ctx, old.ID); err != nil {
		t.Fatal(err)
	}
	if got := monsterIDs(t, m.Current()); len(got) != 1 || got[0] != "sys-goblin@dnd5e-2024" {
		t.Fatalf("мир до модулей: %v", got)
	}
	cond, err := m.Current().Conditions.Get(ctx, "sys-prone")
	if err != nil || cond.Module != "dnd5e-2024" {
		t.Fatalf("состояние модуля: %+v %v", cond, err)
	}

	// Мир с явным списком: порядок подключения, ненайденный модуль не
	// ломает запуск, а попадает в MissingModules.
	w, err := m.Create(ctx, "Новый мир", domain.SystemDnD5e2024)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.companies.SetModules(ctx, w.ID, []string{"extra", "nope", "dnd5e-2024"}); err != nil {
		t.Fatal(err)
	}
	if err := m.Launch(ctx, w.ID); err != nil {
		t.Fatal(err)
	}
	cur := m.Current()
	got := monsterIDs(t, cur)
	if len(got) != 2 || got[0] != "sys-goblin@dnd5e-2024" || got[1] != "extra--owlbear@extra" {
		t.Fatalf("мир с модулями: %v", got)
	}
	if len(cur.MissingModules) != 1 || cur.MissingModules[0] != "nope" {
		t.Fatalf("ненайденные модули: %v", cur.MissingModules)
	}
	if len(cur.Modules) != 2 || cur.Modules[0].Manifest.ID != "extra" {
		t.Fatalf("подключённые модули: %v", cur.Modules)
	}

	// Все модули выключены: пустой список, а не «модуль системы».
	if err := m.companies.SetModules(ctx, w.ID, []string{}); err != nil {
		t.Fatal(err)
	}
	if err := m.Launch(ctx, w.ID); err != nil {
		t.Fatal(err)
	}
	if got := monsterIDs(t, m.Current()); len(got) != 0 {
		t.Fatalf("без модулей: %v", got)
	}
}

func TestWorldPack_CarriesModules(t *testing.T) {
	ctx := context.Background()
	src := modulesManager(t)
	c, err := src.Create(ctx, "С модулями", domain.SystemDnD5e2024)
	if err != nil {
		t.Fatal(err)
	}
	if err := src.companies.SetModules(ctx, c.ID, []string{"dnd5e-2024", "extra"}); err != nil {
		t.Fatal(err)
	}

	// На целевом сервере модуля extra нет.
	dst, _ := newTestManager(t)
	dst.modules = module.NewRegistry(t.TempDir(), nil, nil, "")
	res, err := dst.ImportWorld(ctx, exportToZip(t, src, c.ID, false))
	if err != nil {
		t.Fatal(err)
	}
	got, err := dst.companies.ByID(ctx, res.Company.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Modules) != 2 || got.Modules[0] != "dnd5e-2024" || got.Modules[1] != "extra" {
		t.Fatalf("модули мира после импорта: %v", got.Modules)
	}
	if len(res.MissingModules) != 2 {
		t.Fatalf("ненайденные модули: %v", res.MissingModules)
	}

	// Мир до модулей едет без списка и остаётся «миром до модулей».
	legacy, _ := src.Create(ctx, "Старый", domain.SystemDnD5e2024)
	res, err = dst.ImportWorld(ctx, exportToZip(t, src, legacy.ID, false))
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := dst.companies.ByID(ctx, res.Company.ID); got.Modules != nil {
		t.Fatalf("мир до модулей получил список: %v", got.Modules)
	}
}

// TestCloneCopiesModuleImages — клон карточки модуля не должен зависеть от
// модуля: картинки копируются в загрузки мира при сохранении карточки, и
// после удаления модуля клон остаётся с картинкой.
func TestCloneCopiesModuleImages(t *testing.T) {
	ctx := context.Background()
	m := modulesManager(t)
	t.Cleanup(m.Shutdown)
	extra := filepath.Join(filepath.Dir(m.dataRoot), "modules", "extra")
	writeFile(t, filepath.Join(extra, "assets", "bestiary", "owlbear.webp"), "OWL")
	writeFile(t, filepath.Join(extra, "assets", "items", "feather.webp"), "FEATHER")

	w, err := m.Create(ctx, "Мир", domain.SystemDnD5e2024)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.companies.SetModules(ctx, w.ID, []string{"extra"}); err != nil {
		t.Fatal(err)
	}
	if err := m.Launch(ctx, w.ID); err != nil {
		t.Fatal(err)
	}
	best := m.Current().Bestiary

	// «Клонировать» на клиенте: создать карточку и записать в неё поля
	// карточки модуля (см. web/src/pages/bestiary.js: cloneBtn).
	created, err := best.Create(ctx, "Совомедведь")
	if err != nil {
		t.Fatal(err)
	}
	clone := *created
	clone.ImageURL = "/module-assets/extra/bestiary/owlbear.webp"
	clone.Description = "![перо](/module-assets/extra/items/feather.webp) и снова /module-assets/extra/bestiary/owlbear.webp"
	clone.Inventory = []domain.InventoryEntry{{ID: "i1", Name: "Перо", Quantity: 1, ImageURL: "/module-assets/extra/items/feather.webp"}}
	saved, err := best.Update(ctx, created.ID, clone)
	if err != nil {
		t.Fatal(err)
	}
	_, uploads, url := m.rootsFor(m.Current().Company)
	// Хранилище загрузок добавляет к имени метку времени: «<unixnano>-owlbear.webp».
	copied := func(got, dir, name string) bool {
		prefix := url + "tokens/modules/extra/" + dir + "/"
		return strings.HasPrefix(got, prefix) && strings.HasSuffix(got, "-"+name) && !strings.Contains(strings.TrimPrefix(got, prefix), "/")
	}
	owl, feather := saved.ImageURL, saved.Inventory[0].ImageURL
	if !copied(owl, "bestiary", "owlbear.webp") || !copied(feather, "items", "feather.webp") {
		t.Fatalf("ссылки не переписаны: %q, %q", owl, feather)
	}
	if want := "![перо](" + feather + ") и снова " + owl; saved.Description != want {
		t.Fatalf("описание: %q", saved.Description)
	}
	if b, err := os.ReadFile(filepath.Join(uploads, filepath.FromSlash(strings.TrimPrefix(owl, url)))); err != nil || string(b) != "OWL" {
		t.Fatalf("файл не скопирован: %q %v", b, err)
	}

	// Повторное сохранение с той же ссылкой модуля — тот же файл, без копии.
	again, err := best.Update(ctx, created.ID, clone)
	if err != nil || again.ImageURL != owl {
		t.Fatalf("повторное сохранение: %q %v", again.ImageURL, err)
	}
	entries, _ := os.ReadDir(filepath.Join(uploads, "tokens", "modules", "extra", "bestiary"))
	if len(entries) != 1 {
		t.Fatalf("картинка скопирована повторно: %v", entries)
	}

	// Модуль удалён — клон с картинкой; ссылку на пропавший файл сохранение
	// не трогает и не падает.
	if err := os.RemoveAll(extra); err != nil {
		t.Fatal(err)
	}
	got, err := best.Get(ctx, created.ID)
	if err != nil || got.ImageURL != owl {
		t.Fatalf("клон после удаления модуля: %+v %v", got, err)
	}
	broken := *got
	broken.ImageURL = "/module-assets/extra/bestiary/gone.webp"
	saved, err = best.Update(ctx, created.ID, broken)
	if err != nil || saved.ImageURL != "/module-assets/extra/bestiary/gone.webp" {
		t.Fatalf("ссылка на пропавший файл: %q %v", saved.ImageURL, err)
	}
}
