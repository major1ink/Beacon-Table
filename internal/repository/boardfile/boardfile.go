// Package boardfile реализует repository.BoardRepository поверх обычных
// .md-файлов на диске (dataDir/boards/<id>.md): атомарная запись (tmp +
// rename), никакого индекса — список собирается обходом каталога.
//
// Формат — файл плагина Excalidraw для Obsidian (см. internal/excalidraw):
// шапка front matter, дальше разделы «# Excalidraw Data» / «## Text Elements»
// / «## Embedded Files» и сам холст блоком ```json. В шапке к служебным
// ключам плагина дописаны наши: имя доски, автор и раздача прав.
//
//	---
//	excalidraw-plugin: parsed
//	tags: [excalidraw]
//	name: Схема расследования
//	owner: 6f1c…
//	ownerName: Гвен
//	default: none
//	access:
//	  a41b…: observer
//	---
//
// То есть файл доски не «похож на» файл Excalidraw, а им и является: ваулт
// открывает его редактором рисунка, а импорт чужого .excalidraw.md сводится
// к дописыванию наших ключей в шапку. Плагин про лишние ключи не спотыкается
// — frontmatter в Obsidian открытый.
//
// Рисунок пишется НЕсжатым, хотя плагин обычно жмёт: так файл по-человечески
// диффится и в git, и в ваулте, а читать плагин умеет оба вида.
//
// Разбор шапки написан здесь, а не переиспользован из journalfile, по той же
// причине, по какой там продублирована sanitizeFolder: пакеты репозиториев
// ничего друг о друге не знают, и шапки у них уже разные.
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
	"beacon-table/internal/excalidraw"
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

// readMeta вытаскивает наши ключи из шапки. Чужие ключи (плагина, Obsidian)
// просто игнорируются — за их сохранность отвечает не эта функция, а то, что
// шапку мы собираем заново целиком и служебные ключи плагина пишем сами.
func readMeta(frontmatter string) meta {
	m := meta{Default: domain.JournalNone, Access: map[string]domain.JournalAccess{}}
	inAccess := false
	for _, line := range strings.Split(frontmatter, "\n") {
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
	return m
}

// oneLine — значение шапки не должно разъехаться на несколько строк и
// сломать разбор соседних полей.
func oneLine(s string) string {
	s = strings.ReplaceAll(s, "\r", " ")
	s = strings.ReplaceAll(s, "\n", " ")
	return strings.TrimSpace(s)
}

// frontMatter собирает шапку БЕЗ разделителей «---»: служебные ключи плагина
// плюс наши. Именно первые заставляют Obsidian открыть файл редактором
// рисунка, а не как обычную заметку.
func frontMatter(m meta) string {
	var b strings.Builder
	b.WriteString("excalidraw-plugin: parsed\n")
	b.WriteString("tags: [excalidraw]\n")
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
	return b.String()
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
		b, err := s.Get(ctx, strings.TrimSuffix(e.Name(), ".md"))
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
	b, _, err := s.load(id)
	if err != nil {
		return nil, err
	}
	if b == nil {
		return nil, domain.ErrNotFound
	}
	return b, nil
}

// Scene — холст доски. Отдельно от Get: список досок не должен тащить с диска
// и разбирать рисунки, которые ему не нужны.
func (s *Store) Scene(ctx context.Context, id string) (*excalidraw.Document, error) {
	b, doc, err := s.load(id)
	if err != nil {
		return nil, err
	}
	if b == nil {
		return nil, domain.ErrNotFound
	}
	return doc, nil
}

func (s *Store) Create(ctx context.Context, b *domain.Board, doc *excalidraw.Document) error {
	if _, err := os.Stat(s.path(b.ID)); err == nil {
		return domain.ErrConflict
	}
	if doc == nil {
		doc = excalidraw.NewDocument()
	}
	return s.save(b, doc)
}

// Rename и SetAccess меняют ТОЛЬКО шапку, рисунок переписывается как есть.
// Отдельные методы, а не общий Update: холст автосейвится при рисовании, и
// класть в тот же запрос ещё и права значило бы гонять их туда-сюда на
// каждый штрих (а гонка двух окон — затирать только что выданный доступ).
func (s *Store) Rename(ctx context.Context, id, name string) (bool, error) {
	b, doc, err := s.load(id)
	if err != nil || b == nil {
		return false, err
	}
	b.Name = name
	return true, s.save(b, doc)
}

func (s *Store) SetAccess(ctx context.Context, id string, def domain.JournalAccess, access map[string]domain.JournalAccess) (bool, error) {
	b, doc, err := s.load(id)
	if err != nil || b == nil {
		return false, err
	}
	b.Default = def
	b.Access = access
	return true, s.save(b, doc)
}

// SetScene заменяет холст, не трогая шапку.
func (s *Store) SetScene(ctx context.Context, id string, doc *excalidraw.Document) (bool, error) {
	b, old, err := s.load(id)
	if err != nil || b == nil {
		return false, err
	}
	// Картинки ваулта («## Embedded Files») переносим со старого документа,
	// если новый их не принёс: они связаны с fileId элементов, и потерять
	// связь означает показать вместо картинки пустоту.
	if len(doc.EmbeddedFiles) == 0 && old != nil {
		doc.EmbeddedFiles = old.EmbeddedFiles
	}
	if old != nil {
		excalidraw.CarryOverPluginFields(old.Scene, doc.Scene)
	}
	return true, s.save(b, doc)
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

// load — доска и её холст. Файл, который не разбирается как рисунок (доска
// создана до появления холста, или её испортили руками), возвращается с
// пустым документом, а не ошибкой: метаданные читаются из шапки и работают,
// а рисунок начнётся с чистого листа. Терять из-за одного битого файла всю
// доску вместе с правами незачем.
func (s *Store) load(id string) (*domain.Board, *excalidraw.Document, error) {
	p := s.path(id)
	raw, err := os.ReadFile(p)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil, nil
		}
		return nil, nil, err
	}

	doc, parseErr := excalidraw.ParseDocument(string(raw))
	var fm string
	if parseErr == nil {
		fm = doc.Frontmatter
	} else {
		doc = excalidraw.NewDocument()
		fm = rawFrontMatter(string(raw))
	}

	m := readMeta(fm)
	name := strings.TrimSpace(m.Name)
	if name == "" {
		name = "Без названия"
	}
	b := &domain.Board{
		ID:   id,
		Name: name,
		Sharing: domain.Sharing{
			OwnerID:   m.OwnerID,
			OwnerName: m.OwnerName,
			Default:   m.Default,
			Access:    m.Access,
		},
	}
	if info, err := os.Stat(p); err == nil {
		b.UpdatedAt = info.ModTime()
	}
	return b, doc, nil
}

// rawFrontMatter — шапка файла, который не разобрался как рисунок. Нужна
// ровно затем, чтобы у такой доски всё равно нашлись имя и права.
func rawFrontMatter(raw string) string {
	if !strings.HasPrefix(raw, "---\n") && !strings.HasPrefix(raw, "---\r\n") {
		return ""
	}
	lines := strings.Split(raw, "\n")
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			return strings.Join(lines[1:i], "\n")
		}
	}
	return ""
}

func (s *Store) save(b *domain.Board, doc *excalidraw.Document) error {
	if doc == nil {
		doc = excalidraw.NewDocument()
	}
	m := meta{Name: b.Name, OwnerID: b.OwnerID, OwnerName: b.OwnerName, Default: b.Default, Access: b.Access}
	content, err := doc.Markdown(frontMatter(m))
	if err != nil {
		return err
	}
	return writeAtomic(s.path(b.ID), content)
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
