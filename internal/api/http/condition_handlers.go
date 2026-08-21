package http

import (
	"encoding/json"
	"errors"
	"net/http"

	"beacon-table/internal/domain"
)

// ---- библиотека состояний (ослепление/испуг/истощение и самодельные метки
// ДМ — см. domain.Condition, internal/service/conditions.go,
// internal/repository/conditionfile) — та же схема доступа, что у
// reference_handlers.go/item_handlers.go: доступна ЛЮБОМУ залогиненному
// аккаунту, а не только ДМ (игроку нужно прочитать описание того, что на
// нём висит). Само НАЛОЖЕНИЕ метки на токен/бойца сюда не относится — это
// WS-команды "apply_status"/"remove_status" и они только для ДМ (см.
// service.Room.authorize). ----

func (a *API) handleConditionsList(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	conds, err := world.Conditions.List(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, conds)
}

func (a *API) handleConditionCreate(w http.ResponseWriter, r *http.Request) {
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
	cond, err := world.Conditions.Create(r.Context(), req.Name)
	if err != nil {
		var verr *domain.ValidationError
		if errors.As(err, &verr) {
			writeErr(w, http.StatusBadRequest, verr.Msg)
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusCreated, cond)
}

func (a *API) handleConditionGet(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	cond, err := world.Conditions.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "состояние не найдено")
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, cond)
}

func (a *API) handleConditionUpdate(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	var cond domain.Condition
	if err := json.NewDecoder(r.Body).Decode(&cond); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	updated, err := world.Conditions.Update(r.Context(), r.PathValue("id"), cond)
	if err != nil {
		var verr *domain.ValidationError
		switch {
		case errors.As(err, &verr):
			writeErr(w, http.StatusBadRequest, verr.Msg)
		case errors.Is(err, domain.ErrNotFound):
			writeErr(w, http.StatusNotFound, "состояние не найдено")
		case errors.Is(err, domain.ErrForbidden):
			writeErr(w, http.StatusForbidden, "карточка каталога «из коробки» доступна только для чтения — клонируй её в библиотеку")
		default:
			writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		}
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

func (a *API) handleConditionDelete(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	if err := world.Conditions.Delete(r.Context(), r.PathValue("id")); err != nil {
		if errors.Is(err, domain.ErrForbidden) {
			writeErr(w, http.StatusForbidden, "карточка каталога «из коробки» доступна только для чтения")
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
