package http

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"slices"

	"beacon-table/internal/domain"
	"beacon-table/internal/modcatalog"
	"beacon-table/internal/module"
)

// Витрина модулей: каталог из интернета (см. internal/modcatalog). Как и вся
// установка модулей — только владелец.

type catalogEntry struct {
	modcatalog.Entry
	Installed  string `json:"installed,omitempty"`
	Updatable  bool   `json:"updatable"`
	Compatible bool   `json:"compatible"`
}

func (a *API) installedVersion(id string) (string, bool) {
	mod, err := a.Companies.Modules().Get(id)
	if err != nil {
		return "", false
	}
	return mod.Manifest.Version, true
}

func (a *API) requireCatalog(w http.ResponseWriter, r *http.Request) bool {
	if _, ok := a.requireOwner(w, r); !ok {
		return false
	}
	if a.Catalog == nil {
		writeErr(w, http.StatusServiceUnavailable, "каталог модулей недоступен")
		return false
	}
	return true
}

func writeCatalogErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, modcatalog.ErrNotFound):
		writeErr(w, http.StatusNotFound, err.Error())
	case errors.Is(err, modcatalog.ErrUnavailable):
		writeErr(w, http.StatusBadGateway, err.Error())
	default:
		writeModuleErr(w, err)
	}
}

// handleCatalogList — GET /api/module-catalog[?refresh=1]: модули каталогов
// с отметками «установлен» и «есть обновление»; скачивается только индекс.
func (a *API) handleCatalogList(w http.ResponseWriter, r *http.Request) {
	if !a.requireCatalog(w, r) {
		return
	}
	entries, sources := a.Catalog.List(r.Context(), r.URL.Query().Get("refresh") != "")
	out := make([]catalogEntry, 0, len(entries))
	for _, e := range entries {
		ce := catalogEntry{Entry: e, Compatible: a.Catalog.Compatible(e)}
		if v, ok := a.installedVersion(e.ID); ok {
			ce.Installed = v
			ce.Updatable = modcatalog.Newer(e.Version, v)
		}
		out = append(out, ce)
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": out, "sources": sources, "appVersion": a.Version})
}

// handleCatalogSummary — GET /api/module-catalog/{id}/summary: состав модуля
// из summary.json без скачивания архива.
func (a *API) handleCatalogSummary(w http.ResponseWriter, r *http.Request) {
	if !a.requireCatalog(w, r) {
		return
	}
	e, err := a.Catalog.Find(r.Context(), r.PathValue("id"))
	if err != nil {
		writeCatalogErr(w, err)
		return
	}
	s, err := a.Catalog.Summary(r.Context(), e)
	if err != nil {
		writeCatalogErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s)
}

type requiredInfo struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Version string `json:"version"`
	Size    int64  `json:"size"`
}

// handleCatalogInstall — POST /api/module-catalog/install {"id", "withRequires"}:
// скачать модуль из каталога и поставить. Недостающие зависимости без
// withRequires не ставятся: ответ 409 со списком, повтор с withRequires
// ставит их первыми.
func (a *API) handleCatalogInstall(w http.ResponseWriter, r *http.Request) {
	if !a.requireCatalog(w, r) {
		return
	}
	var req struct {
		ID           string `json:"id"`
		WithRequires bool   `json:"withRequires"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&req); err != nil || req.ID == "" {
		writeErr(w, http.StatusBadRequest, "нужен модуль id")
		return
	}
	plan, err := a.Catalog.Plan(r.Context(), req.ID, a.installedVersion)
	if err != nil {
		writeCatalogErr(w, err)
		return
	}
	if len(plan) > 1 && !req.WithRequires {
		need := make([]requiredInfo, 0, len(plan)-1)
		for _, e := range plan[:len(plan)-1] {
			need = append(need, requiredInfo{ID: e.ID, Title: e.Title, Version: e.Version, Size: e.Size})
		}
		writeJSON(w, http.StatusConflict, map[string]any{"error": "нужны другие модули", "requires": need})
		return
	}
	installed := make([]moduleInfo, 0, len(plan))
	for _, e := range plan {
		path, err := a.Catalog.Download(r.Context(), e)
		if err != nil {
			writeCatalogErr(w, err)
			return
		}
		mod, err := a.Companies.InstallModule(r.Context(), path)
		_ = os.Remove(path)
		if err != nil {
			writeModuleErr(w, err)
			return
		}
		installed = append(installed, toModuleInfo(mod))
	}
	writeJSON(w, http.StatusCreated, map[string]any{"installed": installed})
}

// handleCatalogInstallURL — POST /api/module-catalog/install-url {"url",
// "sha256"}: поставить модуль по ссылке на .btmod; sha256 необязателен.
func (a *API) handleCatalogInstallURL(w http.ResponseWriter, r *http.Request) {
	if !a.requireCatalog(w, r) {
		return
	}
	var req struct {
		URL    string `json:"url"`
		SHA256 string `json:"sha256"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&req); err != nil || req.URL == "" {
		writeErr(w, http.StatusBadRequest, "нужна ссылка url")
		return
	}
	path, _, err := a.Catalog.DownloadURL(r.Context(), req.URL, req.SHA256)
	if err != nil {
		writeCatalogErr(w, err)
		return
	}
	defer func() { _ = os.Remove(path) }()
	mod, err := a.Companies.InstallModule(r.Context(), path)
	if err != nil {
		writeModuleErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, toModuleInfo(mod))
}

