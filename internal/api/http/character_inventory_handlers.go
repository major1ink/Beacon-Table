package http

import (
	"encoding/json"
	"errors"
	"net/http"

	"beacon-table/internal/domain"
)

// ---- инвентарь персонажа (свой, по сессии) — см. domain.InventoryEntry,
// repository.CharacterRepository. Своя sub-collection, не часть
// /api/characters/{id}/sheet (см. character_handlers.go) — точечные мутации,
// а не whole-blob overwrite, ровно как у /api/admin/playlists/{id}/tracks. ----

func (a *API) handleCharacterInventoryList(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	entries, err := world.Characters.ListInventory(r.Context(), r.PathValue("id"), acc.ID)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "персонаж не найден")
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, entries)
}


func (a *API) handleCharacterInventoryUpdate(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	var req struct {
		Quantity int    `json:"quantity"`
		Equipped bool   `json:"equipped"`
		Notes    string `json:"notes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	err := world.Characters.UpdateInventoryItem(r.Context(), r.PathValue("id"), acc.ID, r.PathValue("entryId"), req.Quantity, req.Equipped, req.Notes)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "запись инвентаря не найдена")
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (a *API) handleCharacterInventoryDelete(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	if err := world.Characters.RemoveInventoryItem(r.Context(), r.PathValue("id"), acc.ID, r.PathValue("entryId")); err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "запись инвентаря не найдена")
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
