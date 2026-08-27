// Package journalfile реализует repository.JournalRepository поверх обычных
// .md-файлов на диске (dataDir/journal/<папка>/<id>.md): атомарная запись
// (tmp + rename), настоящие подпапки вместо поля в индексе, поиск файла по
// id обходом дерева.
//
// В начале файла — «шапка» (front matter): у записи журнала, кроме текста,
// есть автор и раздача прав (см. domain.JournalEntry),
// а хранить их отдельным индексом значило бы завести второй источник правды,
// который разойдётся с файлами при первой же правке мимо приложения. Формат
// шапки — тот же YAML-подобный блок между "---", что понимают Obsidian и
// прочие markdown-редакторы, так что файл остаётся нормальной заметкой:
//
//	---
//	owner: 6f1c…
//	ownerName: Гвен
//	default: none
//	access:
//	  a41b…: observer
//	---
//	# Тайник у мельницы
//
// Файл без шапки (создан руками) читается как запись без автора с правами по
// умолчанию — это валидно, а не ошибка.
package journalfile

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

// Store реализует repository.JournalRepository.
type Store struct {
	dir string
}

// NewStore создаёт репозиторий журнала в каталоге dir (обычно data/journal).
func NewStore(dir string) *Store {
	return &Store{dir: dir}
}

var unsafeIDChars = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

func fileName(id string) string {
	safe := unsafeIDChars.ReplaceAllString(id, "_")
	if safe == "" {
		safe = "entry"
	}
	return safe + ".md"
}

// sanitizeFolder — та же защита от выхода за пределы корня, что и в localfs
// (дублируется осознанно: пакеты репозиториев ничего друг о друге не знают).
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

func (s *Store) dirFor(folder string) (string, error) {
	folder, err := sanitizeFolder(folder)
	if err != nil {
		return "", err
	}
	if folder == "" {
		return s.dir, nil
	}
	return filepath.Join(s.dir, filepath.FromSlash(folder)), nil
}

func (s *Store) find(id string) (path, folder string, err error) {
	target := fileName(id)
	walkErr := filepath.WalkDir(s.dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
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

func (s *Store) folderOf(path string) string {
	rel, err := filepath.Rel(s.dir, filepath.Dir(path))
	if err != nil || rel == "." {
		return ""
	}
	return filepath.ToSlash(rel)
}

// deriveTitle — заголовок записи: первая непустая строка вида "# Текст" (та
// же логика, что и у её двойника на клиенте —
// web/src/notes/markdown.js:noteTitleFromContent).
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
		break
	}
	return "Без названия"
}

// ---- шапка файла (см. package-doc) ----

// meta — то, что лежит в шапке: всё про запись, кроме её текста.
type meta struct {
	OwnerID   string
	OwnerName string
	Default   domain.JournalAccess
	Access    map[string]domain.JournalAccess
}

// splitFrontMatter разбирает файл на шапку и текст. Файла без шапки это
// касается тоже: meta нулевая, весь файл — текст.
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
		return m, raw // незакрытая шапка — считаем, что её нет, текст не теряем
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
	return m, strings.Join(lines[end+1:], "\n")
}

// oneLine — значение шапки не должно ломать её формат: перевод строки внутри
// имени автора превратил бы остаток шапки в текст записи.
func oneLine(s string) string {
	s = strings.ReplaceAll(s, "\r", " ")
	s = strings.ReplaceAll(s, "\n", " ")
	return strings.TrimSpace(s)
}

// withFrontMatter — обратная splitFrontMatter сборка файла.
func withFrontMatter(m meta, content string) string {
	var b strings.Builder
	b.WriteString("---\n")
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
	b.WriteString(content)
	return b.String()
}

func entryFrom(id, folder, raw string) *domain.JournalEntry {
	m, content := splitFrontMatter(raw)
	return &domain.JournalEntry{
		ID:        id,
		Title:     deriveTitle(content),
		Folder:    folder,
		Content:   content,
		OwnerID:   m.OwnerID,
		OwnerName: m.OwnerName,
		Default:   m.Default,
		Access:    m.Access,
	}
}

