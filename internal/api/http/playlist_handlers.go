package http

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"beacon-table/internal/domain"
)

// ---- ДМ: плейлисты канала ДМ ----

func trackJSON(t *domain.PlaylistTrack) map[string]any {
	return map[string]any{
		"id": t.ID, "url": t.URL, "name": t.Name, "volume": t.Volume, "loop": t.Loop, "position": t.Position,
	}
}

func (a *API) handleAdminPlaylistsList(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	playlists, err := world.Playlists.List(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	out := make([]map[string]any, 0, len(playlists))
	for _, p := range playlists {
		trackList := make([]map[string]any, 0, len(p.Tracks))
		for _, t := range p.Tracks {
			trackList = append(trackList, trackJSON(t))
		}
		out = append(out, map[string]any{
			"id": p.ID, "name": p.Name, "createdAt": p.CreatedAt.Format(time.RFC3339), "tracks": trackList,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *API) handleAdminPlaylistCreate(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	var req struct{ Name string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	p, err := world.Playlists.Create(r.Context(), req.Name)
	if err != nil {
		var verr *domain.ValidationError
		if errors.As(err, &verr) {
			writeErr(w, http.StatusBadRequest, verr.Msg)
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": p.ID, "name": p.Name, "tracks": []any{}})
}

func (a *API) handleAdminPlaylistRename(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	var req struct{ Name string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	if err := world.Playlists.Rename(r.Context(), r.PathValue("id"), req.Name); err != nil {
		var verr *domain.ValidationError
		switch {
		case errors.As(err, &verr):
			writeErr(w, http.StatusBadRequest, verr.Msg)
		case errors.Is(err, domain.ErrNotFound):
			writeErr(w, http.StatusNotFound, "плейлист не найден")
		default:
			writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (a *API) handleAdminPlaylistDelete(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	if err := world.Playlists.Delete(r.Context(), r.PathValue("id")); err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// trackRequest — тело запроса на добавление/правку трека плейлиста.
// Volume/Loop — не указатели: пустое значение (0/false) — валидный ввод, а
// не "поле пропущено" (в отличие от аккаунтов тут нет отдельного PATCH).
type trackRequest struct {
	URL    string
	Name   string
	Volume float64
	Loop   bool
}

func (a *API) handleAdminPlaylistTrackAdd(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	var req trackRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	t, err := world.Playlists.AddTrack(r.Context(), r.PathValue("id"), req.URL, req.Name, req.Volume, req.Loop)
	if err != nil {
		var verr *domain.ValidationError
		if errors.As(err, &verr) {
			writeErr(w, http.StatusBadRequest, verr.Msg)
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": t.ID, "url": t.URL, "name": t.Name, "volume": t.Volume, "loop": t.Loop})
}

func (a *API) handleAdminPlaylistTrackUpdate(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	var req trackRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	if err := world.Playlists.UpdateTrack(r.Context(), r.PathValue("id"), r.PathValue("trackId"), req.Name, req.Volume, req.Loop); err != nil {
		var verr *domain.ValidationError
		switch {
		case errors.As(err, &verr):
			writeErr(w, http.StatusBadRequest, verr.Msg)
		case errors.Is(err, domain.ErrNotFound):
			writeErr(w, http.StatusNotFound, "трек не найден")
		default:
			writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (a *API) handleAdminPlaylistTrackDelete(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	if err := world.Playlists.DeleteTrack(r.Context(), r.PathValue("id"), r.PathValue("trackId")); err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "трек не найден")
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleAdminPlaylistTrackMove — простые кнопки ↑/↓ вместо drag-and-drop.
// body: {"direction":"up"|"down"}.
func (a *API) handleAdminPlaylistTrackMove(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	var req struct{ Direction string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	if err := world.Playlists.MoveTrack(r.Context(), r.PathValue("id"), r.PathValue("trackId"), req.Direction); err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
