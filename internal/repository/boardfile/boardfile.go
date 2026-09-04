// Package boardfile реализует repository.BoardRepository поверх обычных
// .md-файлов на диске (dataDir/boards/<id>.md): атомарная запись (tmp +
// rename), никакого индекса — список собирается обходом каталога.
//
// Формат — тот же, что у журнала (см. internal/repository/journalfile): шапка
// front matter между "---", дальше тело файла. В шапке всё, кроме самого
// холста: имя доски, автор и раздача прав (см. domain.Board).
//
//	---
//	name: Схема расследования
//	owner: 6f1c…
//	ownerName: Гвен
//	default: none
//	access:
//	  a41b…: observer
//	---
//
// Тело сейчас пустое: элементы холста заводятся отдельной задачей вместе с
// решением про формат плагина Excalidraw для Obsidian. Файл при этом уже
// сегодня остаётся нормальной markdown-заметкой, которую ваулт открывает и
// показывает — то есть выбранный формат заведомо не придётся ломать ради
// совместимости, только дополнять телом.
//
// Разбор шапки написан здесь заново, а не переиспользован из journalfile, по
// той же причине, по какой там продублирована sanitizeFolder: пакеты
// репозиториев ничего друг о друге не знают, а шапки эти вот-вот разойдутся —
// у доски появится тело в формате Excalidraw, у записи журнала останется
// markdown.
package boardfile

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"beacon-table/internal/domain"
)

// Store реализует repository.BoardRepository.
type Store struct {
	dir string
}

// NewStore создаёт репозиторий досок в каталоге dir (обычно data/boards).
func NewStore(dir string) *Store {
	return &Store{dir: dir}
}

var unsafeIDChars = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

func fileName(id string) string {
	safe := unsafeIDChars.ReplaceAllString(id, "_")
	if safe == "" {
		safe = "board"
	}
	return safe + ".md"
}

func (s *Store) path(id string) string { return filepath.Join(s.dir, fileName(id)) }

// ---- шапка файла ----

type meta struct {
	Name      string
	OwnerID   string
	OwnerName string
	Default   domain.JournalAccess
	Access    map[string]domain.JournalAccess
}

// splitFrontMatter разбирает файл на шапку и тело. Файл без шапки (создан
// руками в ваулте) — это не ошибка: доска без автора с правами по умолчанию.
func splitFrontMatter(raw string) (meta, string) {
	m := meta{Default: domain.JournalNone, Access: map[string]domain.JournalAccess{}}
	rest := strings.TrimPrefix(raw, "\ufeff") // BOM от редактора не должен прятать шапку
	if !strings.HasPrefix(rest, "---\n") && !strings.HasPrefix(rest, "---\r\n") {
		return m, raw
	}
	lines := strings.Split(rest, "\n")
	end := -1
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			end = i
			break
		}
	}
	if end < 0 {
		return m, raw // незакрытая шапка — считаем, что её нет, тело не теряем
	}
	inAccess := false
	for _, line := range lines[1:end] {
		if strings.TrimSpace(line) == "" {
			continue
		}
		indented := strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t")
		key, value, ok := strings.Cut(strings.TrimSpace(strings.TrimRight(line, "\r")), ":")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if inAccess && indented {
			if level := domain.JournalAccess(value); level.Valid() && key != "" {
				m.Access[key] = level
			}
			continue
		}
		inAccess = false
		switch key {
		case "name":
			m.Name = value
		case "owner":
			m.OwnerID = value
		case "ownerName":
			m.OwnerName = value
		case "default":
			if level := domain.JournalAccess(value); level.Valid() {
				m.Default = level
			}
		case "access":
			inAccess = true
		}
	}
	body := strings.Join(lines[end+1:], "\n")
	return m, body
}

// oneLine — значение шапки не должно разъехаться на несколько строк и
// сломать разбор соседних полей.
func oneLine(s string) string {
	s = strings.ReplaceAll(s, "\r", " ")
	s = strings.ReplaceAll(s, "\n", " ")
	return strings.TrimSpace(s)
}

