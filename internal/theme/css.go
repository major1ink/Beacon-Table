package theme

import (
	"errors"
	"fmt"
	"io/fs"
	"path"
	"regexp"
	"strings"
)

var (
	propRe     = regexp.MustCompile(`^(?:--[a-z0-9-]+|-?[a-z]+(?:-[a-z]+)*)$`)
	selectorRe = regexp.MustCompile(`^[A-Za-z0-9_\-#.\s>+~*:()\[\],="'^$|%]+$`)
	mediaRe    = regexp.MustCompile(`^@media[\sa-z0-9:()<>=,.\-/]+$`)
	urlRe      = regexp.MustCompile(`(?i)url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)`)
	zIndexRe   = regexp.MustCompile(`^-?\d+$`)

	bannedText  = []string{"@import", "expression", "behavior", "binding", "javascript:", "vbscript:", "data:"}
	bannedFuncs = []string{"image-set(", "-webkit-image-set(", "src(", "element(", "cross-fade("}
	fontProps   = set("font-family", "src", "font-weight", "font-style", "font-display", "unicode-range", "font-stretch")
)

type block struct {
	prelude string
	body    string
}

type sanitizer struct {
	id     string
	fsys   fs.FS
	assets string
}

// Sanitize проверяет CSS модуля и привязывает его к листу и карточкам: каждый
// селектор получает префикс из Scopes. Разрешены обычные правила, @media и
// @font-face; url() — только на файлы assets/ этого модуля. Всё остальное —
// ошибка, а не молчаливый пропуск: автор сразу видит, что не принято.
func Sanitize(src, id string, fsys fs.FS, assets string) (string, error) {
	s := &sanitizer{id: id, fsys: fsys, assets: assets}
	css, err := stripComments(src)
	if err != nil {
		return "", err
	}
	if strings.ContainsAny(css, "\\<\x00") {
		return "", errors.New(`недопустимый символ (\, < или NUL)`)
	}
	lower := strings.ToLower(css)
	for _, bad := range bannedText {
		if strings.Contains(lower, bad) {
			return "", fmt.Errorf("%q в стилях не допускается", bad)
		}
	}
	blocks, err := splitBlocks(css)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	for _, bl := range blocks {
		if err := s.rule(&b, bl, false); err != nil {
			return "", err
		}
	}
	return b.String(), nil
}

func stripComments(src string) (string, error) {
	var b strings.Builder
	for i := 0; i < len(src); {
		if strings.HasPrefix(src[i:], "/*") {
			j := strings.Index(src[i+2:], "*/")
			if j < 0 {
				return "", errors.New("не закрыт комментарий")
			}
			i += j + 4
			b.WriteByte(' ')
			continue
		}
		b.WriteByte(src[i])
		i++
	}
	return b.String(), nil
}

// splitBlocks делит CSS на «заголовок { тело }» с учётом строк и скобок.
func splitBlocks(css string) ([]block, error) {
	var out []block
	i := 0
	for {
		for i < len(css) && isSpace(css[i]) {
			i++
		}
		if i >= len(css) {
			return out, nil
		}
		start := i
		var quote byte
		open := -1
		for ; i < len(css) && open < 0; i++ {
			c := css[i]
			switch {
			case quote != 0:
				if c == quote {
					quote = 0
				}
			case c == '"' || c == '\'':
				quote = c
			case c == '{':
				open = i
			case c == '}' || c == ';':
				return nil, fmt.Errorf("лишний %q вне блока: %s", string(c), snippet(css[start:i]))
			}
		}
		if open < 0 {
			return nil, fmt.Errorf("после %q нет блока { }", snippet(css[start:]))
		}
		depth := 1
		bodyStart := open + 1
		quote = 0
		for i = bodyStart; i < len(css) && depth > 0; i++ {
			c := css[i]
			switch {
			case quote != 0:
				if c == quote {
					quote = 0
				}
			case c == '"' || c == '\'':
				quote = c
			case c == '{':
				depth++
			case c == '}':
				depth--
			}
		}
		if depth != 0 {
			return nil, fmt.Errorf("не закрыта скобка { в %s", snippet(css[start:open]))
		}
		out = append(out, block{prelude: strings.TrimSpace(css[start:open]), body: css[bodyStart : i-1]})
	}
}

