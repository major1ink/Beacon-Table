package conditionfile

import (
	"context"
	"os"
	"path/filepath"
	"testing"
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
