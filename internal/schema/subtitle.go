package schema

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Subtitle — подпись листа или карточки src по шаблону list.subtitle
// («Хиты {hp} · Защита {ac}»): подстановки — поля схемы (как их видит
// человек: число, подпись варианта, формула броска) или общие ключи
// карточки (name, tags, source). Части между «·», в которых все подстановки
// пустые, выпадают целиком. "" — схемы или шаблона нет.
//
// Зеркало на клиенте — web/src/schema-list.js: cardSubtitle (общие случаи —
// testdata/eval-cases.json, раздел subtitles).
func (s *Schema) Subtitle(src any) string {
	if s == nil || s.List == nil || s.List.Subtitle == "" {
		return ""
	}
	ev := NewEvaluator(s, src, nil)
	return FormatSubtitle(s.List.Subtitle, func(id string) string { return ev.display(id) })
}

// templateRe — «[необязательная часть]» или «{подстановка}».
var templateRe = regexp.MustCompile(`\[([^\[\]]*)\]|\{([^{}]*)\}`)

// FormatSubtitle — шаблон с подстановками {id} и необязательными частями
// [ ({id})], которые выпадают, если все их подстановки пусты; value(id) —
// текст поля.
func FormatSubtitle(template string, value func(id string) string) string {
	var out []string
	fill := func(s string) (text string, placeholders, filled int) {
		text = placeholderRe.ReplaceAllStringFunc(s, func(m string) string {
			placeholders++
			v := strings.TrimSpace(value(m[1 : len(m)-1]))
			if v != "" {
				filled++
			}
			return v
		})
		return text, placeholders, filled
	}
	for _, part := range strings.Split(template, "·") {
		placeholders, filled := 0, 0
		text := templateRe.ReplaceAllStringFunc(part, func(m string) string {
			inner := m
			optional := strings.HasPrefix(m, "[")
			if optional {
				inner = m[1 : len(m)-1]
			}
			t, p, f := fill(inner)
			if optional && p > 0 && f == 0 {
				return ""
			}
			placeholders += p
			filled += f
			return t
		})
		if placeholders > 0 && filled == 0 {
			continue
		}
		if t := strings.TrimSpace(text); t != "" {
			out = append(out, t)
		}
	}
	return strings.Join(out, " · ")
}

// display — поле id текстом для подписи ("" — пусто или ошибка).
func (e *Evaluator) display(id string) string {
	var f *Field
	if e.s != nil {
		f = e.s.Fields[id]
	}
	if f == nil {
		switch v := lookupPath(e.data, id).(type) {
		case []any:
			parts := make([]string, 0, len(v))
			for _, x := range v {
				parts = append(parts, scalarText(x))
			}
			return strings.Join(parts, ", ")
		default:
			return scalarText(v)
		}
	}
	raw := lookupPath(e.data, f.Path)
	switch f.Type {
	case TypeNumber, TypeComputed:
		if f.Type == TypeNumber && (raw == nil || raw == "") {
			return ""
		}
		v, err := e.Value(id)
		if err != nil {
			return ""
		}
		return FormatNumber(v)
	case TypeSelect:
		text := scalarText(raw)
		for _, o := range f.Options {
			if o.Value == text {
				return o.Label
			}
		}
		return text
	case TypeBool:
		if b, _ := raw.(bool); b {
			return f.Label
		}
		return ""
	case TypeTemplate:
		return FormatSubtitle(f.Template, e.display)
	case TypeRoll:
		c := e.s.compiled()[id]
		if c.err != nil {
			return ""
		}
		r, err := c.expr.Dice(e.resolver(""))
		if err != nil {
			return ""
		}
		return r.Formula
	}
	return scalarText(raw)
}

// scalarText — строка или число из JSON текстом; остальное — "".
func scalarText(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	}
	return ""
}

// FormatNumber — число для подписи: целое как есть, дробь — до сотых
// (floor(x·100 + 0.5), как round в формулах — одинаково с клиентом).
func FormatNumber(v float64) string {
	if v == math.Trunc(v) {
		return strconv.FormatFloat(v, 'f', -1, 64)
	}
	return strconv.FormatFloat(math.Floor(v*100+0.5)/100, 'f', -1, 64)
}
