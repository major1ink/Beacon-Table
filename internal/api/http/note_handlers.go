package http

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"beacon-table/internal/domain"
)

// ---- ДМ: заметки (см. internal/service/notes.go, internal/repository/notefile) ----

func noteJSON(n *domain.Note) map[string]any {
	return map[string]any{
		"id": n.ID, "title": n.Title, "folder": n.Folder, "content": n.Content, "updatedAt": n.UpdatedAt.Format(time.RFC3339),
	}
}

func noteListJSON(n *domain.Note) map[string]any {
	return map[string]any{"id": n.ID, "title": n.Title, "folder": n.Folder, "updatedAt": n.UpdatedAt.Format(time.RFC3339)}
}

func (a *API) handleNotesList(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	notes, err := world.Notes.List(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	out := make([]map[string]any, 0, len(notes))
	for _, n := range notes {
		out = append(out, noteListJSON(n))
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *API) handleNoteCreate(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	var req struct{ Content, Folder string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	n, err := world.Notes.Create(r.Context(), req.Folder, req.Content)
	if err != nil {
		var verr *domain.ValidationError
		if errors.As(err, &verr) {
			writeErr(w, http.StatusBadRequest, verr.Msg)
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusCreated, noteJSON(n))
}

func (a *API) handleNoteGet(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	n, err := world.Notes.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "заметка не найдена")
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, noteJSON(n))
}

func (a *API) handleNoteUpdate(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	var req struct{ Content string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	n, err := world.Notes.Update(r.Context(), r.PathValue("id"), req.Content)
	if err != nil {
		var verr *domain.ValidationError
		switch {
		case errors.As(err, &verr):
			writeErr(w, http.StatusBadRequest, verr.Msg)
		case errors.Is(err, domain.ErrNotFound):
			writeErr(w, http.StatusNotFound, "заметка не найдена")
		default:
			writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		}
		return
	}
	writeJSON(w, http.StatusOK, noteJSON(n))
}

// handleNoteMove — перенос заметки в другую папку. Отдельный эндпоинт, а не
// поле в PUT /api/notes/{id}: содержимое заметки автосейвится по таймеру во
// время набора текста (см. web/src/pages/dm.js), и класть в тот же запрос
// ещё и папку значило бы гонять её туда-сюда на каждое нажатие клавиши.
func (a *API) handleNoteMove(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	var req struct{ Folder string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	n, err := world.Notes.Move(r.Context(), r.PathValue("id"), req.Folder)
	if err != nil {
		var verr *domain.ValidationError
		switch {
		case errors.As(err, &verr):
			writeErr(w, http.StatusBadRequest, verr.Msg)
		case errors.Is(err, domain.ErrNotFound):
			writeErr(w, http.StatusNotFound, "заметка не найдена")
		default:
			writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		}
		return
	}
	writeJSON(w, http.StatusOK, noteJSON(n))
}

// ---- папки библиотеки заметок (domain.Note.Folder) ----

func (a *API) handleNoteFoldersList(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	folders, err := world.Notes.Folders(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, folders)
}

func (a *API) handleNoteFolderCreate(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	var req struct{ Folder string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	if err := world.Notes.CreateFolder(r.Context(), req.Folder); err != nil {
		writeNoteFolderErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"status": "ok"})
}

// handleNoteFolderRename — переименование/перенос папки вместе с
// содержимым.
func (a *API) handleNoteFolderRename(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	var req struct{ From, To string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	if err := world.Notes.RenameFolder(r.Context(), req.From, req.To); err != nil {
		writeNoteFolderErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleNoteFolderDelete — удаляет папку СО ВСЕМИ заметками внутри (см.
// NoteService.DeleteFolder). Путь папки в query, как у /api/asset-folders.
func (a *API) handleNoteFolderDelete(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	if err := world.Notes.DeleteFolder(r.Context(), r.URL.Query().Get("folder")); err != nil {
		writeNoteFolderErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func writeNoteFolderErr(w http.ResponseWriter, err error) {
	var verr *domain.ValidationError
	if errors.As(err, &verr) {
		writeErr(w, http.StatusBadRequest, verr.Msg)
		return
	}
	writeErr(w, http.StatusInternalServerError, "ошибка сервера")
}

func (a *API) handleNoteDelete(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	if err := world.Notes.Delete(r.Context(), r.PathValue("id")); err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
