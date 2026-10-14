package schema

import (
	"embed"
	"fmt"
	"sync"
)

// builtinFS — встроенные схемы «Своей системы»: универсальный лист и
// карточки из общих полей ядра. Они же — схемы системы, у которой нет своей
// схемы нужного вида.
//
//go:embed builtin/*.json
var builtinFS embed.FS

var (
	builtinOnce sync.Once
	builtin     map[string]*Schema
	builtinErr  error
)

// Builtin — встроенная схема вида kind. Встроенные схемы проверяются тестом
// (schema_test.go), поэтому ошибка здесь — ошибка сборки, а не данных.
func Builtin(kind string) (*Schema, error) {
	builtinOnce.Do(func() {
		builtin = map[string]*Schema{}
		for _, k := range Kinds {
			data, err := builtinFS.ReadFile("builtin/" + k + ".json")
			if err != nil {
				builtinErr = fmt.Errorf("нет встроенной схемы %s: %w", k, err)
				return
			}
			s, err := Parse(data)
			if err != nil {
				builtinErr = fmt.Errorf("встроенная схема %s: %w", k, err)
				return
			}
			if s.Kind != k {
				builtinErr = fmt.Errorf("встроенная схема %s.json описывает вид %s", k, s.Kind)
				return
			}
			builtin[k] = s
		}
	})
	if builtinErr != nil {
		return nil, builtinErr
	}
	s, ok := builtin[kind]
	if !ok {
		return nil, fmt.Errorf("неизвестный вид схемы %q", kind)
	}
	return s, nil
}
