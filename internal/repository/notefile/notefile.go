// Package notefile реализует repository.NoteRepository поверх обычных
// .md-файлов на диске: по файлу на заметку (dataDir/notes/<папка>/<id>.md),
// тот же принцип, что и internal/repository/scenefile для сцен — атомарная
// запись (tmp + rename) не роняет остальную библиотеку при падении посреди
// записи одного файла, и заметки остаются реальными текстовыми файлами: их
// можно открыть/отредактировать/забэкапить в обход приложения.
//
// Папки библиотеки (domain.Note.Folder) — настоящие подпапки на диске, а не
// поле в индексе: дерево, которое ДМ видит в панели, ровно то же, что он
// увидит файловым менеджером, и папку можно создать/переименовать обоими
// способами. Плата за это — поиск файла по id обходом дерева (см. find):
// заметок у стола сотни, не миллионы, а альтернатива (индекс id→путь) — ещё
// один файл, который может разойтись с реальностью.
//
// ID заметки — стабильный (генерируется один раз при создании, service.newID()),
// а НЕ производный от заголовка: заголовок — это просто первая строка вида
// "# Заголовок" внутри самого файла (см. deriveTitle), меняется обычной правкой
// текста. Так переименование не роняет ничего, что ссылается на заметку по ID
// (маркер на карте, вики-ссылки из других заметок — те резолвятся по текущему
// заголовку уже на клиенте, не по ID). Перенос в другую папку тоже не меняет
// id — файл переезжает, ссылки живут (см. Move).
package notefile

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"beacon-table/internal/domain"
)

// Store реализует repository.NoteRepository.
type Store struct {
	notesDir string
}

// NewStore создаёт репозиторий заметок в dataDir/notes.
func NewStore(dataDir string) *Store {
	return &Store{notesDir: filepath.Join(dataDir, "notes")}
}

var unsafeIDChars = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// fileName — имя файла заметки по её ID. ID уже filesystem-safe (генерируется
// как hex-строка, см. service.newID()), санитайзер — на случай ручной правки
// файлов на диске мимо приложения.
func fileName(id string) string {
	safe := unsafeIDChars.ReplaceAllString(id, "_")
	if safe == "" {
		safe = "note"
	}
	return safe + ".md"
}

// sanitizeFolder нормализует posix-путь папки, присланный вызывающим:
// обрезает крайние "/", разбивает на сегменты и отклоняет пустые/"."/".." —
// та же защита от выхода за пределы notesDir, что и в localfs.sanitizeFolder
// для библиотеки ассетов (дублируется осознанно: пакеты репозиториев ничего
// друг о друге не знают).
func sanitizeFolder(folder string) (string, error) {
	folder = strings.TrimSpace(strings.ReplaceAll(folder, "\\", "/"))
	folder = strings.Trim(folder, "/")
	if folder == "" {
		return "", nil
	}
	parts := strings.Split(folder, "/")
	clean := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" || p == "." || p == ".." {
			return "", fmt.Errorf("недопустимое имя папки")
		}
		clean = append(clean, p)
	}
	return strings.Join(clean, "/"), nil
}

// dirFor — абсолютный путь папки библиотеки.
func (s *Store) dirFor(folder string) (string, error) {
	folder, err := sanitizeFolder(folder)
	if err != nil {
		return "", err
	}
	if folder == "" {
		return s.notesDir, nil
	}
	return filepath.Join(s.notesDir, filepath.FromSlash(folder)), nil
}

// find — путь файла и папка заметки по её id. domain.ErrNotFound, если
// такого файла в дереве нет.
func (s *Store) find(id string) (path, folder string, err error) {
	target := fileName(id)
	walkErr := filepath.WalkDir(s.notesDir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // недоступная подпапка не должна прятать остальные
		}
		if d.IsDir() || d.Name() != target {
			return nil
		}
		path = p
		folder = s.folderOf(p)
		return fs.SkipAll
	})
	if walkErr != nil && !os.IsNotExist(walkErr) {
		return "", "", walkErr
	}
	if path == "" {
		return "", "", domain.ErrNotFound
	}
	return path, folder, nil
}

// folderOf — папка (posix, относительно корня библиотеки) по пути файла.
func (s *Store) folderOf(path string) string {
	rel, err := filepath.Rel(s.notesDir, filepath.Dir(path))
	if err != nil || rel == "." {
		return ""
	}
	return filepath.ToSlash(rel)
}

// deriveTitle — заголовок заметки: первая непустая строка вида "# Текст"
// (обычный H1 markdown), без "# " — если её нет, "Без названия". Та же логика
// продублирована на клиенте (web/src/notes/markdown.js:noteTitleFromContent)
// для мгновенного локального предпросмотра при вводе, до round-trip на сервер.
func deriveTitle(content string) string {
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "#") {
			if t := strings.TrimSpace(strings.TrimLeft(line, "#")); t != "" {
				return t
			}
		}
		break // первая непустая строка — не заголовок ("# ..."), дальше не ищем
	}
	return "Без названия"
}

