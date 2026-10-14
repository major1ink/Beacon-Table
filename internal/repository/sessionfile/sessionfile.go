// Package sessionfile хранит ленты сессий: dir/<id>.jsonl, событие на строку.
// Файл только дописывается — оборванная последняя строка теряет одно событие,
// а не всю ленту.
package sessionfile

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	"beacon-table/internal/domain"
)

const ext = ".jsonl"

// idRe — id сессии: дата и номер за день («2026-10-13», «2026-10-13-2»);
// он же имя файла, поэтому без слэшей и точек.
var idRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}(-\d{1,3})?$`)

type Store struct {
	dir string
	mu  sync.Mutex
}

func NewStore(dir string) *Store { return &Store{dir: dir} }

func (s *Store) path(id string) (string, error) {
	if !idRe.MatchString(id) {
		return "", domain.ErrNotFound
	}
	return filepath.Join(s.dir, id+ext), nil
}

func (s *Store) IDs(_ context.Context) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entries, err := os.ReadDir(s.dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var ids []string
	for _, e := range entries {
		id, ok := strings.CutSuffix(e.Name(), ext)
		if ok && !e.IsDir() && idRe.MatchString(id) {
			ids = append(ids, id)
		}
	}
	sort.Slice(ids, func(i, j int) bool { return lessID(ids[i], ids[j]) })
	return ids, nil
}

// lessID — «2026-10-13-10» после «2026-10-13-9», а не перед ним.
func lessID(a, b string) bool {
	if a[:10] != b[:10] {
		return a < b
	}
	if len(a) != len(b) {
		return len(a) < len(b)
	}
	return a < b
}

func (s *Store) Events(_ context.Context, id string) ([]domain.SessionEvent, error) {
	p, err := s.path(id)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	//nolint:gosec // G304: p собран из s.dir и id, прошедшего idRe (см. path)
	data, err := os.ReadFile(p)
	s.mu.Unlock()
	if errors.Is(err, fs.ErrNotExist) {
		return nil, domain.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var out []domain.SessionEvent
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		var ev domain.SessionEvent
		if json.Unmarshal(sc.Bytes(), &ev) == nil {
			out = append(out, ev)
		}
	}
	return out, nil
}

func (s *Store) Append(_ context.Context, id string, ev domain.SessionEvent) error {
	p, err := s.path(id)
	if err != nil {
		return err
	}
	line, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.MkdirAll(s.dir, 0o750); err != nil {
		return err
	}
	//nolint:gosec // G304: p собран из s.dir и проверенного id, см. path
	f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(append(line, '\n')); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
