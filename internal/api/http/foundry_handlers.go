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
