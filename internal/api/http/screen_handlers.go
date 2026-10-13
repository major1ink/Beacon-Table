package http

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"beacon-table/internal/domain"
)

func writeScreenErr(w http.ResponseWriter, err error) {
	var verr *domain.ValidationError
	switch {
	case errors.As(err, &verr):
		writeErr(w, http.StatusBadRequest, verr.Msg)
	case errors.Is(err, domain.ErrForbidden):
		writeErr(w, http.StatusForbidden, "ширму меняет только ведущий")
	default:
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
	}
}

func (a *API) handleScreenGet(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	sc, err := world.Screen.Get(r.Context(), journalViewer(acc))
	if err != nil {
		writeScreenErr(w, err)
		return
	}
	sc.ServerNow = time.Now().UnixMilli()
	writeJSON(w, http.StatusOK, sc)
}

func (a *API) handleScreenSave(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	var req domain.Screen
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	sc, err := world.Screen.Save(r.Context(), journalViewer(acc), req)
	if err != nil {
		writeScreenErr(w, err)
		return
	}
	world.Room.NotifyLibraryChanged("screen")
	world.Room.SetScreenTimers(sc.PublicTimers())
	sc.ServerNow = time.Now().UnixMilli()
	writeJSON(w, http.StatusOK, sc)
}
