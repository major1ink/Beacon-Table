package cardcatalog_test

import (
	"context"
	"errors"
	"testing"
	"testing/fstest"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository/monsterfile"
)

func TestCatalogWithSeveralModules(t *testing.T) {
	ctx := context.Background()
	fsys := fstest.MapFS{
		"dnd24/goblin.json":           {Data: []byte(`{"name":"Гоблин 2024"}`)},
		"dnd14/goblin.json":           {Data: []byte(`{"name":"Гоблин 2014"}`)},
		"extra/bestiary/owlbear.json": {Data: []byte(`{"name":"Совомедведь"}`)},
		"extra/bestiary/broken.json":  {Data: []byte(`{`)},
	}
	user := monsterfile.NewStore(t.TempDir())
	if err := user.Create(ctx, "abc123", &domain.Monster{ID: "abc123", Name: "Атаман", System: true, Module: "подделка"}); err != nil {
		t.Fatal(err)
	}
	cat := monsterfile.NewCatalog(user,
		monsterfile.NewModuleStore(fsys, "dnd24", "sys-", "dnd5e-2024"),
		monsterfile.NewModuleStore(fsys, "dnd14", "sys-", "dnd5e-2014"),
		monsterfile.NewModuleStore(fsys, "extra/bestiary", "extra--", "extra"),
	)

	list, err := cat.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, m := range list {
		names = append(names, m.ID+"|"+m.Name+"|"+m.Module)
	}
	want := []string{
		"abc123|Атаман|",
		"sys-goblin|Гоблин 2014|dnd5e-2014",
		"sys-goblin|Гоблин 2024|dnd5e-2024",
		"extra--owlbear|Совомедведь|extra",
	}
	if len(names) != len(want) {
		t.Fatalf("список: %v", names)
	}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("список[%d] = %q, ждали %q (весь: %v)", i, names[i], want[i], names)
		}
	}

	// Два модуля с legacy-id: карточку по id отдаёт подключённый раньше.
	g, err := cat.Get(ctx, "sys-goblin")
	if err != nil || g.Name != "Гоблин 2024" || !g.System || g.Module != "dnd5e-2024" {
		t.Fatalf("sys-goblin: %+v %v", g, err)
	}
	o, err := cat.Get(ctx, "extra--owlbear")
	if err != nil || o.Module != "extra" || !o.System {
		t.Fatalf("extra--owlbear: %+v %v", o, err)
	}
	// Карточка библиотеки мира: пометки модуля снимаются, даже если файл
	// поправили руками.
	a, err := cat.Get(ctx, "abc123")
	if err != nil || a.System || a.Module != "" {
		t.Fatalf("карточка мира: %+v %v", a, err)
	}

	// Карточки модулей — только чтение, в том числе модуля, которого в
	// мире сейчас нет.
	for _, id := range []string{"sys-goblin", "extra--owlbear", "gone--wolf", "sys-nothing"} {
		if _, err := cat.Update(ctx, id, &domain.Monster{Name: "x"}); !errors.Is(err, domain.ErrForbidden) {
			t.Errorf("Update %s: %v", id, err)
		}
		if err := cat.Delete(ctx, id); !errors.Is(err, domain.ErrForbidden) {
			t.Errorf("Delete %s: %v", id, err)
		}
	}
	// Модуль выключен — его карточки просто не находятся.
	if _, err := cat.Get(ctx, "gone--wolf"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("карточка выключенного модуля: %v", err)
	}
	// Путь в id не выводит за папку модуля.
	if _, err := cat.Get(ctx, "extra--../../dnd24/goblin"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("id с путём: %v", err)
	}

	// Create пишет в библиотеку мира и снимает пометки модуля.
	m := &domain.Monster{ID: "def456", Name: "Клон", System: true, Module: "extra"}
	if err := cat.Create(ctx, "def456", m); err != nil {
		t.Fatal(err)
	}
	if got, _ := user.Get(ctx, "def456"); got.System || got.Module != "" {
		t.Fatalf("клон в библиотеке с пометками модуля: %+v", got)
	}
}
