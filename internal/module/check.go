package module

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"path"
	"regexp"
	"strings"

	"beacon-table/internal/domain"
	"beacon-table/internal/theme"
)

var (
	slugRe   = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
	assetsRe = regexp.MustCompile(`^/module-assets/([^/]+)/(.+)$`)
)

// Card — карточка модуля глазами проверки.
type Card struct {
	Kind string
	Slug string
	Name string
	File string
}

// ContentReport — итог проверки карточек и картинок модуля: с ошибками
// модуль не ставится и не выпускается, предупреждения — подсказки автору.
type ContentReport struct {
	Cards    []Card
	Errors   []string
	Warnings []string
}

func (r *ContentReport) errorf(format string, args ...any) {
	r.Errors = append(r.Errors, fmt.Sprintf(format, args...))
}

func (r *ContentReport) warnf(format string, args ...any) {
	r.Warnings = append(r.Warnings, fmt.Sprintf(format, args...))
}

// cardTypes — во что разбирается карточка каждого вида.
var cardTypes = map[string]func() any{
	KindBestiary:   func() any { return &domain.Monster{} },
	KindSpells:     func() any { return &domain.Spell{} },
	KindItems:      func() any { return &domain.Item{} },
	KindReferences: func() any { return &domain.Reference{} },
	KindConditions: func() any { return &domain.Condition{} },
}

// CheckContent разбирает все карточки модуля в стандартной раскладке и
// проверяет картинки, на которые они ссылаются.
func CheckContent(fsys fs.FS, man *Manifest) *ContentReport {
	r := &ContentReport{}
	for _, kind := range Kinds {
		entries, err := fs.ReadDir(fsys, kind)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), ".") {
				continue
			}
			file := path.Join(kind, e.Name())
			switch {
			case e.IsDir():
				r.errorf("%s: вложенные папки в разделе не бывают", file)
				continue
			case !strings.HasSuffix(e.Name(), ".json"):
				r.errorf("%s: карточка — файл .json", file)
				continue
			}
			if c, ok := r.checkCard(fsys, kind, file); ok {
				r.Cards = append(r.Cards, c)
			}
		}
	}
	r.checkAssets(fsys, man)
	return r
}

func (r *ContentReport) checkCard(fsys fs.FS, kind, file string) (Card, bool) {
	c := Card{Kind: kind, File: file, Slug: strings.TrimSuffix(path.Base(file), ".json")}
	if !slugRe.MatchString(c.Slug) {
		r.errorf("%s: имя файла — латиница, цифры и дефисы", file)
	}
	data, err := fs.ReadFile(fsys, file)
	if err != nil {
		r.errorf("%s: %v", file, err)
		return c, false
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		r.errorf("%s: не JSON-объект: %v", file, err)
		return c, false
	}
	for _, k := range []string{"id", "updatedAt"} {
		if _, ok := raw[k]; ok {
			r.errorf("%s: в карточке модуля нет %q — его проставляет программа", file, k)
		}
	}
	into := cardTypes[kind]()
	if err := json.Unmarshal(data, into); err != nil {
		r.errorf("%s: %v", file, err)
		return c, false
	}
	extra := extraOf(into)
	if len(extra) > domain.MaxExtraKeys {
		r.errorf("%s: ключей системы больше %d — лишние программа отбросит", file, domain.MaxExtraKeys)
	}
	for k, v := range extra {
		if len([]rune(k)) > domain.MaxExtraKeyLen || len(v) > domain.MaxExtraValueLen {
			r.errorf("%s: ключ %q не поместится в клон карточки (имя до %d рун, значение до %d КБ)", file, k, domain.MaxExtraKeyLen, domain.MaxExtraValueLen>>10)
		}
	}
	_ = json.Unmarshal(raw["name"], &c.Name)
	if strings.TrimSpace(c.Name) == "" {
		r.errorf("%s: нет имени (name)", file)
	}
	if kind == KindConditions {
		var slug string
		_ = json.Unmarshal(raw["slug"], &slug)
		if slug != c.Slug {
			r.errorf("%s: slug состояния %q должен совпадать с именем файла", file, slug)
		}
	}
	return c, true
}

func extraOf(v any) domain.Extra {
	switch c := v.(type) {
	case *domain.Monster:
		return c.Extra
	case *domain.Spell:
		return c.Extra
	case *domain.Item:
		return c.Extra
	case *domain.Reference:
		return c.Extra
	case *domain.Condition:
		return c.Extra
	}
	return nil
}

func imageURL(fsys fs.FS, file string) string {
	data, err := fs.ReadFile(fsys, file)
	if err != nil {
		return ""
	}
	var c struct {
		ImageURL string `json:"imageUrl"`
	}
	_ = json.Unmarshal(data, &c)
	return c.ImageURL
}

func (r *ContentReport) checkAssets(fsys fs.FS, man *Manifest) {
	used := map[string]bool{}
	for _, c := range r.Cards {
		u := imageURL(fsys, c.File)
		if u == "" {
			continue
		}
		m := assetsRe.FindStringSubmatch(u)
		switch {
		case m == nil:
			r.warnf("%s: imageUrl %q — внешняя ссылка, картинка модуля должна лежать в assets/", c.File, u)
		case m[1] != man.ID:
			r.errorf("%s: imageUrl ведёт в чужой модуль %q", c.File, m[1])
		default:
			used[m[2]] = true
			if _, err := fs.Stat(fsys, path.Join("assets", m[2])); err != nil {
				r.errorf("%s: нет картинки assets/%s", c.File, m[2])
			}
		}
	}
	if spec, err := theme.Parse(man.Theme); err == nil {
		for _, rel := range spec.UsedAssets(man.ID, fsys) {
			used[rel] = true
		}
	}
	_ = fs.WalkDir(fsys, "assets", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if rel := strings.TrimPrefix(p, "assets/"); !used[rel] {
			r.warnf("%s: файл не используется ни одной карточкой", p)
		}
		return nil
	})
}
