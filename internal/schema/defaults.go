package schema

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

// checkDefault — значение по умолчанию поля (default): у числа — число, у
// текста, длинного текста и куба — строка, у флажка — bool, у выбора —
// значение одного из вариантов (у числового выбора — число). Колонкам и
// полям без path (вычисляемым, шаблонам, броскам) оно не нужно.
func checkDefault(f *Field, column bool) error {
	if f.Default == nil {
		return nil
	}
	if column || f.Path == "" {
		return fmt.Errorf("default — только у поля с path, не у колонки")
	}
	switch v := f.Default.(type) {
	case float64:
		if f.Type == TypeNumber {
			return nil
		}
		if f.Type == TypeSelect && f.Numeric && hasOption(f, strconv.FormatFloat(v, 'f', -1, 64)) {
			return nil
		}
	case string:
		switch f.Type {
		case TypeText, TypeLongText, TypeDice:
			return nil
		case TypeSelect:
			if !f.Numeric && hasOption(f, v) {
				return nil
			}
		}
	case bool:
		if f.Type == TypeBool {
			return nil
		}
	}
	return fmt.Errorf("default %v не подходит полю типа %s", f.Default, f.Type)
}

func hasOption(f *Field, value string) bool {
	for _, o := range f.Options {
		if o.Value == value {
			return true
		}
	}
	return false
}

// ApplyDefaults кладёт значения по умолчанию схемы в только что созданную
// карточку card (указатель на структуру, которая пишется в JSON): пустое
// значение — отсутствует, null, 0, "" или false — заменяется на default
// поля. Заполненное не трогается.
func (s *Schema) ApplyDefaults(card any) error {
	ids := make([]string, 0, len(s.Fields))
	for id, f := range s.Fields {
		if f.Default != nil {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	sort.Strings(ids)
	data, err := json.Marshal(card)
	if err != nil {
		return err
	}
	var tree map[string]any
	if err := json.Unmarshal(data, &tree); err != nil {
		return err
	}
	changed := false
	for _, id := range ids {
		f := s.Fields[id]
		if isEmptyValue(lookupTree(tree, f.Path)) {
			changed = setTree(tree, f.Path, f.Default) || changed
		}
	}
	if !changed {
		return nil
	}
	data, err = json.Marshal(tree)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, card)
}

func isEmptyValue(v any) bool {
	switch x := v.(type) {
	case nil:
		return true
	case float64:
		return x == 0 || math.IsNaN(x)
	case string:
		return x == ""
	case bool:
		return !x
	}
	return false
}

func lookupTree(tree map[string]any, path string) any {
	var cur any = tree
	for _, seg := range strings.Split(path, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = m[seg]
	}
	return cur
}

// setTree кладёт value по пути, создавая недостающие объекты; false — на
// пути не объект (значение не записано).
func setTree(tree map[string]any, path string, value any) bool {
	segs := strings.Split(path, ".")
	cur := tree
	for _, seg := range segs[:len(segs)-1] {
		next, ok := cur[seg]
		if !ok || next == nil {
			m := map[string]any{}
			cur[seg] = m
			cur = m
			continue
		}
		m, ok := next.(map[string]any)
		if !ok {
			return false
		}
		cur = m
	}
	cur[segs[len(segs)-1]] = value
	return true
}
