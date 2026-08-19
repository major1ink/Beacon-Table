// Package referencefile реализует repository.ReferenceRepository поверх
// обычных .json-файлов на диске: по файлу на запись справочника
// (dataDir/references/<id>.json), тот же принцип атомарной записи (tmp +
// rename), что и в itemfile/spellfile/monsterfile/notefile/scenefile —
// падение/убийство процесса посреди записи не роняет остальную библиотеку и
// не оставляет битый файл этой записи. Библиотека справочника общая на весь
// стол (не привязана к ДМ, как и Item/Spell) — формат хранения тот же самый
// файл-на-запись, разница только в том, кто имеет доступ к API поверх этого
// репозитория (см. internal/api/http/reference_handlers.go: requireAccount,
// а не requireAdminAccount).
package referencefile

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

// Store реализует repository.ReferenceRepository.
type Store struct {
	dir string
}

// NewStore создаёт репозиторий библиотеки справочника в dataDir/references.
func NewStore(dataDir string) *Store {
	return &Store{dir: filepath.Join(dataDir, "references")}
}

var unsafeIDChars = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// referencePath — путь файла записи по её ID. ID уже filesystem-safe
// (генерируется как hex-строка, см. service.newID()), санитайзер — на
// случай ручной правки файлов на диске мимо приложения (как в itemfile).
func (s *Store) referencePath(id string) string {
	safe := unsafeIDChars.ReplaceAllString(id, "_")
	if safe == "" {
		safe = "reference"
	}
	return filepath.Join(s.dir, safe+".json")
}

func (s *Store) List(ctx context.Context) ([]*domain.Reference, error) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []*domain.Reference{}, nil
		}
		return nil, err
	}
	refs := make([]*domain.Reference, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(s.dir, e.Name()))
		if err != nil {
			continue // повреждённый/недоступный файл одной записи не роняет список остальных
		}
		var ref domain.Reference
		if err := json.Unmarshal(data, &ref); err != nil {
			continue
		}
		refs = append(refs, &ref)
	}
	sort.Slice(refs, func(i, j int) bool {
		return strings.ToLower(refs[i].Name) < strings.ToLower(refs[j].Name)
	})
	return refs, nil
}

func (s *Store) Get(ctx context.Context, id string) (*domain.Reference, error) {
	data, err := os.ReadFile(s.referencePath(id))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, domain.ErrNotFound
		}
		return nil, err
	}
	var ref domain.Reference
	if err := json.Unmarshal(data, &ref); err != nil {
		return nil, err
	}
	return &ref, nil
}

// writeAtomic — общая запись Create/Update: во временный файл и
// переименование поверх целевого (см. itemfile.writeAtomic).
func (s *Store) writeAtomic(id string, ref *domain.Reference) error {
	if err := os.MkdirAll(s.dir, 0o750); err != nil {
		return err
	}
	data, err := json.MarshalIndent(ref, "", "  ")
	if err != nil {
		return err
	}
	p := s.referencePath(id)
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func (s *Store) Create(ctx context.Context, id string, ref *domain.Reference) error {
	return s.writeAtomic(id, ref)
}

func (s *Store) Update(ctx context.Context, id string, ref *domain.Reference) (bool, error) {
	if _, err := os.Stat(s.referencePath(id)); err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	if err := s.writeAtomic(id, ref); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Store) Delete(ctx context.Context, id string) error {
	err := os.Remove(s.referencePath(id))
	if err != nil && os.IsNotExist(err) {
		return nil
	}
	return err
}
