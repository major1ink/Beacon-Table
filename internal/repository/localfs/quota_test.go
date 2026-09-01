package localfs

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"beacon-table/internal/domain"
	"beacon-table/internal/quota"
)

// TestSaveRejectsOversizedAndLeavesNoTrace — файл, не влезающий в квоту, не
// должен остаться на диске обрывком: иначе «место кончилось» ещё и съедало
// бы остаток места.
func TestSaveRejectsOversizedAndLeavesNoTrace(t *testing.T) {
	root := t.TempDir()
	tr := quota.New(root, 0, 1000)
	store := NewStore(root, "/uploads/", tr.World(root))

	_, err := store.Save(context.Background(), domain.AssetKindMaps, "", "huge.png",
		strings.NewReader(strings.Repeat("x", 5000)))
	if err == nil {
		t.Fatal("файл сверх квоты сохранён")
	}
	if !errors.Is(err, domain.ErrNoSpace) {
		t.Fatalf("ошибка не ErrNoSpace: %v", err)
	}

	left, _ := quota.DirSize(root)
	if left != 0 {
		t.Fatalf("после отказа на диске осталось %d байт", left)
	}
	entries, _ := os.ReadDir(filepath.Join(root, domain.AssetKindMaps))
	if len(entries) != 0 {
		t.Fatalf("в каталоге остались файлы: %v", entries)
	}
}

// TestSaveCountsAndDeleteReturnsSpace — записанное учитывается, удалённое
// возвращается: без этого «удалите лишнее» не помогало бы.
func TestSaveCountsAndDeleteReturnsSpace(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	tr := quota.New(root, 0, 1000)
	world := tr.World(root)
	store := NewStore(root, "/uploads/", world)

	url, err := store.Save(ctx, domain.AssetKindMaps, "", "map.png", strings.NewReader(strings.Repeat("x", 600)))
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if got := world.Used(); got != 600 {
		t.Fatalf("учтено %d байт, ожидалось 600", got)
	}

	// Второй такой же уже не влезает (600+600 > 1000).
	if _, err := store.Save(ctx, domain.AssetKindMaps, "", "map2.png", strings.NewReader(strings.Repeat("x", 600))); !errors.Is(err, domain.ErrNoSpace) {
		t.Fatalf("вторая карта прошла при исчерпанной квоте: %v", err)
	}

	if err := store.DeleteAsset(ctx, domain.AssetKindMaps, url); err != nil {
		t.Fatalf("DeleteAsset: %v", err)
	}
	if got := world.Used(); got != 0 {
		t.Fatalf("после удаления учтено %d байт, ожидалось 0", got)
	}
	if _, err := store.Save(ctx, domain.AssetKindMaps, "", "map3.png", strings.NewReader(strings.Repeat("x", 600))); err != nil {
		t.Fatalf("после освобождения места запись не прошла: %v", err)
	}
}

// TestDeleteFolderReturnsSpace — удаление папки возвращает место за всё её
// содержимое, а не за один файл.
func TestDeleteFolderReturnsSpace(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	tr := quota.New(root, 0, 10000)
	world := tr.World(root)
	store := NewStore(root, "/uploads/", world)

	for _, name := range []string{"a.png", "b.png"} {
		if _, err := store.Save(ctx, domain.AssetKindProps, "лес", name, strings.NewReader(strings.Repeat("x", 500))); err != nil {
			t.Fatalf("Save %s: %v", name, err)
		}
	}
	if got := world.Used(); got != 1000 {
		t.Fatalf("учтено %d байт, ожидалось 1000", got)
	}
	if err := store.DeleteFolder(ctx, domain.AssetKindProps, "лес"); err != nil {
		t.Fatalf("DeleteFolder: %v", err)
	}
	if got := world.Used(); got != 0 {
		t.Fatalf("после удаления папки учтено %d байт, ожидалось 0", got)
	}
}

// TestStoreWithoutQuota — без квоты (nil) хранилище работает как раньше.
func TestStoreWithoutQuota(t *testing.T) {
	root := t.TempDir()
	store := NewStore(root, "/uploads/", nil)

	if _, err := store.Save(context.Background(), domain.AssetKindMaps, "", "map.png",
		strings.NewReader(strings.Repeat("x", 100000))); err != nil {
		t.Fatalf("Save без квоты: %v", err)
	}
}
