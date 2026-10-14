package conditionfile

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"beacon-table/internal/domain"
)

// Карточка, сохранённая до обязательного ключа, при чтении получает slug из
// ID — иначе палитра не даст её повесить (см. fillSlug).
func TestReadFillsMissingSlug(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(dir)
	if err := os.MkdirAll(store.dir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.dir, "abc.json"), []byte(`{"id":"abc","name":"Рана"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	c, err := store.Get(ctx, "abc")
	if err != nil {
		t.Fatal(err)
	}
	if c.Slug != "c-abc" {
		t.Fatalf("Get: slug = %q", c.Slug)
	}
	list, err := store.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Slug != "c-abc" {
		t.Fatalf("List: %+v", list)
	}
}

// Базовый модуль рядом с системным: на slug одна карточка — системная,
// своя из библиотеки мира важнее обеих.
func TestCatalogOneCardPerSlug(t *testing.T) {
	ctx := context.Background()
	system := fstest.MapFS{
		"conditions/frightened.json": {Data: []byte(`{"name":"Испуг","slug":"frightened"}`)},
		"conditions/invisible.json":  {Data: []byte(`{"name":"Невидимость","slug":"invisible"}`)},
	}
	base := fstest.MapFS{
		"conditions/frightened.json": {Data: []byte(`{"name":"Испуган","slug":"frightened"}`)},
		"conditions/invisible.json":  {Data: []byte(`{"name":"Невидим","slug":"invisible"}`)},
		"conditions/bleeding.json":   {Data: []byte(`{"name":"Кровоточит","slug":"bleeding"}`)},
	}
	user := NewStore(t.TempDir())
	cat := NewCatalog(user,
		NewModuleStore(base, "conditions", "base--", domain.BaseModuleID),
		NewModuleStore(system, "conditions", "dnd5e-2024--", "dnd5e-2024"),
	)
	names := func() string {
		list, err := cat.List(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, c := range list {
			out = append(out, c.Name)
		}
		return strings.Join(out, ", ")
	}
	if got := names(); got != "Испуг, Кровоточит, Невидимость" {
		t.Fatalf("база рядом с системой: %s", got)
	}
	if err := user.Create(ctx, "my", &domain.Condition{Name: "Испуг (мой)", Slug: "frightened"}); err != nil {
		t.Fatal(err)
	}
	if got := names(); got != "Испуг (мой), Кровоточит, Невидимость" {
		t.Fatalf("своя карточка: %s", got)
	}
}
