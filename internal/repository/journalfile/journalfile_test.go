package journalfile

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"beacon-table/internal/domain"
)

// Шапка с правами — часть самого .md-файла (см. package-doc), поэтому и
// проверяем её через диск: что записали, то и лежит, и правка одной половины
// файла не трогает другую.

func TestFrontMatterRoundTrip(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	s := NewStore(root)

	in := &domain.JournalEntry{
		ID: "e1", Folder: "Глава 1", Content: "# Тайник\n\nПод третьей доской.\n",
		Sharing: domain.Sharing{
			OwnerID: "acc-gwen", OwnerName: "Гвен",
			Default: domain.JournalLimited,
			Access:  map[string]domain.JournalAccess{"acc-dm": domain.JournalObserver, "acc-tom": domain.JournalOwner},
		},
	}
	if err := s.Create(ctx, in); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(root, "Глава 1", "e1.md"))
	if err != nil {
		t.Fatalf("файл записи не там, где ожидали: %v", err)
	}
	if !strings.HasPrefix(string(raw), "---\n") {
		t.Fatalf("файл без шапки:\n%s", raw)
	}
	if !strings.Contains(string(raw), "# Тайник") {
		t.Fatalf("текст записи потерялся:\n%s", raw)
	}

	got, err := s.Get(ctx, "e1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "Тайник" {
		t.Fatalf("заголовок %q — шапка не отрезана перед разбором?", got.Title)
	}
	if got.Content != in.Content {
		t.Fatalf("текст не совпал: %q", got.Content)
	}
	if got.OwnerID != "acc-gwen" || got.OwnerName != "Гвен" || got.Default != domain.JournalLimited {
		t.Fatalf("шапка прочиталась неверно: %+v", got)
	}
	if got.Access["acc-tom"] != domain.JournalOwner || got.Access["acc-dm"] != domain.JournalObserver {
		t.Fatalf("права прочитались неверно: %+v", got.Access)
	}
	if got.Folder != "Глава 1" {
		t.Fatalf("папка %q", got.Folder)
	}
}

// Текст и права правятся РАЗНЫМИ операциями (см. JournalRepository.SetAccess)
// именно затем, чтобы автосейв текста не затирал только что выданный доступ —
// проверяем обе стороны этой независимости.
func TestUpdateAndSetAccessAreIndependent(t *testing.T) {
	ctx := context.Background()
	s := NewStore(t.TempDir())
	if err := s.Create(ctx, &domain.JournalEntry{ID: "e1", Content: "# Было\n", Sharing: domain.Sharing{OwnerID: "a", Default: domain.JournalNone}}); err != nil {
		t.Fatal(err)
	}

	if ok, err := s.SetAccess(ctx, "e1", domain.JournalObserver, map[string]domain.JournalAccess{"b": domain.JournalOwner}); err != nil || !ok {
		t.Fatalf("SetAccess: ok=%v err=%v", ok, err)
	}
	got, err := s.Get(ctx, "e1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Content != "# Было\n" {
		t.Fatalf("SetAccess затёр текст: %q", got.Content)
	}

	if ok, err := s.Update(ctx, "e1", "# Стало\n"); err != nil || !ok {
		t.Fatalf("Update: ok=%v err=%v", ok, err)
	}
	got, err = s.Get(ctx, "e1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Content != "# Стало\n" {
		t.Fatalf("текст не обновился: %q", got.Content)
	}
	if got.Default != domain.JournalObserver || got.Access["b"] != domain.JournalOwner || got.OwnerID != "a" {
		t.Fatalf("Update затёр шапку: %+v", got)
	}
}

func TestListWithoutContentAndMissing(t *testing.T) {
	ctx := context.Background()
	s := NewStore(t.TempDir())
	if err := s.Create(ctx, &domain.JournalEntry{ID: "e1", Content: "# Раз\n", Sharing: domain.Sharing{Default: domain.JournalNone}}); err != nil {
		t.Fatal(err)
	}
	if err := s.Create(ctx, &domain.JournalEntry{ID: "e2", Folder: "Папка", Content: "# Два\n", Sharing: domain.Sharing{Default: domain.JournalObserver}}); err != nil {
		t.Fatal(err)
	}
	list, err := s.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("записей %d, ожидали 2", len(list))
	}
	for _, e := range list {
		if e.Content != "" {
			t.Fatalf("в списке приехал текст записи %s", e.ID)
		}
		if e.Title == "Без названия" {
			t.Fatalf("заголовок не вывелся для %s — шапка помешала?", e.ID)
		}
	}

	if ok, err := s.Update(ctx, "нет-такой", "# Что-то\n"); err != nil || ok {
		t.Fatalf("Update несуществующей: ok=%v err=%v", ok, err)
	}
	if err := s.Delete(ctx, "нет-такой"); err != nil {
		t.Fatalf("удаление несуществующей — не ошибка: %v", err)
	}
}

// Файл без шапки (заведён руками в файловом менеджере) — валидная запись без
// автора и без выданных прав, а не повод уронить список.
func TestFileWithoutFrontMatter(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	if err := os.MkdirAll(root, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "manual.md"), []byte("# Руками\n\nтекст\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := NewStore(root)
	got, err := s.Get(ctx, "manual")
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "Руками" || got.OwnerID != "" || got.Default != domain.JournalNone || len(got.Access) != 0 {
		t.Fatalf("файл без шапки прочитан неверно: %+v", got)
	}
}

func TestFolders(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	s := NewStore(root)
	if err := s.CreateFolder(ctx, "Хроники/Глава 1"); err != nil {
		t.Fatal(err)
	}
	folders, err := s.Folders(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(folders) != 2 || folders[0] != "Хроники" || folders[1] != "Хроники/Глава 1" {
		t.Fatalf("папки: %+v", folders)
	}
	if err := s.Create(ctx, &domain.JournalEntry{ID: "e1", Folder: "Хроники/Глава 1", Content: "# Тут\n"}); err != nil {
		t.Fatal(err)
	}
	if ok, err := s.Move(ctx, "e1", ""); err != nil || !ok {
		t.Fatalf("Move: ok=%v err=%v", ok, err)
	}
	if _, err := os.Stat(filepath.Join(root, "e1.md")); err != nil {
		t.Fatalf("после переноса файл не в корне: %v", err)
	}
	if err := s.RenameFolder(ctx, "Хроники", "Хроники/Внутрь"); err == nil {
		t.Fatal("перенос папки внутрь самой себя должен быть отклонён")
	}
}
