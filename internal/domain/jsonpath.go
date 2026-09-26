package domain

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strconv"
	"strings"
)

// ResolveJSONPath проверяет путь "a.b.0.c" в JSON с Go-типом root (карточка,
// лист или строка таблицы листа) и отвечает, что по нему лежит: Go-тип
// значения или nil, если путь уходит в незнакомый ядру ключ верхнего уровня
// структуры с Extra — там значение хранится целиком, как есть, и любой путь
// внутрь него годится.
//
// Ошибка — путь внутрь известной ядру вложенной структуры к полю, которого
// она не знает: такой ключ при сохранении молча потеряется (Extra есть
// только у верхнего уровня, см. extra.go). Схема системы (internal/schema)
// проверяет этим свои пути при разборе, чтобы автор модуля узнал об этом
// сразу, а не по пропавшим данным.
func ResolveJSONPath(root reflect.Type, path string) (reflect.Type, error) {
	if path == "" {
		return nil, fmt.Errorf("пустой путь")
	}
	segs := strings.Split(path, ".")
	for _, seg := range segs {
		if seg == "" {
			return nil, fmt.Errorf("путь %q: пустой сегмент", path)
		}
	}
	t := root
	for i, seg := range segs {
		for t.Kind() == reflect.Pointer {
			t = t.Elem()
		}
		if t == rawMessageType || t.Kind() == reflect.Interface {
			return nil, nil
		}
		switch t.Kind() {
		case reflect.Struct:
			f, ok := jsonField(t, seg)
			if !ok {
				if i == 0 && hasExtra(t) {
					return nil, nil // незнакомый ключ верхнего уровня — Extra
				}
				if i == 0 {
					return nil, fmt.Errorf("путь %q: ядро не знает поле %q — незнакомый ключ здесь не сохранится", path, seg)
				}
				return nil, fmt.Errorf("путь %q: ядро не знает поле %q внутри %q — незнакомый вложенный ключ не сохранится; положи поле на верхний уровень", path, seg, strings.Join(strings.Split(path, ".")[:i], "."))
			}
			t = f.Type
		case reflect.Slice, reflect.Array:
			if _, err := strconv.Atoi(seg); err != nil {
				return nil, fmt.Errorf("путь %q: %q — список, нужен номер элемента", path, strings.Join(strings.Split(path, ".")[:i], "."))
			}
			t = t.Elem()
		case reflect.Map:
			t = t.Elem()
		default:
			return nil, fmt.Errorf("путь %q: %q — не объект и не список", path, strings.Join(strings.Split(path, ".")[:i], "."))
		}
	}
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	return t, nil
}

var (
	rawMessageType = reflect.TypeOf(json.RawMessage{})
	extraType      = reflect.TypeOf(Extra{})
)

// hasExtra — хранит ли структура незнакомые ключи верхнего уровня (поле
// Extra: карточки и лист, см. extra.go). У вложенных структур (строка
// таблицы листа, combat) его нет — незнакомый ключ там теряется.
func hasExtra(t reflect.Type) bool {
	for i := 0; i < t.NumField(); i++ {
		if t.Field(i).Type == extraType {
			return true
		}
	}
	return false
}

// jsonField — поле структуры по имени JSON-ключа, без учёта регистра (как
// сопоставляет encoding/json).
func jsonField(t reflect.Type, key string) (reflect.StructField, bool) {
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		if !f.IsExported() {
			continue
		}
		name := f.Name
		if tag, ok := f.Tag.Lookup("json"); ok {
			tagName, _, _ := strings.Cut(tag, ",")
			if tagName == "-" {
				continue
			}
			if tagName != "" {
				name = tagName
			}
		}
		if strings.EqualFold(name, key) {
			return f, true
		}
	}
	return reflect.StructField{}, false
}
