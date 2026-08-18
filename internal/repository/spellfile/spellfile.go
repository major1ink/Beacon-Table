// Package spellfile реализует repository.SpellRepository поверх обычных
// .json-файлов на диске: по файлу на заклинание (dataDir/spells/<id>.json),
// тот же принцип атомарной записи (tmp + rename), что и в monsterfile/
// notefile/scenefile — падение/убийство процесса посреди записи не роняет
// остальную библиотеку и не оставляет битый файл этого заклинания. Библиотека
// заклинаний общая на весь стол (не привязана к ДМ, в отличие от бестиария),
// но формат хранения — тот же самый файл-на-запись, разница только в том,
// кто имеет доступ к API поверх этого репозитория (см.
// internal/api/http/spell_handlers.go: requireAccount, а не
// requireAdminAccount).
package spellfile

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

// Store реализует repository.SpellRepository.
type Store struct {
	dir string
}

// NewStore создаёт репозиторий библиотеки заклинаний в dataDir/spells.
func NewStore(dataDir string) *Store {
	return &Store{dir: filepath.Join(dataDir, "spells")}
}

var unsafeIDChars = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// spellPath — путь файла заклинания по его ID. ID уже filesystem-safe
// (генерируется как hex-строка, см. service.newID()), санитайзер — на
// случай ручной правки файлов на диске мимо приложения (как в monsterfile).
func (s *Store) spellPath(id string) string {
	safe := unsafeIDChars.ReplaceAllString(id, "_")
	if safe == "" {
		safe = "spell"
	}
	return filepath.Join(s.dir, safe+".json")
}

func (s *Store) List(ctx context.Context) ([]*domain.Spell, error) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []*domain.Spell{}, nil
		}
		return nil, err
	}
	spells := make([]*domain.Spell, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(s.dir, e.Name()))
		if err != nil {
			continue // повреждённый/недоступный файл одного заклинания не роняет список остальных
		}
		var sp domain.Spell
		if err := json.Unmarshal(data, &sp); err != nil {
			continue
		}
		spells = append(spells, &sp)
	}
	sort.Slice(spells, func(i, j int) bool {
		if spells[i].Level != spells[j].Level {
			return spells[i].Level < spells[j].Level
		}
		return strings.ToLower(spells[i].Name) < strings.ToLower(spells[j].Name)
	})
	return spells, nil
}

func (s *Store) Get(ctx context.Context, id string) (*domain.Spell, error) {
	data, err := os.ReadFile(s.spellPath(id))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, domain.ErrNotFound
		}
		return nil, err
	}
	var sp domain.Spell
	if err := json.Unmarshal(data, &sp); err != nil {
		return nil, err
	}
	return &sp, nil
}

// writeAtomic — общая запись Create/Update: во временный файл и
// переименование поверх целевого (см. monsterfile.writeAtomic).
func (s *Store) writeAtomic(id string, sp *domain.Spell) error {
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(sp, "", "  ")
	if err != nil {
		return err
	}
	p := s.spellPath(id)
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func (s *Store) Create(ctx context.Context, id string, sp *domain.Spell) error {
	return s.writeAtomic(id, sp)
}

func (s *Store) Update(ctx context.Context, id string, sp *domain.Spell) (bool, error) {
	if _, err := os.Stat(s.spellPath(id)); err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	if err := s.writeAtomic(id, sp); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Store) Delete(ctx context.Context, id string) error {
	err := os.Remove(s.spellPath(id))
	if err != nil && os.IsNotExist(err) {
		return nil
	}
	return err
}