func (s *Store) List(ctx context.Context) ([]*domain.Note, error) {
	notes := make([]*domain.Note, 0, 16)
	err := filepath.WalkDir(s.notesDir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() || filepath.Ext(d.Name()) != ".md" {
			return nil
		}
		//nolint:gosec // G304: p — путь, выданный обходом самого notesDir
		data, err := os.ReadFile(p)
		if err != nil {
			return nil // повреждённый/недоступный файл одной заметки не роняет список остальных
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		notes = append(notes, &domain.Note{
			ID:        strings.TrimSuffix(d.Name(), ".md"),
			Title:     deriveTitle(string(data)),
			Folder:    s.folderOf(p),
			UpdatedAt: info.ModTime(),
		})
		return nil
	})
	if err != nil {
		if os.IsNotExist(err) {
			return []*domain.Note{}, nil
		}
		return nil, err
	}
	// Сначала по папке, потом по заголовку — список и так группируют в
	// дерево на клиенте, но стабильный порядок нужен и без него.
	sort.Slice(notes, func(i, j int) bool {
		if notes[i].Folder != notes[j].Folder {
			return strings.ToLower(notes[i].Folder) < strings.ToLower(notes[j].Folder)
		}
		return strings.ToLower(notes[i].Title) < strings.ToLower(notes[j].Title)
	})
	return notes, nil
}

func (s *Store) Get(ctx context.Context, id string) (*domain.Note, error) {
	p, folder, err := s.find(id)
	if err != nil {
		return nil, err
	}
	//nolint:gosec // G304: p — путь, найденный обходом notesDir (см. find)
	data, err := os.ReadFile(p)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, domain.ErrNotFound
		}
		return nil, err
	}
	info, err := os.Stat(p)
	if err != nil {
		return nil, err
	}
	content := string(data)
	return &domain.Note{ID: id, Title: deriveTitle(content), Folder: folder, Content: content, UpdatedAt: info.ModTime()}, nil
}

// writeAtomic — общая запись Create/Update: во временный файл и переименование
// поверх целевого, как SaveScene в scenefile.go — падение/убийство процесса
// посреди записи не оставляет битый файл этой заметки.
func writeAtomic(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (s *Store) Create(ctx context.Context, id, folder, content string) error {
	dir, err := s.dirFor(folder)
	if err != nil {
		return err
	}
	return writeAtomic(filepath.Join(dir, fileName(id)), content)
}

func (s *Store) Update(ctx context.Context, id, content string) (bool, error) {
	p, _, err := s.find(id)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			return false, nil
		}
		return false, err
	}
	if err := writeAtomic(p, content); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Store) Move(ctx context.Context, id, folder string) (bool, error) {
	p, current, err := s.find(id)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			return false, nil
		}
		return false, err
	}
	dir, err := s.dirFor(folder)
	if err != nil {
		return false, err
	}
	if s.folderOf(filepath.Join(dir, fileName(id))) == current {
		return true, nil // уже там, лишний rename ни к чему
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return false, err
	}
	if err := os.Rename(p, filepath.Join(dir, fileName(id))); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Store) Delete(ctx context.Context, id string) error {
	p, _, err := s.find(id)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			return nil // удаление несуществующей заметки — не ошибка (как и раньше)
		}
		return err
	}
	err = os.Remove(p)
	if err != nil && os.IsNotExist(err) {
		return nil
	}
	return err
}

func (s *Store) Folders(ctx context.Context) ([]string, error) {
	out := make([]string, 0, 8)
	err := filepath.WalkDir(s.notesDir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() || p == s.notesDir {
			return nil
		}
		rel, err := filepath.Rel(s.notesDir, p)
		if err != nil {
			return nil
		}
		out = append(out, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		if os.IsNotExist(err) {
			return []string{}, nil
		}
		return nil, err
	}
	sort.Strings(out)
	return out, nil
}

func (s *Store) CreateFolder(ctx context.Context, folder string) error {
	dir, err := s.dirFor(folder)
	if err != nil {
		return err
	}
	if dir == s.notesDir {
		return fmt.Errorf("имя папки обязательно")
	}
	return os.MkdirAll(dir, 0o750)
}

func (s *Store) DeleteFolder(ctx context.Context, folder string) error {
	dir, err := s.dirFor(folder)
	if err != nil {
		return err
	}
	if dir == s.notesDir {
		return fmt.Errorf("нельзя удалить корневую папку")
	}
	return os.RemoveAll(dir)
}

func (s *Store) RenameFolder(ctx context.Context, from, to string) error {
	fromDir, err := s.dirFor(from)
	if err != nil {
		return err
	}
	toDir, err := s.dirFor(to)
	if err != nil {
		return err
	}
	if fromDir == s.notesDir || toDir == s.notesDir {
		return fmt.Errorf("имя папки обязательно")
	}
	if fromDir == toDir {
		return nil
	}
	// Переезд папки внутрь самой себя ("Глава 1" → "Глава 1/Старое") os.Rename
	// на разных ОС отрабатывает по-разному (где-то ошибка, где-то потеря
	// содержимого) — отсекаем сами.
	if strings.HasPrefix(toDir+string(filepath.Separator), fromDir+string(filepath.Separator)) {
		return fmt.Errorf("нельзя перенести папку внутрь самой себя")
	}
	if _, err := os.Stat(toDir); err == nil {
		return fmt.Errorf("папка «%s» уже существует", to)
	}
	if err := os.MkdirAll(filepath.Dir(toDir), 0o750); err != nil {
		return err
	}
	return os.Rename(fromDir, toDir)
}