func withFrontMatter(m meta, body string) string {
	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString("name: " + oneLine(m.Name) + "\n")
	if m.OwnerID != "" {
		b.WriteString("owner: " + oneLine(m.OwnerID) + "\n")
	}
	if m.OwnerName != "" {
		b.WriteString("ownerName: " + oneLine(m.OwnerName) + "\n")
	}
	def := m.Default
	if !def.Valid() {
		def = domain.JournalNone
	}
	b.WriteString("default: " + string(def) + "\n")
	if len(m.Access) > 0 {
		ids := make([]string, 0, len(m.Access))
		for id := range m.Access {
			ids = append(ids, id)
		}
		sort.Strings(ids) // стабильный порядок: файл не должен «меняться» от пересохранения
		b.WriteString("access:\n")
		for _, id := range ids {
			level := m.Access[id]
			if !level.Valid() || level == domain.JournalNone || strings.TrimSpace(id) == "" {
				continue // "none" — это и есть отсутствие выдачи, хранить нечего
			}
			b.WriteString("  " + oneLine(id) + ": " + string(level) + "\n")
		}
	}
	b.WriteString("---\n")
	b.WriteString(body)
	return b.String()
}

func boardFrom(id, raw string) *domain.Board {
	m, _ := splitFrontMatter(raw)
	name := strings.TrimSpace(m.Name)
	if name == "" {
		name = "Без названия"
	}
	return &domain.Board{
		ID:   id,
		Name: name,
		Sharing: domain.Sharing{
			OwnerID:   m.OwnerID,
			OwnerName: m.OwnerName,
			Default:   m.Default,
			Access:    m.Access,
		},
	}
}

// ---- repository.BoardRepository ----

func (s *Store) List(ctx context.Context) ([]*domain.Board, error) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []*domain.Board{}, nil // каталога ещё нет — досок просто нет
		}
		return nil, err
	}
	out := make([]*domain.Board, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		id := strings.TrimSuffix(e.Name(), ".md")
		b, err := s.Get(ctx, id)
		if err != nil {
			continue // битый или исчезнувший файл не должен ронять весь список
		}
		out = append(out, b)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].UpdatedAt.Equal(out[j].UpdatedAt) {
			return out[i].UpdatedAt.After(out[j].UpdatedAt)
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

func (s *Store) Get(ctx context.Context, id string) (*domain.Board, error) {
	p := s.path(id)
	raw, err := os.ReadFile(p)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, domain.ErrNotFound
		}
		return nil, err
	}
	b := boardFrom(id, string(raw))
	if info, err := os.Stat(p); err == nil {
		b.UpdatedAt = info.ModTime()
	}
	return b, nil
}

func (s *Store) Create(ctx context.Context, b *domain.Board) error {
	if _, err := os.Stat(s.path(b.ID)); err == nil {
		return domain.ErrConflict
	}
	return s.save(b, "")
}

// Rename и SetAccess меняют ТОЛЬКО шапку, тело файла переписывается как есть.
// Отдельные методы, а не общий Update: тело — это холст, который вот-вот
// начнёт автосейвиться при рисовании, и класть в тот же запрос ещё и права
// значило бы гонять их туда-сюда на каждый штрих (а гонка двух окон —
// затирать только что выданный доступ). Та же причина, что у журнала.
func (s *Store) Rename(ctx context.Context, id, name string) (bool, error) {
	b, body, err := s.load(id)
	if err != nil {
		return false, err
	}
	if b == nil {
		return false, nil
	}
	b.Name = name
	return true, s.save(b, body)
}

func (s *Store) SetAccess(ctx context.Context, id string, def domain.JournalAccess, access map[string]domain.JournalAccess) (bool, error) {
	b, body, err := s.load(id)
	if err != nil {
		return false, err
	}
	if b == nil {
		return false, nil
	}
	b.Default = def
	b.Access = access
	return true, s.save(b, body)
}

func (s *Store) Delete(ctx context.Context, id string) error {
	if err := os.Remove(s.path(id)); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return domain.ErrNotFound
		}
		return err
	}
	return nil
}

// load — доска вместе с нетронутым телом файла: правки шапки не должны
// зависеть от того, понимаем ли мы уже содержимое холста.
func (s *Store) load(id string) (*domain.Board, string, error) {
	raw, err := os.ReadFile(s.path(id))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, "", nil
		}
		return nil, "", err
	}
	_, body := splitFrontMatter(string(raw))
	return boardFrom(id, string(raw)), body, nil
}

func (s *Store) save(b *domain.Board, body string) error {
	m := meta{Name: b.Name, OwnerID: b.OwnerID, OwnerName: b.OwnerName, Default: b.Default, Access: b.Access}
	return writeAtomic(s.path(b.ID), withFrontMatter(m, body))
}

// writeAtomic — запись через временный файл рядом и rename: оборванная на
// середине запись не должна оставить половину доски.
func writeAtomic(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op после успешного rename
	if _, err := tmp.WriteString(content); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, 0o600); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}
