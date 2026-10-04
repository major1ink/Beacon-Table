// Package theme — оформление игровой системы из модуля: токены цветов,
// шрифты и свой CSS листа и карточек. Модуль приносит данные, а не код:
// всё проходит проверку и отдаётся клиенту одним CSS (см. Render).
package theme

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io/fs"
	"path"
	"regexp"
	"sort"
	"strings"
)

const (
	MaxStyles     = 4
	MaxStyleSize  = 200 << 10
	MaxFonts      = 8
	MaxFontSize   = 1 << 20
	MaxCSSSize    = 1 << 20
	maxVarLen     = 100
	maxDeclLen    = 500
	assetsPrefix  = "/module-assets/"
	defaultSerifs = `Georgia, "Times New Roman", serif`
)

// Scopes — корни листа и карточек: правила модуля действуют только внутри них.
// Префикс html поднимает вес селектора выше правил ядра независимо от порядка
// подключения таблиц.
var Scopes = []string{"html .card-root", "html .sheet-root"}

// Spec — раздел theme из module.json.
type Spec struct {
	Vars    map[string]string `json:"vars,omitempty"`
	Fonts   []Font            `json:"fonts,omitempty"`
	Display string            `json:"display,omitempty"`
	Styles  []string          `json:"styles,omitempty"`
}

// Font — шрифт из assets/ модуля.
type Font struct {
	Family string `json:"family"`
	File   string `json:"file"`
	Weight int    `json:"weight,omitempty"`
	Style  string `json:"style,omitempty"`
	// UnicodeRange — какие знаки берутся из файла (U+0400-045F): так одно
	// семейство собирается из файлов кириллицы и латиницы.
	UnicodeRange string `json:"unicodeRange,omitempty"`
}

var (
	colorVars  = set("bg", "rail-bg", "panel-bg", "surface", "surface-hover", "border", "text", "text-dim", "accent", "accent-hover", "accent-bg", "on-accent", "heading", "danger", "danger-hover", "green", "green-hover", "green-bright", "gold", "amber", "blue", "glass-bg", "glass-bg-strong", "glass-border")
	lengthVars = set("radius", "radius-lg")

	hexColor   = regexp.MustCompile(`^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$`)
	funcColor  = regexp.MustCompile(`^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.%,\s/-]+\)$`)
	lengthRe   = regexp.MustCompile(`^\d{1,3}(?:\.\d+)?(?:px|rem|em)$`)
	familyRe   = regexp.MustCompile(`^[\p{L}\p{N} _-]{1,40}$`)
	fontFileRe = regexp.MustCompile(`^[A-Za-z0-9_-]+(?:/[A-Za-z0-9_.-]+)*\.(?:woff2|woff)$`)
	styleRe    = regexp.MustCompile(`^theme/[A-Za-z0-9_-]+\.css$`)
	rangeRe    = regexp.MustCompile(`^U\+[0-9A-Fa-f?]{1,6}(?:-[0-9A-Fa-f]{1,6})?(?:,\s*U\+[0-9A-Fa-f?]{1,6}(?:-[0-9A-Fa-f]{1,6})?)*$`)
)

func set(keys ...string) map[string]bool {
	m := make(map[string]bool, len(keys))
	for _, k := range keys {
		m[k] = true
	}
	return m
}

// Parse разбирает theme; пустой раздел — nil. Незнакомые поля и значения вне
// правил — ошибка: тема не ставится вполовину.
func Parse(raw json.RawMessage) (*Spec, error) {
	if len(bytes.TrimSpace(raw)) == 0 || string(bytes.TrimSpace(raw)) == "null" {
		return nil, nil
	}
	var s Spec
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&s); err != nil {
		return nil, fmt.Errorf("theme не разбирается: %w", err)
	}
	if err := s.validate(); err != nil {
		return nil, err
	}
	return &s, nil
}

func (s *Spec) validate() error {
	for name, v := range s.Vars {
		switch {
		case colorVars[name]:
			if len(v) > maxVarLen || (!hexColor.MatchString(v) && !funcColor.MatchString(v)) {
				return fmt.Errorf("theme: переменная %s — нужен цвет (#rrggbb, rgb(), hsl()), а не %q", name, v)
			}
		case lengthVars[name]:
			if !lengthRe.MatchString(v) {
				return fmt.Errorf("theme: переменная %s — нужна длина (12px), а не %q", name, v)
			}
		default:
			return fmt.Errorf("theme: переменной %q нет в списке (доступны: %s)", name, strings.Join(varNames(), ", "))
		}
	}
	if len(s.Fonts) > MaxFonts {
		return fmt.Errorf("theme: шрифтов больше %d", MaxFonts)
	}
	families := map[string]bool{}
	for _, f := range s.Fonts {
		if !familyRe.MatchString(f.Family) {
			return fmt.Errorf("theme: имя шрифта %q — только буквы, цифры, пробел, _ и -, до 40 знаков", f.Family)
		}
		if !fontFileRe.MatchString(f.File) || strings.Contains(f.File, "..") {
			return fmt.Errorf("theme: файл шрифта %q — woff2 или woff в assets/", f.File)
		}
		if f.Weight != 0 && (f.Weight < 100 || f.Weight > 900 || f.Weight%100 != 0) {
			return fmt.Errorf("theme: начертание шрифта %s — от 100 до 900 с шагом 100", f.Family)
		}
		if f.Style != "" && f.Style != "normal" && f.Style != "italic" {
			return fmt.Errorf("theme: стиль шрифта %s — normal или italic", f.Family)
		}
		if f.UnicodeRange != "" && (len(f.UnicodeRange) > 600 || !rangeRe.MatchString(f.UnicodeRange)) {
			return fmt.Errorf("theme: unicodeRange шрифта %s — вида U+0400-045F, U+0490", f.Family)
		}
		families[f.Family] = true
	}
	if s.Display != "" && !families[s.Display] {
		return fmt.Errorf("theme: display %q — такого шрифта нет в fonts", s.Display)
	}
	if len(s.Styles) > MaxStyles {
		return fmt.Errorf("theme: файлов стилей больше %d", MaxStyles)
	}
	for _, f := range s.Styles {
		if !styleRe.MatchString(f) {
			return fmt.Errorf("theme: стиль %q — файл theme/<имя>.css", f)
		}
	}
	return nil
}

