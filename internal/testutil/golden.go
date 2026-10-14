package testutil

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Golden сверяет value с эталоном path (JSON). С UPDATE_GOLDEN=1 эталон
// переписывается — только осознанно, с просмотром диффа в git: изменение
// эталона значит, что поведение стало другим.
func Golden(t *testing.T, path string, value any) {
	t.Helper()
	b, err := json.MarshalIndent(value, "", " ")
	if err != nil {
		t.Fatal(err)
	}
	if os.Getenv("UPDATE_GOLDEN") != "" {
		if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, append(b, '\n'), 0o600); err != nil {
			t.Fatal(err)
		}
		return
	}
	raw, err := os.ReadFile(path) //nolint:gosec // путь к эталону задаёт тест
	if err != nil {
		t.Fatalf("нет эталона %s — запусти с UPDATE_GOLDEN=1: %v", path, err)
	}
	var want, got any
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	_ = json.Unmarshal(b, &got)
	if diffs := JSONDiff(want, got); len(diffs) > 0 {
		t.Fatalf("разошлось с эталоном %s:\n%s", path, strings.Join(diffs, "\n"))
	}
}
