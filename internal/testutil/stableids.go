package testutil

import (
	"encoding/json"
	"regexp"
	"sort"
)

var hexID = regexp.MustCompile(`^[0-9a-f]{32}$`)

// StableIDs готовит разобранный JSON к сравнению с эталоном, когда в нём
// есть случайные id (crypto/rand, 32 hex-символа — сцены, токены, стены,
// заведённые импортом): сами id заменяются меткой "<id>", а объекты, ключи
// которых — такие id, превращаются в список, отсортированный по содержимому.
// В эталоне важен состав, а не случайные ключи и их порядок.
func StableIDs(v any) any {
	switch x := v.(type) {
	case map[string]any:
		allIDs := len(x) > 0
		for k := range x {
			if !hexID.MatchString(k) {
				allIDs = false
				break
			}
		}
		if allIDs {
			list := make([]any, 0, len(x))
			for _, e := range x {
				list = append(list, StableIDs(e))
			}
			sort.Slice(list, func(i, j int) bool {
				a, _ := json.Marshal(list[i])
				b, _ := json.Marshal(list[j])
				return string(a) < string(b)
			})
			return list
		}
		out := make(map[string]any, len(x))
		for k, e := range x {
			out[k] = StableIDs(e)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = StableIDs(e)
		}
		return out
	case string:
		if hexID.MatchString(x) {
			return "<id>"
		}
	}
	return v
}
