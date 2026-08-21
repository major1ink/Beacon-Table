// Package conditionfile реализует repository.ConditionRepository поверх
// обычных .json-файлов на диске: по файлу на состояние
// (dataDir/conditions/<id>.json), тот же принцип атомарной записи (tmp +
// rename), что и в referencefile/itemfile/spellfile/monsterfile — падение
// процесса посреди записи не роняет остальную библиотеку. Библиотека
// состояний общая на весь стол (не только ДМ: игрок должен видеть, что на
// нём висит, и читать описание) — см.
// internal/api/http/condition_handlers.go: requireAccount.
package conditionfile

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

// Store реализует repository.ConditionRepository.
type Store struct {
	dir string
}

// NewStore создаёт репозиторий библиотеки состояний в dataDir/conditions.
func NewStore(dataDir string) *Store {
	return &Store{dir: filepath.Join(dataDir, "conditions")}
}

var unsafeIDChars = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// conditionPath — путь файла карточки по её ID. ID уже filesystem-safe
// (генерируется как hex-строка, см. service.newID()), санитайзер — на
// случай ручной правки файлов на диске мимо приложения (как в referencefile).
func (s *Store) conditionPath(id string) string {
	safe := unsafeIDChars.ReplaceAllString(id, "_")
	if safe == "" {
		safe = "condition"
	}
	return filepath.Join(s.dir, safe+".json")
}

func (s *Store) List(ctx context.Context) ([]*domain.Condition, error) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []*domain.Condition{}, nil
		}
		return nil, err
	}
	conds := make([]*domain.Condition, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(s.dir, e.Name()))
		if err != nil {
			continue // повреждённый файл одной карточки не роняет список остальных
		}
		var c domain.Condition
		if err := json.Unmarshal(data, &c); err != nil {
			continue
		}
		conds = append(conds, &c)
	}
	sortByName(conds)
	return conds, nil
}

func (s *Store) Get(ctx context.Context, id string) (*domain.Condition, error) {
	data, err := os.ReadFile(s.conditionPath(id))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, domain.ErrNotFound
		}
		return nil, err
	}
	var c domain.Condition
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

// writeAtomic — общая запись Create/Update: во временный файл и
// переименование поверх целевого (см. referencefile.writeAtomic).
func (s *Store) writeAtomic(id string, c *domain.Condition) error {
	if err := os.MkdirAll(s.dir, 0o750); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	p := s.conditionPath(id)
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func (s *Store) Create(ctx context.Context, id string, c *domain.Condition) error {
	return s.writeAtomic(id, c)
}

func (s *Store) Update(ctx context.Context, id string, c *domain.Condition) (bool, error) {
	if _, err := os.Stat(s.conditionPath(id)); err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	if err := s.writeAtomic(id, c); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Store) Delete(ctx context.Context, id string) error {
	err := os.Remove(s.conditionPath(id))
	if err != nil && os.IsNotExist(err) {
		return nil
	}
	return err
}

// sortByName — общий порядок выдачи для Store и Catalog: по имени, без
// учёта регистра (как во всех остальных файловых библиотеках).
func sortByName(conds []*domain.Condition) {
	sort.Slice(conds, func(i, j int) bool {
		return strings.ToLower(conds[i].Name) < strings.ToLower(conds[j].Name)
	})
}
