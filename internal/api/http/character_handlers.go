package http

import (
	"encoding/json"
	"errors"
	"net/http"

	"beacon-table/internal/domain"
)

// ---- персонажи (свои, по сессии) ----

func (a *API) handleCharactersList(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	chars, err := world.Characters.List(r.Context(), acc.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, characterListJSON(chars))
}

// characterFullJSON — персонаж со структурированным листом (в отличие от
// characterListJSON в auth_handlers.go, которая отдаёт только имя/аватар —
// это используется в списке "Мои персонажи" и на /api/me, там полный лист
// не нужен и лишь раздувает payload).
func characterFullJSON(c *domain.Character) map[string]any {
	return map[string]any{
		"id":        c.ID,
		"name":      c.Name,
		"avatarUrl": c.AvatarURL,
		"system":    c.System,
		"sheet":     c.Sheet,
	}
}

// handleCharacterGet — свой персонаж целиком (с листом) для
// character-sheet.html в режиме владельца.
func (a *API) handleCharacterGet(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	c, err := world.Characters.Get(r.Context(), r.PathValue("id"), acc.ID)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "персонаж не найден")
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, characterFullJSON(c))
}

// handleCharacterSheetUpdate — сохраняет лист персонажа (см.
// domain.CharacterSheet — общий формат на обе системы, D&D 2014/2024), не
// трогая имя/аватар (те правит handleCharacterUpdate).
func (a *API) handleCharacterSheetUpdate(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	var sheet domain.CharacterSheet
	if err := json.NewDecoder(r.Body).Decode(&sheet); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	id := r.PathValue("id")
	if err := world.Characters.UpdateSheet(r.Context(), id, acc.ID, sheet); err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "персонаж не найден")
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	// Хиты в листе могли поменяться — трекер инициативы держит их копию у
	// бойца, и без этого числа разъезжались бы до конца боя (см.
	// service.Room.applyCharacterSheetHP).
	world.Room.NotifyCharacterSheetChanged(id)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (a *API) handleCharacterCreate(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	var req struct{ Name, AvatarURL string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	c, err := world.Characters.Create(r.Context(), acc.ID, req.Name, req.AvatarURL)
	if err != nil {
		var verr *domain.ValidationError
		if errors.As(err, &verr) {
			writeErr(w, http.StatusBadRequest, verr.Msg)
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"id": c.ID, "name": c.Name, "avatarUrl": c.AvatarURL, "system": c.System})
}

func (a *API) handleCharacterUpdate(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	id := r.PathValue("id")
	var req struct{ Name, AvatarURL string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	if err := world.Characters.Update(r.Context(), id, acc.ID, req.Name, req.AvatarURL); err != nil {
		var verr *domain.ValidationError
		switch {
		case errors.As(err, &verr):
			writeErr(w, http.StatusBadRequest, verr.Msg)
		case errors.Is(err, domain.ErrNotFound):
			writeErr(w, http.StatusNotFound, "персонаж не найден")
		default:
			writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (a *API) handleCharacterDelete(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if err := world.Characters.Delete(r.Context(), id, acc.ID); err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "персонаж не найден")
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
