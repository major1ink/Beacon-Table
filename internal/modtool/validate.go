// Package modtool — проверка, упаковка и каталог модулей контента (см.
// internal/module). Им пользуется утилита cmd/btmod в репозитории модулей:
// карточки проверяются тем же кодом, что и при установке в программу, а
// сверх того — раскладка, CHANGELOG, тег и вечность slug.
package modtool

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"beacon-table/internal/module"
)

// Report — итог проверки одного модуля: ошибки не дают выпустить модуль,
// предупреждения — подсказки автору.
type Report struct {
	Dir      string
	Errors   []string
	Warnings []string
}

func (r *Report) errorf(format string, args ...any) {
	r.Errors = append(r.Errors, fmt.Sprintf(format, args...))
}

// OK — ошибок нет.
func (r *Report) OK() bool { return len(r.Errors) == 0 }

// Options — необязательные проверки.
type Options struct {
	// Tag — тег выпуска «<id>/v<версия>»: id и версия должны совпасть с
	// module.json.
	Tag string
	// Prev — сводка прошлой версии: пропавший slug карточки допустим только
	// при повышении major.
	Prev *Summary
}

var (
	changelogRe = regexp.MustCompile(`^##\s+(\d+\.\d+\.\d+)\s+[—-]\s+(\d{4}-\d{2}-\d{2})\s*$`)
)

// Допустимые файлы и папки верхнего уровня модуля.
var topDirs = map[string]bool{"schemas": true, "assets": true}

func init() {
	for _, k := range module.Kinds {
		topDirs[k] = true
	}
}

func allowedFile(name string) bool {
	upper := strings.ToUpper(name)
	return name == "module.json" || name == "CHANGELOG.md" || name == "README.md" ||
		strings.HasPrefix(upper, "LICENSE") || strings.HasPrefix(upper, "NOTICE")
}

// ValidateModule проверяет папку модуля. Манифест, не читающийся вовсе,
// останавливает проверку — дальше проверять нечего.
func ValidateModule(dir string, opts Options) *Report {
	r := &Report{Dir: dir}
	fsys := os.DirFS(dir)
	man := readManifest(r, fsys)
	if man == nil {
		return r
	}
	checkLayout(r, fsys)
	if _, err := module.LoadSchemas(fsys, "schemas", man); err != nil {
		r.errorf("схемы: %v", err)
	}
	content := module.CheckContent(fsys, man)
	r.Errors = append(r.Errors, content.Errors...)
	r.Warnings = append(r.Warnings, content.Warnings...)
	checkChangelog(r, fsys, man)
	if opts.Tag != "" {
		checkTag(r, man, opts.Tag)
	}
	if opts.Prev != nil {
		checkSlugs(r, man, content.Cards, opts.Prev)
	}
	return r
}

func readManifest(r *Report, fsys fs.FS) *module.Manifest {
	data, err := fs.ReadFile(fsys, "module.json")
	if err != nil {
		r.errorf("нет module.json")
		return nil
	}
	man, err := module.ParseManifest(data)
	if err != nil {
		r.errorf("module.json: %v", err)
		return nil
	}
	return man
}

func checkLayout(r *Report, fsys fs.FS) {
	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		r.errorf("папка модуля не читается: %v", err)
		return
	}
	for _, e := range entries {
		name := e.Name()
		switch {
		case strings.HasPrefix(name, "."):
		case e.IsDir() && topDirs[name]:
		case e.IsDir():
			r.errorf("%s/: лишняя папка (допустимы %s)", name, strings.Join(sortedKeys(topDirs), ", "))
		case !allowedFile(name):
			r.errorf("%s: лишний файл (допустимы module.json, CHANGELOG.md, LICENSE*, NOTICE*, README.md)", name)
		}
	}
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// changelogTop — версия и дата первой записи CHANGELOG.md.
func changelogTop(data []byte) (version, date string, ok bool) {
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimRight(line, "\r")
		if !strings.HasPrefix(line, "## ") {
			continue
		}
		m := changelogRe.FindStringSubmatch(line)
		if m == nil {
			return "", "", false
		}
		return m[1], m[2], true
	}
	return "", "", false
}

func checkChangelog(r *Report, fsys fs.FS, man *module.Manifest) {
	data, err := fs.ReadFile(fsys, "CHANGELOG.md")
	if err != nil {
		r.errorf("нет CHANGELOG.md")
		return
	}
	version, _, ok := changelogTop(data)
	switch {
	case !ok:
		r.errorf("CHANGELOG.md: первая запись должна быть вида «## 1.2.0 — 2026-09-30»")
	case version != man.Version:
		r.errorf("CHANGELOG.md: первая запись — %s, а в module.json версия %s", version, man.Version)
	}
}

func checkTag(r *Report, man *module.Manifest, tag string) {
	want := man.ID + "/v" + man.Version
	if tag != want {
		r.errorf("тег %q не совпадает с module.json: ожидали %q", tag, want)
	}
}

func checkSlugs(r *Report, man *module.Manifest, cards []module.Card, prev *Summary) {
	cur, err1 := module.ParseVersion(man.Version)
	old, err2 := module.ParseVersion(prev.Version)
	if err1 != nil || err2 != nil {
		return
	}
	if cur.Less(old) {
		r.errorf("версия %s ниже прошлой %s", man.Version, prev.Version)
		return
	}
	have := map[string]bool{}
	for _, c := range cards {
		have[c.Kind+"/"+c.Slug] = true
	}
	for _, kind := range module.Kinds {
		for _, slug := range prev.Slugs[kind] {
			if !have[kind+"/"+slug] && cur[0] <= old[0] {
				r.errorf("%s/%s.json пропал из модуля: удаление или переименование карточки — только с повышением major (была %s, стала %s)", kind, slug, prev.Version, man.Version)
			}
		}
	}
}

// ValidateSet — проверки между модулями набора: зависимости и совместимость.
func ValidateSet(dirs []string) []string {
	type entry struct {
		man *module.Manifest
		dir string
	}
	byID := map[string]entry{}
	var problems []string
	for _, dir := range dirs {
		data, err := os.ReadFile(filepath.Join(dir, "module.json")) //nolint:gosec // путь задаёт автор модуля
		if err != nil {
			continue
		}
		man, err := module.ParseManifest(data)
		if err != nil {
			continue
		}
		if prev, dup := byID[man.ID]; dup {
			problems = append(problems, fmt.Sprintf("id %q у двух модулей: %s и %s", man.ID, prev.dir, dir))
		}
		byID[man.ID] = entry{man, dir}
	}
	ids := make([]string, 0, len(byID))
	for id := range byID {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		man := byID[id].man
		for _, dep := range man.Requires {
			found, ok := byID[dep.ID]
			if !ok {
				problems = append(problems, fmt.Sprintf("%s: требует модуль %q, которого нет в наборе", id, dep.ID))
				continue
			}
			if dep.MinVersion != "" {
				need, _ := module.ParseVersion(dep.MinVersion)
				have, _ := module.ParseVersion(found.man.Version)
				if have.Less(need) {
					problems = append(problems, fmt.Sprintf("%s: нужен %s не ниже %s, в наборе %s", id, dep.ID, dep.MinVersion, found.man.Version))
				}
			}
		}
		for _, sys := range man.Systems {
			found, ok := byID[sys]
			if !ok || found.man.Type != module.TypeSystem {
				if man.Type == module.TypeContent {
					problems = append(problems, fmt.Sprintf("%s: совместим с системой %q, которой нет в наборе", id, sys))
				}
			}
		}
	}
	return problems
}
