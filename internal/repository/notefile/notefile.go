// Package notefile реализует repository.NoteRepository поверх обычных
// .md-файлов на диске: по файлу на заметку (dataDir/notes/<id>.md), тот же
// принцип, что и internal/repository/scenefile для сцен — атомарная запись
// (tmp + rename) не роняет остальную библиотеку при падении посреди записи
// одного файла, и заметки остаются реальными текстовыми файлами: их можно
// открыть/отредактировать/забэкапить в обход приложения.
//
// ID заметки — стабильный (генерируется один раз при создании, service.newID()),
// а НЕ производный от заголовка: заголовок — это просто первая строка вида
// "# Заголовок" внутри самого файла (см. deriveTitle), меняется обычной правкой
// текста. Так переименование не роняет ничего, что ссылается на заметку по ID
// (маркер на карте, вики-ссылки из других заметок — те резолвятся по текущему
// заголовку уже на клиенте, не по ID).
package notefile

import (
	"context"
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

// notePath — путь файла заметки по её ID. ID уже filesystem-safe (генерируется
// как hex-строка, см. service.newID()), санитайзер — на случай ручной правки
// файлов на диске мимо приложения.
func (s *Store) notePath(id string) string {
	safe := unsafeIDChars.ReplaceAllString(id, "_")
	if safe == "" {
		safe = "note"
	}
	return filepath.Join(s.notesDir, safe+".md")
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
	entries, err := os.ReadDir(s.notesDir)
	if err != nil {
		if os.IsNotExist(err) {
			return []*domain.Note{}, nil
		}
		return nil, err
	}
	notes := make([]*domain.Note, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".md" {
			continue
		}
		p := filepath.Join(s.notesDir, e.Name())
		data, err := os.ReadFile(p)
		if err != nil {
			continue // повреждённый/недоступный файл одной заметки не роняет список остальных
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		id := strings.TrimSuffix(e.Name(), ".md")
		notes = append(notes, &domain.Note{
			ID:        id,
			Title:     deriveTitle(string(data)),
			UpdatedAt: info.ModTime(),
		})
	}
	sort.Slice(notes, func(i, j int) bool { return strings.ToLower(notes[i].Title) < strings.ToLower(notes[j].Title) })
	return notes, nil
}

func (s *Store) Get(ctx context.Context, id string) (*domain.Note, error) {
	p := s.notePath(id)
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
	return &domain.Note{ID: id, Title: deriveTitle(content), Content: content, UpdatedAt: info.ModTime()}, nil
}

// writeAtomic — общая запись Create/Update: во временный файл и переименование
// поверх целевого, как SaveScene в scenefile.go — падение/убийство процесса
// посреди записи не оставляет битый файл этой заметки.
func (s *Store) writeAtomic(id, content string) error {
	if err := os.MkdirAll(s.notesDir, 0o755); err != nil {
		return err
	}
	p := s.notePath(id)
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func (s *Store) Create(ctx context.Context, id, content string) error {
	return s.writeAtomic(id, content)
}

func (s *Store) Update(ctx context.Context, id, content string) (bool, error) {
	if _, err := os.Stat(s.notePath(id)); err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	if err := s.writeAtomic(id, content); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Store) Delete(ctx context.Context, id string) error {
	err := os.Remove(s.notePath(id))
	if err != nil && os.IsNotExist(err) {
		return nil
	}
	return err
}
