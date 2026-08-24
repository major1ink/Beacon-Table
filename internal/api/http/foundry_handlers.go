package http

import (
	"encoding/json"
	"errors"
	"net/http"

	"beacon-table/internal/domain"
)

// импорт компендиумов из пакетов Foundry VTT (см.
// internal/service/foundry.go, internal/foundry)

func (a *API) handleFoundryInspect(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	var req struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	pkg, err := world.Foundry.Inspect(r.Context(), req.URL)
	if err != nil {
		writeFoundryErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, pkg)
}

func (a *API) handleFoundryImport(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAdminAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	var req struct {
		URL  string `json:"url"`
		Pack string `json:"pack"`
		// Targets — в какие разделы стола импортировать ("items", "spells",
		// "monsters", "references", "conditions", "scenes", "playlists",
		// "notes"); пусто — во все, куда документы этого пака подходят.
		Targets []string `json:"targets"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	result, err := world.Foundry.ImportPack(r.Context(), acc, req.URL, req.Pack, req.Targets)
	if err != nil {
		writeFoundryErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// handleFoundryModules — установленные пакеты Foundry VTT этого мира, для
// раздела "Настройки" (см. service.FoundryService.Installed)
func (a *API) handleFoundryModules(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	list, err := world.Foundry.Installed(r.Context())
	if err != nil {
		writeFoundryErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// handleFoundryModulesCheck — проверка новых версий всех установленных
// пакетов (см. service.FoundryService.CheckUpdates): по кнопке "Проверить
// обновления" в настройках
func (a *API) handleFoundryModulesCheck(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	list, err := world.Foundry.CheckUpdates(r.Context())
	if err != nil {
		writeFoundryErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// handleFoundryModuleDelete — "Удалить модуль" целиком: карточки, файлы и
// саму запись об установке (см. service.FoundryService.Delete — там же
// разбор, что именно сносится и почему сцены/плейлисты/заметки — нет).
func (a *API) handleFoundryModuleDelete(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAdminAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	result, err := world.Foundry.Delete(r.Context(), acc, r.PathValue("id"))
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "такой модуль не установлен")
			return
		}
		writeFoundryErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// writeFoundryErr — всё, что пошло не так со ссылкой/архивом/паком, сервис
// заворачивает в ValidationError с текстом для человека (см.
// service.FoundryService): чинить это ДМ, а не нам, и сообщение он должен
// увидеть целиком, а не "ошибка сервера".
func writeFoundryErr(w http.ResponseWriter, err error) {
	var verr *domain.ValidationError
	if errors.As(err, &verr) {
		writeErr(w, http.StatusBadRequest, verr.Msg)
		return
	}
	writeErr(w, http.StatusInternalServerError, "ошибка сервера")
}
