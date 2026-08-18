package http

import (
	"encoding/json"
	"errors"
	"net/http"

	"beacon-table/internal/domain"
)

// ---- библиотека предметов, общая на весь стол (см. internal/service/items.go,
// internal/repository/itemfile) — в отличие от бестиария (monster_handlers.go,
// requireAdminAccount) доступна ЛЮБОМУ залогиненному аккаунту: и ДМ, и игроки
// создают/импортируют/правят карточки в одной общей библиотеке (та же схема,
// что и spell_handlers.go). ----

func (a *API) handleItemsList(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	items, err := world.Items.List(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (a *API) handleItemCreate(w http.ResponseWriter, r *http.Request) {
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
	it, err := world.Items.Create(r.Context(), req.Name)
	if err != nil {
		var verr *domain.ValidationError
		if errors.As(err, &verr) {
			writeErr(w, http.StatusBadRequest, verr.Msg)
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusCreated, it)
}

func (a *API) handleItemGet(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	it, err := world.Items.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "предмет не найден")
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, it)
}

func (a *API) handleItemUpdate(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	var it domain.Item
	if err := json.NewDecoder(r.Body).Decode(&it); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	updated, err := world.Items.Update(r.Context(), r.PathValue("id"), it)
	if err != nil {
		var verr *domain.ValidationError
		switch {
		case errors.As(err, &verr):
			writeErr(w, http.StatusBadRequest, verr.Msg)
		case errors.Is(err, domain.ErrNotFound):
			writeErr(w, http.StatusNotFound, "предмет не найден")
		case errors.Is(err, domain.ErrForbidden):
			writeErr(w, http.StatusForbidden, "карточка каталога «из коробки» доступна только для чтения — клонируй её в библиотеку")
		default:
			writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		}
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

func (a *API) handleItemDelete(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	if err := world.Items.Delete(r.Context(), r.PathValue("id")); err != nil {
		if errors.Is(err, domain.ErrForbidden) {
			writeErr(w, http.StatusForbidden, "карточка каталога «из коробки» доступна только для чтения")
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
