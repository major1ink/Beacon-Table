package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"beacon-table/internal/domain"
	"beacon-table/internal/module"
	"beacon-table/internal/module/base"
	"beacon-table/internal/repository/sqlite"
	"beacon-table/internal/service"
)

// modulesManager — менеджер с реестром: встроенный «D&D» в раскладке
// старой системы D&D и установленный модуль extra.
func modulesManager(t *testing.T) *CompanyManager {
	t.Helper()
	m, root := newTestManager(t)
	m.dice = service.NewDiceRoller()
	builtin := fstest.MapFS{
		"bestiary/goblin.json":  {Data: []byte(`{"name":"Гоблин"}`)},
		"conditions/prone.json": {Data: []byte(`{"name":"Лежит","slug":"prone"}`)},
	}
	dnd := module.Builtin(builtin, &module.Manifest{
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
	legacy, _ := src.createWorld(ctx, "Старый", domain.SystemDnD5e2024, nil)
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

func TestCreateWorldSystems(t *testing.T) {
	ctx := context.Background()
	m, _ := newTestManager(t)
	m.dice = service.NewDiceRoller()
	t.Cleanup(m.Shutdown)

	var ids []string
	for _, s := range m.Systems() {
		ids = append(ids, s.ID)
	}
	if strings.Join(ids, ",") != "custom,dnd5e-2014,dnd5e-2024" {
		t.Fatalf("системы: %v", ids)
	}

	// «Своя система» — с базовыми состояниями, и они видны в мире.
	c, err := m.Create(ctx, "Хоумбрю", domain.SystemCustom)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(c.Modules, ",") != domain.BaseModuleID {
		t.Fatalf("модули мира «Своей системы»: %v", c.Modules)
	}
	if err := m.Launch(ctx, c.ID); err != nil {
		t.Fatal(err)
	}
	prone, err := m.Current().Conditions.Get(ctx, "base--prone")
	if err != nil || prone.Slug != "prone" || prone.Module != domain.BaseModuleID {
		t.Fatalf("базовое состояние: %+v %v", prone, err)
	}

	// Мир на системном модуле — сам модуль, без базовых состояний.
	d, err := m.Create(ctx, "D&D", domain.SystemDnD5e2024)
	if err != nil || strings.Join(d.Modules, ",") != domain.SystemDnD5e2024 {
		t.Fatalf("мир D&D: %+v %v", d, err)
	}

	// Системы нет на сервере — мир не создаётся.
	if _, err := m.Create(ctx, "Чужой", "pathfinder"); err == nil {
		t.Fatal("мир создан на неустановленной системе")
	}
}

// worldClient — экран, подключённый к комнате мира.
type worldClient struct {
	got    []string
	closed bool
}

func (c *worldClient) Send(v any) {
	if m, ok := v.(map[string]any); ok {
		if typ, _ := m["type"].(string); typ != "" {
			c.got = append(c.got, typ)
		}
	}
}
func (c *worldClient) Close()                  { c.closed = true }
func (c *worldClient) Role() domain.ClientRole { return domain.RoleDM }
func (c *worldClient) PlayerID() string        { return "dm" }
func (c *worldClient) PlayerName() string      { return "dm" }
func (c *worldClient) reloaded() bool          { return slices.Contains(c.got, "world_reload") }
func (c *worldClient) waitJoined(t *testing.T) {
	t.Helper()
	waitFor(t, func() bool { return len(c.got) > 0 })
}
func waitFor(t *testing.T, ok func() bool) {
	t.Helper()
	for range 200 {
		if ok() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("не дождались")
}

// withSRD — контент для D&D 2024 рядом с универсальным extra.
func withSRD(t *testing.T, m *CompanyManager) {
	t.Helper()
	dir := filepath.Join(filepath.Dir(m.dataRoot), "modules", "srd")
	writeFile(t, filepath.Join(dir, "module.json"),
		`{"format":"beacon-module/v1","id":"srd","type":"content","title":"SRD","version":"1.0.0","systems":["dnd5e-2024"]}`)
	writeFile(t, filepath.Join(dir, "bestiary", "orc.json"), `{"name":"Орк"}`)
}

func TestSetWorldModulesRules(t *testing.T) {
	ctx := context.Background()
	m := modulesManager(t)
	withSRD(t, m)

	home, err := m.Create(ctx, "Хоумбрю", domain.SystemCustom)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := m.SetWorldModules(ctx, home.ID, []string{"extra"}); err != nil || strings.Join(got, ",") != "extra" {
		t.Fatalf("универсальный контент в «Своей системе»: %v %v", got, err)
	}
	for _, id := range []string{"srd", "dnd5e-2024"} {
		if _, err := m.SetWorldModules(ctx, home.ID, []string{"extra", id}); err == nil {
			t.Errorf("%s включился в «Своей системе»", id)
		}
	}

	dnd, err := m.Create(ctx, "D&D", domain.SystemDnD5e2024)
	if err != nil {
		t.Fatal(err)
	}
	got, err := m.SetWorldModules(ctx, dnd.ID, []string{"srd", "extra"})
	if err != nil || strings.Join(got, ",") != "dnd5e-2024,srd,extra" {
		t.Fatalf("система мира остаётся всегда: %v %v", got, err)
	}
	if got, err := m.SetWorldModules(ctx, dnd.ID, []string{"extra", "dnd5e-2024"}); err != nil || strings.Join(got, ",") != "extra,dnd5e-2024" {
		t.Fatalf("порядок с системой в списке: %v %v", got, err)
	}
}

func TestSetWorldSystem(t *testing.T) {
	ctx := context.Background()
	m := modulesManager(t)
	withSRD(t, m)
	t.Cleanup(m.Shutdown)

	c, err := m.Create(ctx, "Мир", domain.SystemCustom)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.SetWorldModules(ctx, c.ID, []string{domain.BaseModuleID, "extra"}); err != nil {
		t.Fatal(err)
	}
	if err := m.accounts.Create(ctx, &domain.Account{
		ID: "acc-p", Username: "player", PasswordHash: "h",
		Role: domain.AccountRolePlayer, Status: domain.AccountStatusActive, CompanyID: c.ID,
	}); err != nil {
		t.Fatal(err)
	}
	sheet := domain.CharacterSheet{Extra: domain.Extra{"abilities": json.RawMessage(`{"str":18}`)}}
	if err := sqlite.NewCharacterStore(m.db, c.ID, c.System).Create(ctx, &domain.Character{ID: "char-p", AccountID: "acc-p", Name: "Пик", Sheet: sheet}); err != nil {
		t.Fatal(err)
	}
	if err := m.Launch(ctx, c.ID); err != nil {
		t.Fatal(err)
	}
	screen := &worldClient{}
	m.Current().Room.Join(screen)
	screen.waitJoined(t)

	if _, err := m.SetWorldSystem(ctx, c.ID, "pathfinder"); err == nil {
		t.Fatal("сменили на неустановленную систему")
	}
	disabled, err := m.SetWorldSystem(ctx, c.ID, domain.SystemDnD5e2024)
	if err != nil || len(disabled) != 0 {
		t.Fatalf("смена на D&D: %v %v", disabled, err)
	}
	world, _ := m.companies.ByID(ctx, c.ID)
	if world.System != domain.SystemDnD5e2024 || strings.Join(world.Modules, ",") != "dnd5e-2024,extra" {
		t.Fatalf("после смены: %s %v", world.System, world.Modules)
	}
	if m.Current().Company.System != domain.SystemDnD5e2024 {
		t.Fatal("мир не перезапущен на новой системе")
	}
	if !screen.reloaded() || !screen.closed {
		t.Fatalf("экран не получил world_reload и не отключён: %v %v", screen.got, screen.closed)
	}
	ch, err := sqlite.NewCharacterStore(m.db, c.ID, domain.SystemDnD5e2024).ByID(ctx, "char-p")
	if err != nil || ch.System != domain.SystemDnD5e2024 || string(ch.Sheet.Extra["abilities"]) != `{"str":18}` {
		t.Fatalf("персонаж после смены: %+v %v", ch, err)
	}

	if _, err := m.SetWorldModules(ctx, c.ID, []string{"srd", "extra"}); err != nil {
		t.Fatal(err)
	}
	disabled, err = m.SetWorldSystem(ctx, c.ID, domain.SystemCustom)
	if err != nil || strings.Join(disabled, ",") != "srd" {
		t.Fatalf("обратно на «Свою»: выключены %v %v", disabled, err)
	}
	world, _ = m.companies.ByID(ctx, c.ID)
	if strings.Join(world.Modules, ",") != "base,extra" {
		t.Fatalf("модули «Своей системы»: %v", world.Modules)
	}
	ch, _ = sqlite.NewCharacterStore(m.db, c.ID, domain.SystemCustom).ByID(ctx, "char-p")
	if string(ch.Sheet.Extra["abilities"]) != `{"str":18}` {
		t.Fatal("поля D&D потерялись при обратной смене")
	}
}

func TestStoppedRoomDoesNotHang(t *testing.T) {
	ctx := context.Background()
	m := modulesManager(t)
	t.Cleanup(m.Shutdown)
	c, err := m.Create(ctx, "Мир", domain.SystemDnD5e2024)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Launch(ctx, c.ID); err != nil {
		t.Fatal(err)
	}
	room := m.Current().Room
	room.Shutdown()
	room.Shutdown()
	late := &worldClient{}
	done := make(chan struct{})
	go func() {
		room.Join(late)
		room.Dispatch(late, domain.ClientMsg{Type: "ping"})
		room.Leave(late)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("остановленная комната заблокировала клиента")
	}
	if !late.closed {
		t.Fatal("опоздавший клиент не отключён")
	}
}

func TestEnabledModulesLegacyWorld(t *testing.T) {
	m := modulesManager(t)
	root := filepath.Join(t.TempDir(), "modules")
	srd := filepath.Join(root, "srd")
	writeFile(t, filepath.Join(srd, "module.json"),
		`{"format":"beacon-module/v1","id":"srd","type":"content","title":"SRD","version":"1.0.0","legacyIds":true,"systems":["dnd5e-2024"]}`)
	writeFile(t, filepath.Join(srd, "bestiary", "goblin.json"), `{"name":"Гоблин"}`)
	other := filepath.Join(root, "other-srd")
	writeFile(t, filepath.Join(other, "module.json"),
		`{"format":"beacon-module/v1","id":"other-srd","type":"content","title":"Другой","version":"1.0.0","legacyIds":true,"systems":["dnd5e-2014"]}`)
	plain := filepath.Join(root, "plain")
	writeFile(t, filepath.Join(plain, "module.json"), `{"format":"beacon-module/v1","id":"plain","type":"content","title":"Без старых id","version":"1.0.0","systems":["dnd5e-2024"]}`)
	dnd, err := m.modules.Get("dnd5e-2024")
	if err != nil {
		t.Fatal(err)
	}
	m.modules = module.NewRegistry(root, []*module.Module{dnd, base.Module()}, nil, "")

	legacy := &domain.Company{System: "dnd5e-2024"}
	if got := m.EnabledModules(legacy); len(got) != 2 || got[0] != "dnd5e-2024" || got[1] != "srd" {
		t.Fatalf("мир до модулей: %v", got)
	}
	if got := legacy.EnabledModules(); len(got) != 1 {
		t.Fatalf("данные мира не должны меняться: %v", got)
	}
	explicit := &domain.Company{System: "dnd5e-2024", Modules: []string{"dnd5e-2024"}}
	if got := m.EnabledModules(explicit); len(got) != 1 {
		t.Fatalf("мир со списком: %v", got)
	}
	gone := &domain.Company{System: "no-such-system"}
	if got := m.EnabledModules(gone); len(got) != 2 || got[0] != domain.BaseModuleID || got[1] != "no-such-system" {
		t.Fatalf("система не установлена: %v", got)
	}
	custom := &domain.Company{System: domain.SystemCustom}
	if got := m.EnabledModules(custom); len(got) != 1 || got[0] != domain.BaseModuleID {
		t.Fatalf("«Своя система»: %v", got)
	}
}
