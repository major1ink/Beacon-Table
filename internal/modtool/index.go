package modtool

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"beacon-table/internal/module"
)

// IndexFormat — версия формата index.json.
const IndexFormat = "beacon-module-index/v1"

// Index — каталог модулей (index.json): по записи на модуль, последняя
// версия. Его читает витрина.
type Index struct {
	Format  string       `json:"format"`
	Modules []IndexEntry `json:"modules"`
}

// IndexEntry — один модуль в каталоге.
type IndexEntry struct {
	ID            string              `json:"id"`
	Title         string              `json:"title"`
	Type          string              `json:"type"`
	Version       string              `json:"version"`
	Description   string              `json:"description,omitempty"`
	Author        string              `json:"author,omitempty"`
	License       string              `json:"license,omitempty"`
	MinAppVersion string              `json:"minAppVersion,omitempty"`
	Systems       []string            `json:"systems,omitempty"`
	Requires      []module.Dependency `json:"requires,omitempty"`
	LegacyIDs     bool                `json:"legacyIds,omitempty"`
	Size          int64               `json:"size"`
	SHA256        string              `json:"sha256"`
	URL           string              `json:"url"`
	SummaryURL    string              `json:"summaryUrl"`
}

// BuildIndex собирает каталог по выпускам из папки out (результаты
// PackModule); baseURL — корень загрузок выпусков
// (https://github.com/<владелец>/<репозиторий>/releases/download), файл
// лежит по <baseURL>/<id>%2Fv<версия>/<файл>. merge — прежний каталог:
// модули, которых нет в out, остаются как были.
func BuildIndex(out, baseURL string, merge *Index) (*Index, error) {
	sums, err := filepath.Glob(filepath.Join(out, "*.summary.json"))
	if err != nil {
		return nil, err
	}
	byID := map[string]IndexEntry{}
	if merge != nil {
		for _, e := range merge.Modules {
			byID[e.ID] = e
		}
	}
	for _, file := range sums {
		s, err := ReadSummary(file)
		if err != nil {
			return nil, err
		}
		base := s.ID + "-" + s.Version
		hash, size, err := fileHash(filepath.Join(out, base+".btmod"))
		if err != nil {
			return nil, fmt.Errorf("для сводки %s нет архива: %w", filepath.Base(file), err)
		}
		tag := url.PathEscape(s.ID + "/v" + s.Version)
		root := strings.TrimRight(baseURL, "/") + "/" + tag + "/"
		byID[s.ID] = IndexEntry{
			ID: s.ID, Title: s.Title, Type: s.Type, Version: s.Version, Description: s.Description,
			Author: s.Author, License: s.License, MinAppVersion: s.MinAppVersion, Systems: s.Systems,
			Requires: s.Requires, LegacyIDs: s.LegacyIDs, Size: size, SHA256: hash,
			URL: root + base + ".btmod", SummaryURL: root + base + ".summary.json",
		}
	}
	idx := &Index{Format: IndexFormat, Modules: make([]IndexEntry, 0, len(byID))}
	for _, e := range byID {
		idx.Modules = append(idx.Modules, e)
	}
	sort.Slice(idx.Modules, func(i, j int) bool { return idx.Modules[i].ID < idx.Modules[j].ID })
	return idx, nil
}

// ReadIndex читает index.json с диска.
func ReadIndex(file string) (*Index, error) {
	data, err := os.ReadFile(file) //nolint:gosec // путь задаёт автор модуля
	if err != nil {
		return nil, err
	}
	var idx Index
	if err := json.Unmarshal(data, &idx); err != nil {
		return nil, fmt.Errorf("%s: %w", file, err)
	}
	return &idx, nil
}

// MarshalJSON — отступы в два пробела, «&» и «<» как есть (json.Marshal по
// умолчанию заменяет их escape-последовательностями) и перевод строки в конце.
func MarshalJSON(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
