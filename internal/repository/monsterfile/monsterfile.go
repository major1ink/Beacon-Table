// Package monsterfile реализует repository.MonsterRepository поверх обычных
// .json-файлов на диске: по файлу на монстра (dataDir/bestiary/<id>.json),
// тот же принцип атомарной записи (tmp + rename), что и в notefile/scenefile —
// падение/убийство процесса посреди записи не роняет остальную библиотеку и
// не оставляет битый файл этого монстра. В отличие от заметок (markdown,
// заголовок выводится из текста), тут весь монстр — структурированный JSON,
// поэтому List честно читает и разбирает каждый файл (карточки маленькие,
// десятки-сотни монстров не проблема).
package monsterfile

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"beacon-table/internal/domain"
)

// Store реализует repository.MonsterRepository.
type Store struct {
	dir string
}

// NewStore создаёт репозиторий бестиария в dataDir/bestiary.
func NewStore(dataDir string) *Store {
	return &Store{dir: filepath.Join(dataDir, "bestiary")}
}

var unsafeIDChars = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// monsterPath — путь файла монстра по его ID. ID уже filesystem-safe
// (генерируется как hex-строка, см. service.newID()), санитайзер — на
// случай ручной правки файлов на диске мимо приложения (как в notefile).
func (s *Store) monsterPath(id string) string {
	safe := unsafeIDChars.ReplaceAllString(id, "_")
	if safe == "" {
		safe = "monster"
	}
	return filepath.Join(s.dir, safe+".json")
}

func (s *Store) List(ctx context.Context) ([]*domain.Monster, error) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []*domain.Monster{}, nil
		}
		return nil, err
	}
	monsters := make([]*domain.Monster, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(s.dir, e.Name()))
		if err != nil {
			continue // повреждённый/недоступный файл одного монстра не роняет список остальных
		}
		var m domain.Monster
		if err := json.Unmarshal(data, &m); err != nil {
			continue
		}
		monsters = append(monsters, &m)
	}
	sort.Slice(monsters, func(i, j int) bool { return strings.ToLower(monsters[i].Name) < strings.ToLower(monsters[j].Name) })
	return monsters, nil
}

func (s *Store) Get(ctx context.Context, id string) (*domain.Monster, error) {
	data, err := os.ReadFile(s.monsterPath(id))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, domain.ErrNotFound
		}
		return nil, err
	}
	var m domain.Monster
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	return &m, nil
}

// writeAtomic — общая запись Create/Update: во временный файл и
// переименование поверх целевого (см. notefile.writeAtomic).
func (s *Store) writeAtomic(id string, m *domain.Monster) error {
	if err := os.MkdirAll(s.dir, 0o750); err != nil {
		return err
	}
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	p := s.monsterPath(id)
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func (s *Store) Create(ctx context.Context, id string, m *domain.Monster) error {
	return s.writeAtomic(id, m)
}

func (s *Store) Update(ctx context.Context, id string, m *domain.Monster) (bool, error) {
	if _, err := os.Stat(s.monsterPath(id)); err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	if err := s.writeAtomic(id, m); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Store) Delete(ctx context.Context, id string) error {
	err := os.Remove(s.monsterPath(id))
	if err != nil && os.IsNotExist(err) {
		return nil
	}
	return err
}
