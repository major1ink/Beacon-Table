package module

import (
	"errors"
	"fmt"
	"io/fs"
	"path"
	"strings"

	"beacon-table/internal/schema"
)

// schemasDir — папка схем листа и карточек в модуле: schemas/<вид>.json
// (см. internal/schema).
const schemasDir = "schemas"

// loadSchemas читает и проверяет схемы модуля. Схемы бывают только у
// системного модуля; файл называется по виду схемы и описывает ровно его.
// Битая схема — ошибка модуля целиком, как битый module.json: автор узнаёт
// о ней при установке, а не по пустому листу у игроков.
func loadSchemas(fsys fs.FS, man *Manifest) (map[string]*schema.Schema, error) {
	entries, err := fs.ReadDir(fsys, schemasDir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("папка %s модуля %s: %w", schemasDir, man.ID, err)
	}
	out := map[string]*schema.Schema{}
	for _, e := range entries {
		if e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		kind, ok := strings.CutSuffix(e.Name(), ".json")
		if !ok || !knownSchemaKind(kind) {
			return nil, fmt.Errorf("модуль %s: %s/%s — схема называется по виду: %s.json", man.ID, schemasDir, e.Name(), strings.Join(schema.Kinds, ".json, "))
		}
		if man.Type != TypeSystem {
			return nil, fmt.Errorf("схемы (%s/) бывают только у системного модуля, а %s — %q", schemasDir, man.ID, man.Type)
		}
		info, err := e.Info()
		if err != nil {
			return nil, err
		}
		if info.Size() > schema.MaxFileSize {
			return nil, fmt.Errorf("модуль %s: схема %s больше %d КБ", man.ID, e.Name(), schema.MaxFileSize>>10)
		}
		data, err := fs.ReadFile(fsys, path.Join(schemasDir, e.Name()))
		if err != nil {
			return nil, err
		}
		s, err := schema.Parse(data)
		if err != nil {
			return nil, fmt.Errorf("модуль %s, %s/%s: %w", man.ID, schemasDir, e.Name(), err)
		}
		if s.Kind != kind {
			return nil, fmt.Errorf("модуль %s: %s/%s описывает вид %q", man.ID, schemasDir, e.Name(), s.Kind)
		}
		out[kind] = s
	}
	return out, nil
}

func knownSchemaKind(kind string) bool {
	for _, k := range schema.Kinds {
		if k == kind {
			return true
		}
	}
	return false
}