func varNames() []string {
	var out []string
	for k := range colorVars {
		out = append(out, k)
	}
	for k := range lengthVars {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Render собирает CSS темы модуля id: шрифты, токены и свои стили. fsys —
// корень модуля, assets — папка картинок в нём.
func Render(id string, s *Spec, fsys fs.FS, assets string) (string, error) {
	if s == nil {
		return "", nil
	}
	var b strings.Builder
	for _, f := range s.Fonts {
		info, err := fs.Stat(fsys, path.Join(assets, f.File))
		if err != nil {
			return "", fmt.Errorf("theme: шрифта %s нет в assets/%s", f.Family, f.File)
		}
		if info.Size() > MaxFontSize {
			return "", fmt.Errorf("theme: шрифт %s больше %d КБ", f.Family, MaxFontSize>>10)
		}
		format := "woff2"
		if strings.HasSuffix(f.File, ".woff") {
			format = "woff"
		}
		weight, style := f.Weight, f.Style
		if weight == 0 {
			weight = 400
		}
		if style == "" {
			style = "normal"
		}
		ranges := ""
		if f.UnicodeRange != "" {
			ranges = ";unicode-range:" + f.UnicodeRange
		}
		fmt.Fprintf(&b, "@font-face{font-family:%q;src:url(%q) format(%q);font-weight:%d;font-style:%s;font-display:swap%s}\n", f.Family, assetsPrefix+id+"/"+f.File, format, weight, style, ranges)
	}
	if len(s.Vars) > 0 || s.Display != "" {
		b.WriteString("html:root{")
		names := make([]string, 0, len(s.Vars))
		for k := range s.Vars {
			names = append(names, k)
		}
		sort.Strings(names)
		for _, k := range names {
			fmt.Fprintf(&b, "--%s:%s;", k, s.Vars[k])
		}
		if s.Display != "" {
			fmt.Fprintf(&b, "--font-serif:%q,%s;", s.Display, defaultSerifs)
		}
		b.WriteString("}\n")
	}
	for _, file := range s.Styles {
		data, err := fs.ReadFile(fsys, file)
		if err != nil {
			return "", fmt.Errorf("theme: стиля %s нет в модуле", file)
		}
		if len(data) > MaxStyleSize {
			return "", fmt.Errorf("theme: %s больше %d КБ", file, MaxStyleSize>>10)
		}
		css, err := Sanitize(string(data), id, fsys, assets)
		if err != nil {
			return "", fmt.Errorf("theme: %s: %w", file, err)
		}
		b.WriteString(css)
	}
	if b.Len() > MaxCSSSize {
		return "", fmt.Errorf("theme: итоговый CSS больше %d КБ", MaxCSSSize>>10)
	}
	return b.String(), nil
}

// Preview — цвета для превью системы в витрине.
func (s *Spec) Preview() map[string]string {
	if s == nil {
		return nil
	}
	out := map[string]string{}
	for _, k := range []string{"bg", "surface", "accent", "gold", "text"} {
		if v, ok := s.Vars[k]; ok {
			out[k] = v
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// UsedAssets — файлы assets/, на которые ссылается тема: шрифты и url() в
// стилях. Нужно проверке «файл не используется ни одной карточкой».
func (s *Spec) UsedAssets(id string, fsys fs.FS) []string {
	if s == nil {
		return nil
	}
	var out []string
	for _, f := range s.Fonts {
		out = append(out, f.File)
	}
	prefix := assetsPrefix + id + "/"
	for _, file := range s.Styles {
		data, err := fs.ReadFile(fsys, file)
		if err != nil {
			continue
		}
		for _, m := range urlRe.FindAllStringSubmatch(string(data), -1) {
			if rel, ok := strings.CutPrefix(m[1]+m[2]+m[3], prefix); ok {
				out = append(out, rel)
			}
		}
	}
	return out
}