func isSpace(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' }

func snippet(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > 40 {
		s = s[:40] + "…"
	}
	return s
}

func (s *sanitizer) rule(b *strings.Builder, bl block, inMedia bool) error {
	prelude := strings.ToLower(strings.Join(strings.Fields(bl.prelude), " "))
	switch {
	case prelude == "@font-face":
		if inMedia {
			return errors.New("@font-face внутри @media не допускается")
		}
		decls, err := s.decls(bl.body, true)
		if err != nil {
			return err
		}
		b.WriteString("@font-face{" + decls + "}\n")
	case strings.HasPrefix(prelude, "@media"):
		if inMedia {
			return errors.New("@media внутри @media не допускается")
		}
		if !mediaRe.MatchString(prelude) {
			return fmt.Errorf("условие %q не поддерживается", snippet(bl.prelude))
		}
		inner, err := splitBlocks(bl.body)
		if err != nil {
			return err
		}
		b.WriteString(prelude + "{")
		for _, in := range inner {
			if err := s.rule(b, in, true); err != nil {
				return err
			}
		}
		b.WriteString("}\n")
	case strings.HasPrefix(prelude, "@"):
		return fmt.Errorf("правило %s не поддерживается (доступны @media и @font-face)", strings.Fields(prelude)[0])
	default:
		sel, err := scopeSelectors(bl.prelude)
		if err != nil {
			return err
		}
		decls, err := s.decls(bl.body, false)
		if err != nil {
			return err
		}
		b.WriteString(sel + "{" + decls + "}\n")
	}
	return nil
}

// scopeSelectors — каждый селектор из списка получает префикс каждого корня;
// :scope означает сам корень.
func scopeSelectors(prelude string) (string, error) {
	parts, err := splitTop(prelude, ',')
	if err != nil {
		return "", err
	}
	var out []string
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" || !selectorRe.MatchString(p) {
			return "", fmt.Errorf("селектор %q не допускается", snippet(p))
		}
		for _, scope := range Scopes {
			if strings.Contains(p, ":scope") {
				out = append(out, strings.ReplaceAll(p, ":scope", scope))
			} else {
				out = append(out, scope+" "+p)
			}
		}
	}
	return strings.Join(out, ","), nil
}

// splitTop делит строку по sep вне скобок и кавычек.
func splitTop(s string, sep byte) ([]string, error) {
	var parts []string
	var quote byte
	depth, last := 0, 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case quote != 0:
			if c == quote {
				quote = 0
			}
		case c == '"' || c == '\'':
			quote = c
		case c == '(' || c == '[':
			depth++
		case c == ')' || c == ']':
			depth--
		case c == sep && depth == 0:
			parts = append(parts, s[last:i])
			last = i + 1
		}
	}
	if quote != 0 || depth != 0 {
		return nil, fmt.Errorf("не закрыты кавычки или скобки: %s", snippet(s))
	}
	return append(parts, s[last:]), nil
}

func (s *sanitizer) decls(body string, font bool) (string, error) {
	if strings.ContainsAny(body, "{}") {
		return "", errors.New("вложенные правила не поддерживаются")
	}
	parts, err := splitTop(body, ';')
	if err != nil {
		return "", err
	}
	var b strings.Builder
	for _, d := range parts {
		d = strings.TrimSpace(d)
		if d == "" {
			continue
		}
		prop, value, ok := strings.Cut(d, ":")
		prop, value = strings.ToLower(strings.TrimSpace(prop)), strings.TrimSpace(value)
		if !ok || value == "" || !propRe.MatchString(prop) {
			return "", fmt.Errorf("объявление %q не разобрать", snippet(d))
		}
		if font && !fontProps[prop] {
			return "", fmt.Errorf("в @font-face нельзя %s", prop)
		}
		if err := s.checkValue(prop, value); err != nil {
			return "", err
		}
		b.WriteString(prop + ":" + value + ";")
	}
	return b.String(), nil
}

func (s *sanitizer) checkValue(prop, value string) error {
	if len(value) > maxDeclLen {
		return fmt.Errorf("%s: значение длиннее %d знаков", prop, maxDeclLen)
	}
	lower := strings.ToLower(value)
	plain := strings.TrimSpace(strings.TrimSuffix(lower, "!important"))
	if prop == "position" && (plain == "fixed" || plain == "sticky") {
		return fmt.Errorf("position: %s не допускается — оформление не должно выходить за лист", plain)
	}
	if prop == "z-index" && (!zIndexRe.MatchString(plain) || len(plain) > 3) {
		return errors.New("z-index — целое число до трёх знаков")
	}
	for _, f := range bannedFuncs {
		if strings.Contains(lower, f) {
			return fmt.Errorf("%s в значении %s не допускается", f, prop)
		}
	}
	urls := urlRe.FindAllStringSubmatch(value, -1)
	if strings.Count(lower, "url(") != len(urls) {
		return fmt.Errorf("%s: url() не разобрать", prop)
	}
	for _, m := range urls {
		if err := s.checkURL(m[1] + m[2] + m[3]); err != nil {
			return fmt.Errorf("%s: %w", prop, err)
		}
	}
	return nil
}

// checkURL — только файлы assets/ этого же модуля, и файл должен быть.
func (s *sanitizer) checkURL(u string) error {
	rel, ok := strings.CutPrefix(u, assetsPrefix+s.id+"/")
	if !ok || rel == "" || strings.Contains(rel, "..") || strings.ContainsAny(rel, "?#") {
		return fmt.Errorf("url(%s): допустимы только файлы модуля — %s%s/…", snippet(u), assetsPrefix, s.id)
	}
	if s.fsys != nil {
		if _, err := fs.Stat(s.fsys, path.Join(s.assets, rel)); err != nil {
			return fmt.Errorf("файла %s нет в assets/", rel)
		}
	}
	return nil
}
