package repository_test

// Каталог «из коробки» (cmd/beacon-table/systemdata) — то, что уедет в
// модули D&D. Каждая его карточка должна разбираться в свою структуру без
// потерь: поле, которого структура не знает, сегодня молча выпадает при
// чтении — и так же молча выпадет из модуля. Тест переедет в валидатор
// репозитория модулей вместе с самими файлами.

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"beacon-table/internal/domain"
	"beacon-table/internal/testutil"
)

const systemDataRoot = "../../cmd/beacon-table/systemdata"

func TestCatalogCardsDecodeWithoutLoss(t *testing.T) {
	kinds := map[string]func() any{
		"bestiary":   func() any { return &domain.Monster{} },
		"spells":     func() any { return &domain.Spell{} },
		"items":      func() any { return &domain.Item{} },
		"references": func() any { return &domain.Reference{} },
		"conditions": func() any { return &domain.Condition{} },
	}
	checked := 0
	for kind, newCard := range kinds {
		root := filepath.Join(systemDataRoot, kind)
		err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(path, ".json") {
				return err
			}
			raw, err := os.ReadFile(path) //nolint:gosec // путь из обхода каталога
			if err != nil {
				return err
			}
			var src any
			if err := json.Unmarshal(raw, &src); err != nil {
				t.Errorf("%s: не JSON: %v", path, err)
				return nil
			}
			card := newCard()
			if err := json.Unmarshal(raw, card); err != nil {
				t.Errorf("%s: не разбирается в %T: %v", path, card, err)
				return nil
			}
			back, _ := json.Marshal(card)
			var got any
			_ = json.Unmarshal(back, &got)
			// Нулевые значения не сравниваем ни с той, ни с другой стороны:
			// "parentName": "" в файле и отсутствие поля после omitempty —
			// одно и то же. Интересует только пропавшее и изменённое.
			for _, d := range testutil.JSONDiff(dropZero(src), dropZero(got)) {
				if !strings.Contains(d, "появилось") {
					t.Errorf("%s: %s", filepath.ToSlash(path), d)
				}
			}
			checked++
			return nil
		})
		if err != nil {
			t.Fatalf("%s: %v", root, err)
		}
	}
	if checked == 0 {
		t.Fatal("не нашли ни одной карточки каталога — сменился путь?")
	}
	t.Logf("проверено карточек: %d", checked)
}

// dropZero убирает из разобранного JSON пустые строки, нули, false, null и
// пустые списки/объекты — всё, что omitempty не пишет обратно.
func dropZero(v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := map[string]any{}
		for k, e := range x {
			if e = dropZero(e); e != nil {
				out[k] = e
			}
		}
		if len(out) == 0 {
			return nil
		}
		return out
	case []any:
		if len(x) == 0 {
			return nil
		}
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = dropZero(e)
		}
		return out
	case string:
		if x == "" {
			return nil
		}
	case float64:
		if x == 0 {
			return nil
		}
	case bool:
		if !x {
			return nil
		}
	}
	return v
}