func (s *Store) List(ctx context.Context) ([]*domain.JournalEntry, error) {
	entries := make([]*domain.JournalEntry, 0, 16)
	err := filepath.WalkDir(s.dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() || filepath.Ext(d.Name()) != ".md" {
			return nil
		}
		//nolint:gosec // G304: p — путь, выданный обходом самого s.dir
		data, err := os.ReadFile(p)
		if err != nil {
			return nil // битый файл одной записи не роняет список остальных
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		e := entryFrom(strings.TrimSuffix(d.Name(), ".md"), s.folderOf(p), string(data))
		e.Content = "" // список — без текста (см. repository.JournalRepository.List)
		e.UpdatedAt = info.ModTime()
		entries = append(entries, e)
		return nil
	})
	if err != nil {
		if os.IsNotExist(err) {
			return []*domain.JournalEntry{}, nil
		}
		return nil, err
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Folder != entries[j].Folder {
			return strings.ToLower(entries[i].Folder) < strings.ToLower(entries[j].Folder)
		}
		return strings.ToLower(entries[i].Title) < strings.ToLower(entries[j].Title)
	})
	return entries, nil
}

func (s *Store) Get(ctx context.Context, id string) (*domain.JournalEntry, error) {
	p, folder, err := s.find(id)
	if err != nil {
		return nil, err
	}
	//nolint:gosec // G304: p — путь, найденный обходом s.dir (см. find)
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
	e := entryFrom(id, folder, string(data))
	e.UpdatedAt = info.ModTime()
	return e, nil
}

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

func (s *Store) Create(ctx context.Context, e *domain.JournalEntry) error {
	dir, err := s.dirFor(e.Folder)
	if err != nil {
		return err
	}
	m := meta{OwnerID: e.OwnerID, OwnerName: e.OwnerName, Default: e.Default, Access: e.Access}
	return writeAtomic(filepath.Join(dir, fileName(e.ID)), withFrontMatter(m, e.Content))
}

// rewrite — общая часть Update/SetAccess: перечитать файл, поменять одну его
// половину (шапку или текст), записать обратно. Читаем прямо перед записью,
// а не полагаемся на копию у вызывающего, — иначе автосейв текста затирал бы
// права, только что выданные из другого окна, и наоборот.
func (s *Store) rewrite(id string, fn func(m *meta, content string) string) (bool, error) {
	p, _, err := s.find(id)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			return false, nil
		}
		return false, err
	}
	//nolint:gosec // G304: p — путь, найденный обходом s.dir (см. find)
	data, err := os.ReadFile(p)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	m, content := splitFrontMatter(string(data))
	content = fn(&m, content)
	if err := writeAtomic(p, withFrontMatter(m, content)); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Store) Update(ctx context.Context, id, content string) (bool, error) {
	return s.rewrite(id, func(_ *meta, _ string) string { return content })
}

func (s *Store) SetAccess(ctx context.Context, id string, def domain.JournalAccess, access map[string]domain.JournalAccess) (bool, error) {
	return s.rewrite(id, func(m *meta, content string) string {
		m.Default = def
		m.Access = access
		return content
	})
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
		return true, nil
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
			return nil // удаление несуществующей записи — не ошибка
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
	err := filepath.WalkDir(s.dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() || p == s.dir {
			return nil
		}
		rel, err := filepath.Rel(s.dir, p)
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
	if dir == s.dir {
		return fmt.Errorf("имя папки обязательно")
	}
	return os.MkdirAll(dir, 0o750)
}

func (s *Store) DeleteFolder(ctx context.Context, folder string) error {
	dir, err := s.dirFor(folder)
	if err != nil {
		return err
	}
	if dir == s.dir {
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
	if fromDir == s.dir || toDir == s.dir {
		return fmt.Errorf("имя папки обязательно")
	}
	if fromDir == toDir {
		return nil
	}
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
