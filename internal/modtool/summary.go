package modtool

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"sort"
	"strings"

	"beacon-table/internal/module"
)

// Summary — сводка выпуска модуля (summary.json): манифест и состав, чтобы
// витрина показала модуль, не скачивая его.
type Summary struct {
	ID            string              `json:"id"`
	Version       string              `json:"version"`
	Title         string              `json:"title"`
	Type          string              `json:"type"`
	Description   string              `json:"description,omitempty"`
	Author        string              `json:"author,omitempty"`
	License       string              `json:"license,omitempty"`
	MinAppVersion string              `json:"minAppVersion,omitempty"`
	Systems       []string            `json:"systems,omitempty"`
	Requires      []module.Dependency `json:"requires,omitempty"`
	LegacyIDs     bool                `json:"legacyIds,omitempty"`
	Counts        map[string]int      `json:"counts"`
	Names         map[string][]string `json:"names"`
	Slugs         map[string][]string `json:"slugs"`
	Changelog     string              `json:"changelog,omitempty"`
}

// Summarize собирает сводку по папке модуля; модуль предварительно должен
// пройти ValidateModule.
func Summarize(dir string) (*Summary, error) {
	fsys := os.DirFS(dir)
	data, err := fs.ReadFile(fsys, "module.json")
	if err != nil {
		return nil, fmt.Errorf("нет module.json: %w", err)
	}
	man, err := module.ParseManifest(data)
	if err != nil {
		return nil, err
	}
	s := &Summary{
		ID: man.ID, Version: man.Version, Title: man.Title, Type: man.Type,
		Description: man.Description, Author: man.Author, License: man.License,
		MinAppVersion: man.MinAppVersion, Systems: man.Systems, Requires: man.Requires, LegacyIDs: man.LegacyIDs,
		Counts: map[string]int{}, Names: map[string][]string{}, Slugs: map[string][]string{},
	}
	r := &Report{}
	for kind, cards := range checkCards(r, fsys) {
		for _, c := range cards {
			s.Counts[kind]++
			s.Names[kind] = append(s.Names[kind], c.name)
			s.Slugs[kind] = append(s.Slugs[kind], c.slug)
		}
		sort.Strings(s.Names[kind])
		sort.Strings(s.Slugs[kind])
	}
	if log, err := fs.ReadFile(fsys, "CHANGELOG.md"); err == nil {
		s.Changelog = changelogEntry(string(log), man.Version)
	}
	return s, nil
}

// changelogEntry — текст записи версии version (без заголовка) до следующего
// заголовка «## ».
func changelogEntry(log, version string) string {
	var out []string
	in := false
	for _, line := range strings.Split(log, "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.HasPrefix(line, "## ") {
			if in {
				break
			}
			if m := changelogRe.FindStringSubmatch(line); m != nil && m[1] == version {
				in = true
			}
			continue
		}
		if in {
			out = append(out, line)
		}
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}

// ReadSummary читает summary.json с диска.
func ReadSummary(file string) (*Summary, error) {
	data, err := os.ReadFile(file) //nolint:gosec // путь задаёт автор модуля
	if err != nil {
		return nil, err
	}
	var s Summary
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, fmt.Errorf("%s: %w", file, err)
	}
	return &s, nil
}
