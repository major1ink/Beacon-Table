package http

import (
	"errors"
	"net/http"

	"beacon-table/internal/domain"
)

// ---- лента сессии (см. service.SessionLogService) ----
//
// Читают и игроки — каждый свою версию ленты. Начать/закончить и заметки
// идут через комнату (WS "session_*"), отсюда — только чтение и итог.

func writeSessionErr(w http.ResponseWriter, err error) {
	var verr *domain.ValidationError
	switch {
	case errors.As(err, &verr):
		writeErr(w, http.StatusBadRequest, verr.Msg)
	case errors.Is(err, domain.ErrNotFound):
		writeErr(w, http.StatusNotFound, "сессия не найдена")
	default:
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
	}
}

func (a *API) handleSessionList(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	list, err := world.Sessions.List(r.Context())
	if err != nil {
		writeSessionErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (a *API) handleSessionEvents(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	isDM, playerID := acc.IsGM(), acc.ID
	// ДМ смотрит ленту глазами игрока (?as=<аккаунт>), как граф журнала.
	if as := r.URL.Query().Get("as"); as != "" && isDM {
		isDM, playerID = false, as
	}
	evs, err := world.Sessions.Events(r.Context(), r.PathValue("id"), isDM, playerID)
	if err != nil {
		writeSessionErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, evs)
}

func (a *API) handleSessionSummary(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	id, err := world.Sessions.Summary(r.Context(), r.PathValue("id"))
	if err != nil {
		writeSessionErr(w, err)
		return
	}
	notifyJournal(world, id)
	writeJSON(w, http.StatusCreated, map[string]string{"id": id})
}
