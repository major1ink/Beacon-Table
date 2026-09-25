package http

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"

	"beacon-table/internal/domain"
	"beacon-table/internal/module"
)

// Модули контента (см. internal/module): установка и удаление — на весь
// сервер, поэтому только владелец; включение в мире — тоже владелец, как и
// всё управление мирами (см. company_handlers.go).

// maxModuleSize — предел на архив модуля. Модуль с картинками больше
// карточек, но меньше мира с картами и музыкой.
const maxModuleSize = 1 << 30

type moduleInfo struct {
	ID            string              `json:"id"`
	Type          string              `json:"type"`
	Title         string              `json:"title"`
	Version       string              `json:"version"`
	MinAppVersion string              `json:"minAppVersion,omitempty"`
	Systems       []string            `json:"systems,omitempty"`
	Requires      []module.Dependency `json:"requires,omitempty"`
	Description   string              `json:"description,omitempty"`
	Author        string              `json:"author,omitempty"`
	License       string              `json:"license,omitempty"`
	Source        string              `json:"source"`
	Counts        map[string]int      `json:"counts"`
}

func toModuleInfo(m *module.Module) moduleInfo {
	man := m.Manifest
	return moduleInfo{
		ID: man.ID, Type: man.Type, Title: man.Title, Version: man.Version,
		MinAppVersion: man.MinAppVersion, Systems: man.Systems, Requires: man.Requires,
		Description: man.Description, Author: man.Author, License: man.License,
		Source: m.Source, Counts: m.Counts(),
	}
}

// handleModulesList — GET /api/modules: модули на сервере и то, что
// подключено к запущенному миру (включая ненайденные).
func (a *API) handleModulesList(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireOwner(w, r); !ok {
		return
	}
	mods, err := a.Companies.Modules().List()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	out := map[string]any{"modules": []moduleInfo{}}
	list := make([]moduleInfo, 0, len(mods))
	for _, m := range mods {
		list = append(list, toModuleInfo(m))
	}
	out["modules"] = list
	if cur := a.Companies.Current(); cur != nil {
		enabled := make([]string, 0, len(cur.Modules))
		for _, m := range cur.Modules {
			enabled = append(enabled, m.Manifest.ID)
		}
		missing := cur.MissingModules
		if missing == nil {
			missing = []string{}
		}
		out["world"] = map[string]any{"id": cur.Company.ID, "enabled": enabled, "missing": missing}
	}
	writeJSON(w, http.StatusOK, out)
}

// handleModuleInstall — POST /api/modules (multipart, поле "file", архив
// .btmod): установить или обновить модуль.
func (a *API) handleModuleInstall(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireOwner(w, r); !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxModuleSize)
	//nolint:gosec // G120: тело уже ограничено MaxBytesReader выше
	if err := r.ParseMultipartForm(multipartMemoryBudget); err != nil {
		writeErr(w, http.StatusBadRequest, "файл слишком большой")
		return
	}
	file, _, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "нет файла")
		return
	}
	defer file.Close()
	tmp, err := os.CreateTemp("", "beacon-module-*.btmod")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	_, copyErr := io.Copy(tmp, file)
	closeErr := tmp.Close()
	if copyErr != nil || closeErr != nil {
		writeErr(w, http.StatusBadRequest, "не удалось прочитать файл")
		return
	}
	mod, err := a.Companies.InstallModule(r.Context(), tmp.Name())
	if err != nil {
		writeModuleErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, toModuleInfo(mod))
}

// handleModuleDelete — DELETE /api/modules/{id}.
func (a *API) handleModuleDelete(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireOwner(w, r); !ok {
		return
	}
	if err := a.Companies.RemoveModule(r.Context(), r.PathValue("id")); err != nil {
		writeModuleErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleWorldModulesGet — GET /api/companies/{id}/modules.
func (a *API) handleWorldModulesGet(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireOwner(w, r); !ok {
		return
	}
	ids, err := a.Companies.WorldModules(r.Context(), r.PathValue("id"))
	if err != nil {
		writeModuleErr(w, err)
		return
	}
	if ids == nil {
		ids = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"modules": ids})
}

// handleWorldModulesSet — PUT /api/companies/{id}/modules {"modules": [...]}:
// какие модули подключены к миру, в порядке подключения. Запущенный мир
// перезапускается — стол переподключится сам.
func (a *API) handleWorldModulesSet(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireOwner(w, r); !ok {
		return
	}
	var req struct {
		Modules []string `json:"modules"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&req); err != nil || req.Modules == nil {
		writeErr(w, http.StatusBadRequest, "нужен список modules")
		return
	}
	if err := a.Companies.SetWorldModules(r.Context(), r.PathValue("id"), req.Modules); err != nil {
		writeModuleErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"modules": req.Modules})
}

func writeModuleErr(w http.ResponseWriter, err error) {
	var verr *domain.ValidationError
	switch {
	case errors.As(err, &verr):
		writeErr(w, http.StatusBadRequest, verr.Msg)
	case errors.Is(err, domain.ErrNotFound):
		writeErr(w, http.StatusNotFound, "не найдено")
	default:
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
	}
}
