package http

import (
	"encoding/json"
	"errors"
	"net/http"

	"beacon-table/internal/domain"
)

// ---- библиотека справочника (классы/архетипы/происхождения/виды/черты —
// см. domain.Reference.Kind), общая на весь стол (см.
// internal/service/references.go, internal/repository/referencefile) — та
// же схема доступа, что у item_handlers.go/spell_handlers.go: доступна
// ЛЮБОМУ залогиненному аккаунту, а не только ДМ. ----

func (a *API) handleReferencesList(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	refs, err := world.References.List(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, refs)
}

func (a *API) handleReferenceCreate(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAccount(w, r); !ok {
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
	ref, err := world.References.Create(r.Context(), req.Name)
	if err != nil {
		var verr *domain.ValidationError
		if errors.As(err, &verr) {
			writeErr(w, http.StatusBadRequest, verr.Msg)
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusCreated, ref)
}

func (a *API) handleReferenceGet(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	ref, err := world.References.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "запись справочника не найдена")
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, ref)
}

func (a *API) handleReferenceUpdate(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	var ref domain.Reference
	if err := json.NewDecoder(r.Body).Decode(&ref); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	updated, err := world.References.Update(r.Context(), r.PathValue("id"), ref)
	if err != nil {
		var verr *domain.ValidationError
		switch {
		case errors.As(err, &verr):
			writeErr(w, http.StatusBadRequest, verr.Msg)
		case errors.Is(err, domain.ErrNotFound):
			writeErr(w, http.StatusNotFound, "запись справочника не найдена")
		case errors.Is(err, domain.ErrForbidden):
			writeErr(w, http.StatusForbidden, "карточка каталога «из коробки» доступна только для чтения — клонируй её в библиотеку")
		default:
			writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		}
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

func (a *API) handleReferenceDelete(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	if err := world.References.Delete(r.Context(), r.PathValue("id")); err != nil {
		if errors.Is(err, domain.ErrForbidden) {
			writeErr(w, http.StatusForbidden, "карточка каталога «из коробки» доступна только для чтения")
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
