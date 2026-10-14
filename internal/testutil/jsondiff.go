package testutil

import (
	"fmt"
	"sort"
)

// JSONDiff сравнивает два значения, разобранных encoding/json в any
// (map[string]any / []any / скаляры), и возвращает по строке на каждое
// расхождение с путём до поля: «было → стало», «пропало», «появилось».
// Пустой результат — значения совпадают.
func JSONDiff(want, got any) []string {
	var out []string
	jsonDiff("$", want, got, &out)
	return out
}

func jsonDiff(path string, want, got any, out *[]string) {
	switch w := want.(type) {
	case map[string]any:
		g, ok := got.(map[string]any)
		if !ok {
			*out = append(*out, fmt.Sprintf("%s: было объектом, стало %v", path, got))
			return
		}
		keys := make([]string, 0, len(w)+len(g))
		for k := range w {
			keys = append(keys, k)
		}
		for k := range g {
			if _, seen := w[k]; !seen {
				keys = append(keys, k)
			}
		}
		sort.Strings(keys)
		for _, k := range keys {
			wv, inW := w[k]
			gv, inG := g[k]
			switch {
			case !inG:
				*out = append(*out, fmt.Sprintf("%s.%s: пропало (было %v)", path, k, wv))
			case !inW:
				*out = append(*out, fmt.Sprintf("%s.%s: появилось %v", path, k, gv))
			default:
				jsonDiff(path+"."+k, wv, gv, out)
			}
		}
	case []any:
		g, ok := got.([]any)
		if !ok {
			*out = append(*out, fmt.Sprintf("%s: было списком, стало %v", path, got))
			return
		}
		if len(w) != len(g) {
			*out = append(*out, fmt.Sprintf("%s: было %d элементов, стало %d", path, len(w), len(g)))
			return
		}
		for i := range w {
			jsonDiff(fmt.Sprintf("%s[%d]", path, i), w[i], g[i], out)
		}
	default:
		if want != got {
			*out = append(*out, fmt.Sprintf("%s: было %v, стало %v", path, want, got))
		}
	}
}
