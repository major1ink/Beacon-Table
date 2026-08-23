package notefile

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"beacon-table/internal/domain"
)

// Папки библиотеки заметок — настоящие каталоги на диске (см. package-doc),
// поэтому и проверяем их через диск: где реально лежит файл после создания,
// переноса и переименования папки.

func TestNotesFolders(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	s := NewStore(root)

	if err := s.Create(ctx, "n1", "", "# В корне\n"); err != nil {
		t.Fatal(err)
	}
	if err := s.Create(ctx, "n2", "Приключение/Глава 1", "# В главе\n"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "notes", "Приключение", "Глава 1", "n2.md")); err != nil {
		t.Fatalf("заметка не легла в подпапку: %v", err)
	}

	notes, err := s.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(notes) != 2 {
		t.Fatalf("заметок %d, ожидали 2: %+v", len(notes), notes)
	}
	byID := map[string]*domain.Note{}
	for _, n := range notes {
		byID[n.ID] = n
	}
	if byID["n1"].Folder != "" || byID["n2"].Folder != "Приключение/Глава 1" {
		t.Fatalf("папки в списке неверные: %q / %q", byID["n1"].Folder, byID["n2"].Folder)
	}
	if byID["n2"].Title != "В главе" {
		t.Fatalf("заголовок из подпапки: %q", byID["n2"].Title)
	}

	// Get находит заметку в любой папке, не зная о ней заранее.
	got, err := s.Get(ctx, "n2")
	if err != nil {
		t.Fatal(err)
	}
	if got.Folder != "Приключение/Глава 1" || got.Content != "# В главе\n" {
		t.Fatalf("Get вернул не то: %+v", got)
	}

	// Правка текста не переносит файл.
	if ok, err := s.Update(ctx, "n2", "# В главе (правка)\n"); err != nil || !ok {
		t.Fatalf("Update: ok=%v err=%v", ok, err)
	}
	if got, _ = s.Get(ctx, "n2"); got.Folder != "Приключение/Глава 1" {
		t.Fatalf("Update увёл заметку из папки: %q", got.Folder)
	}

	// Перенос: файл переезжает, id остаётся (на него ссылаются маркеры карты).
	if ok, err := s.Move(ctx, "n2", "Приключение/Глава 2"); err != nil || !ok {
		t.Fatalf("Move: ok=%v err=%v", ok, err)
	}
	if _, err := os.Stat(filepath.Join(root, "notes", "Приключение", "Глава 2", "n2.md")); err != nil {
		t.Fatalf("после переноса файла нет на новом месте: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "notes", "Приключение", "Глава 1", "n2.md")); !os.IsNotExist(err) {
		t.Fatalf("после переноса файл остался на старом месте: %v", err)
	}

	// Пустая папка не пропадает из списка — её только что освободили.
	folders, err := s.Folders(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !contains(folders, "Приключение/Глава 1") || !contains(folders, "Приключение/Глава 2") {
		t.Fatalf("список папок: %v", folders)
	}
}

func TestNoteFolderRenameAndDelete(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	s := NewStore(root)
	if err := s.Create(ctx, "n1", "Старое/Внутри", "# Заметка\n"); err != nil {
		t.Fatal(err)
	}

	if err := s.RenameFolder(ctx, "Старое", "Новое"); err != nil {
		t.Fatal(err)
	}
	got, err := s.Get(ctx, "n1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Folder != "Новое/Внутри" {
		t.Fatalf("папка после переименования: %q", got.Folder)
	}

	// Перенос папки внутрь самой себя os.Rename трактует по-разному на
	// разных ОС — отклоняем сами, до файловой системы.
	if err := s.RenameFolder(ctx, "Новое", "Новое/Вложенное"); err == nil {
		t.Fatal("перенос папки внутрь себя должен отклоняться")
	}
	if err := s.CreateFolder(ctx, "Другое"); err != nil {
		t.Fatal(err)
	}
	if err := s.RenameFolder(ctx, "Новое", "Другое"); err == nil {
		t.Fatal("переименование поверх существующей папки должно отклоняться")
	}

	// Удаление папки уносит и заметки внутри.
	if err := s.DeleteFolder(ctx, "Новое"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get(ctx, "n1"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("заметка пережила удаление папки: %v", err)
	}
	if err := s.DeleteFolder(ctx, ""); err == nil {
		t.Fatal("корень библиотеки удалять нельзя")
	}
}

// TestNoteFolderEscape — путь папки приходит из чужого импорта, поэтому
// выход за пределы библиотеки должен отклоняться на уровне хранилища, а не
// только валидацией сервиса.
func TestNoteFolderEscape(t *testing.T) {
	ctx := context.Background()
	s := NewStore(t.TempDir())
	if err := s.Create(ctx, "n1", "../снаружи", "# Нет\n"); err == nil {
		t.Fatal("путь с .. должен отклоняться")
	}
	if err := s.CreateFolder(ctx, "a/../../b"); err == nil {
		t.Fatal("путь с .. должен отклоняться")
	}
}

func contains(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}
