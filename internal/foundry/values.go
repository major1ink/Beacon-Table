package foundry

import (
	"encoding/json"
	"strconv"
)

// Мелкие хелперы доступа к разобранному JSON. Документы Foundry — это
// map[string]any с числами в виде json.Number (см. decodeDoc), и лазить в
// них приходится всюду: без этих функций каждый второй строчкой был бы
// двойной type assertion.

func asString(v any) string {
	switch s := v.(type) {
	case string:
		return s
	case json.Number:
		return s.String()
	default:
		return ""
	}
}

func asFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	case float64:
		return n, true
	case int:
		return float64(n), true
	case string:
		f, err := strconv.ParseFloat(n, 64)
		return f, err == nil
	case bool:
		if n {
			return 1, true
		}
		return 0, true
	default:
		return 0, false
	}
}

// num — значение с подстановкой по умолчанию: в документах Foundry поля
// сплошь и рядом либо отсутствуют, либо null.
func num(v any, def float64) float64 {
	if f, ok := asFloat(v); ok {
		return f
	}
	return def
}

func asBool(v any) bool {
	switch b := v.(type) {
	case bool:
		return b
	case json.Number:
		f, err := b.Float64()
		return err == nil && f != 0
	default:
		return false
	}
}

// asMap — объект как map. Doc — именованный тип поверх той же map, и без
// отдельной ветки type assertion на map[string]any его не узнаёт: сам
// документ пака приходит сюда как Doc, а всё вложенное в него — уже как
// map[string]any (json их не различает).
func asMap(v any) map[string]any {
	switch m := v.(type) {
	case map[string]any:
		return m
	case Doc:
		return m
	default:
		return nil
	}
}

func asSlice(v any) []any {
	s, _ := v.([]any)
	return s
}

// dig — путь по вложенным объектам: dig(doc, "system", "description",
// "value"). nil, если по дороге что-то не объект или отсутствует.
func dig(v any, path ...string) any {
	cur := v
	for _, key := range path {
		m := asMap(cur)
		if m == nil {
			return nil
		}
		cur = m[key]
	}
	return cur
}

// digString/digNum — то же самое, но сразу нужным типом.
func digString(v any, path ...string) string { return asString(dig(v, path...)) }

func digNum(v any, def float64, path ...string) float64 { return num(dig(v, path...), def) }
