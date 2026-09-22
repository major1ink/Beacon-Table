package http

import (
	"encoding/json"
	"errors"
	"net/http"

	"beacon-table/internal/domain"
)

// handleTutorialGet — GET /api/tutorial (только ДМ): {"state":
// ""|"on"|"done"|"off"} (см. domain.Tutorial*).
// Пусто — ведущего ещё не спрашивали, и экран миров задаст вопрос сам
// (см. web/src/pages/worlds.js).
func (a *API) handleTutorialGet(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireOwner(w, r); !ok {
		return
	}
	if a.Tutorial == nil {
		writeErr(w, http.StatusServiceUnavailable, "режим обучения недоступен")
		return
	}
	state, err := a.Tutorial.State(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"state": state})
}

// handleTutorialSet — PUT /api/tutorial (только ДМ): {"state":
// "on"|"done"|"off"}.
func (a *API) handleTutorialSet(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireOwner(w, r); !ok {
		return
	}
	if a.Tutorial == nil {
		writeErr(w, http.StatusServiceUnavailable, "режим обучения недоступен")
		return
	}
	var req struct {
		State string `json:"state"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	if err := a.Tutorial.SetState(r.Context(), req.State); err != nil {
		if errors.Is(err, domain.ErrValidation) {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"state": req.State})
}