// handleSourcesGet — GET /api/module-sources: каталог по умолчанию и
// добавленные адреса.
func (a *API) handleSourcesGet(w http.ResponseWriter, r *http.Request) {
	if !a.requireCatalog(w, r) {
		return
	}
	_, sources := a.Catalog.List(r.Context(), false)
	writeJSON(w, http.StatusOK, map[string]any{"sources": sources, "custom": a.Catalog.CustomSources()})
}

// handleSourcesSet — PUT /api/module-sources {"sources": [...]}: заменить
// добавленные адреса.
func (a *API) handleSourcesSet(w http.ResponseWriter, r *http.Request) {
	if !a.requireCatalog(w, r) {
		return
	}
	var req struct {
		Sources []string `json:"sources"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "нужен список sources")
		return
	}
	if err := a.Catalog.SetSources(req.Sources); err != nil {
		writeModuleErr(w, err)
		return
	}
	a.handleSourcesGet(w, r)
}

// handleSystemTheme — GET /system-theme.css: оформление системы запущенного
// мира; подключается <link> на каждой странице стола, поэтому без входа и
// без вспышки неоформленной страницы.
func (a *API) handleSystemTheme(w http.ResponseWriter, r *http.Request) {
	css := a.Companies.SystemThemeCSS()
	sum := sha256.Sum256([]byte(css))
	etag := `"` + hex.EncodeToString(sum[:8]) + `"`
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("ETag", etag)
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	_, _ = io.WriteString(w, css)
}

type neededModule struct {
	ID          string              `json:"id"`
	Title       string              `json:"title"`
	Type        string              `json:"type"`
	Description string              `json:"description,omitempty"`
	Version     string              `json:"version,omitempty"`
	Size        int64               `json:"size,omitempty"`
	Requires    []module.Dependency `json:"requires,omitempty"`
	InCatalog   bool                `json:"inCatalog"`
	Compatible  bool                `json:"compatible"`
}

// handleWorldRequirements — GET /api/companies/{id}/requirements: каких
// модулей мира нет на сервере (система — первой). Мир, созданный до модулей,
// списка не хранит; пока его система не установлена, ему же нужен и контент
// прежнего встроенного каталога (модули с legacyIds для его системы).
func (a *API) handleWorldRequirements(w http.ResponseWriter, r *http.Request) {
	if !a.requireCatalog(w, r) {
		return
	}
	company, err := a.Companies.World(r.Context(), r.PathValue("id"))
	if err != nil {
		writeModuleErr(w, err)
		return
	}
	entries, sources := a.Catalog.List(r.Context(), false)
	ids := slices.Clone(company.EnabledModules())
	if _, ok := a.installedVersion(company.System); company.Modules == nil && company.System != domain.SystemCustom && !ok {
		for _, e := range entries {
			if e.LegacyIDs && e.Type == module.TypeContent && slices.Contains(e.Systems, company.System) && !slices.Contains(ids, e.ID) {
				ids = append(ids, e.ID)
			}
		}
	}
	missing := []neededModule{}
	for _, id := range ids {
		if _, ok := a.installedVersion(id); ok {
			continue
		}
		n := neededModule{ID: id, Title: id, Type: module.TypeContent, Compatible: true}
		if id == company.System {
			n.Type = module.TypeSystem
		}
		for _, e := range entries {
			if e.ID == id {
				n = neededModule{ID: id, Title: e.Title, Type: e.Type, Description: e.Description, Version: e.Version, Size: e.Size, Requires: e.Requires, InCatalog: true, Compatible: a.Catalog.Compatible(e)}
				break
			}
		}
		missing = append(missing, n)
	}
	rank := func(n neededModule) int {
		if n.Type == module.TypeSystem {
			return 0
		}
		return 1
	}
	slices.SortStableFunc(missing, func(x, y neededModule) int { return rank(x) - rank(y) })
	var catalogErrors []string
	for _, s := range sources {
		if s.Error != "" {
			catalogErrors = append(catalogErrors, s.Error)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"world":         map[string]string{"id": company.ID, "name": company.Name, "system": company.System},
		"missing":       missing,
		"catalogErrors": catalogErrors,
	})
}
