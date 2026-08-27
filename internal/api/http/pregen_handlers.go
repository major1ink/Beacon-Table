package http

import (
	"encoding/json"
	"errors"
	"net/http"

	"beacon-table/internal/domain"
)

// «Готовые персонажи» — пул предгенерированных листов мира (см. domain.Pregen,
// service.PregenService). Импорт приключения Foundry складывает сюда актёров
// type "character"; игрок берёт свободного (/api/pregens), ДМ управляет пулом
// (/api/admin/pregens).

// pregenSummaryJSON — короткая карточка пре-гена для списков (без полного
// листа): имя, аватар и сводка «класс N ур.» / вид.
func pregenSummaryJSON(p *domain.Pregen) map[string]any {
	return map[string]any{
		"id":        p.ID,
		"name":      p.Name,
		"avatarUrl": p.AvatarURL,
		"class":     p.Sheet.Info.Class,
		"level":     p.Sheet.Info.Level,
		"species":   pregenSpecies(p.Sheet),
	}
}

func pregenSpecies(s domain.CharacterSheet) string {
	if s.Info.Species != "" {
		return s.Info.Species
	}
	return s.Info.Race
}

// ---- игрок (свои, по сессии) ----

// handlePregensList — свободные пре-гены, которых игрок может взять.
func (a *API) handlePregensList(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	list, err := world.Pregens.Available(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	out := make([]map[string]any, 0, len(list))
	for _, p := range list {
		out = append(out, pregenSummaryJSON(p))
	}
	writeJSON(w, http.StatusOK, out)
}

// handlePregenGet — полный лист одного пре-гена для предпросмотра БЕЗ захвата
// (character-sheet.html?pregen=<id>, режим только чтения). Доступен любому
// залогиненному — это шаблон приключения, не приватные данные.
func (a *API) handlePregenGet(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	p, err := world.Pregens.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		writePregenErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":        p.ID,
		"name":      p.Name,
		"avatarUrl": p.AvatarURL,
		"sheet":     p.Sheet,
		"claimed":   !p.Free(),
	})
}

// handlePregenClaim — игрок берёт готового персонажа: создаётся обычная
// запись characters, принадлежащая ему.
func (a *API) handlePregenClaim(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	c, err := world.Pregens.Claim(r.Context(), r.PathValue("id"), acc.ID)
	if err != nil {
		writePregenErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, characterFullJSON(c))
}

// ---- ДМ ----

func (a *API) handleAdminPregensList(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	list, err := world.Pregens.List(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	usernames := map[string]string{}
	if accs, err := world.Admin.ListAccounts(r.Context()); err == nil {
		for _, acc := range accs {
			usernames[acc.ID] = acc.Username
		}
	}
	out := make([]map[string]any, 0, len(list))
	for _, p := range list {
		row := pregenSummaryJSON(p)
		// Полный лист — чтобы экран импорта Foundry мог сравнить «не
		// изменилась ли карточка» (см. foundry-import.js: sameCard) и не
		// показывать конфликт на повторном импорте без правок.
		row["sheet"] = p.Sheet
		row["claimedBy"] = p.ClaimedBy
		row["claimedByUsername"] = usernames[p.ClaimedBy]
		row["claimedCharacterId"] = p.ClaimedCharacterID
		out = append(out, row)
	}
	writeJSON(w, http.StatusOK, out)
}

// handleAdminPregenCreate — пустой пре-ген по имени (шаг 1 покарточного
// импорта, ср. handleMonsterCreate).
func (a *API) handleAdminPregenCreate(w http.ResponseWriter, r *http.Request) {
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
	p, err := world.Pregens.Import(r.Context(), req.Name)
	if err != nil {
		writePregenErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"id": p.ID, "name": p.Name})
}

// handleAdminPregenUpdate — полная перезапись пре-гена (шаг 2 импорта):
// имя/аватар/лист + метка модуля (foundryModuleId → Source).
func (a *API) handleAdminPregenUpdate(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	var req struct {
		Name            string                `json:"name"`
		AvatarURL       string                `json:"avatarUrl"`
		FoundryModuleID string                `json:"foundryModuleId"`
		Sheet           domain.CharacterSheet `json:"sheet"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	p, err := world.Pregens.Update(r.Context(), r.PathValue("id"), req.Name, req.AvatarURL, req.FoundryModuleID, req.Sheet)
	if err != nil {
		writePregenErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": p.ID, "name": p.Name, "avatarUrl": p.AvatarURL, "sheet": p.Sheet})
}

// handleAdminPregenAssign — ДМ назначает пре-гена аккаунту игрока (тот же
// Claim, что и у игрока, но с явным accountId).
func (a *API) handleAdminPregenAssign(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	var req struct {
		AccountID string `json:"accountId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
		writeErr(w, http.StatusBadRequest, "нужен accountId игрока")
		return
	}
	c, err := world.Pregens.Claim(r.Context(), r.PathValue("id"), req.AccountID)
	if err != nil {
		writePregenErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, characterFullJSON(c))
}

func (a *API) handleAdminPregenRelease(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	if err := world.Pregens.Release(r.Context(), r.PathValue("id")); err != nil {
		writePregenErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (a *API) handleAdminPregenDelete(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	if err := world.Pregens.Delete(r.Context(), r.PathValue("id")); err != nil {
		writePregenErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// writePregenErr — общий разбор ошибок пула: 404 — нет такого пре-гена,
// 409 — уже занят другим игроком, 400 — валидация имени.
func writePregenErr(w http.ResponseWriter, err error) {
	var verr *domain.ValidationError
	switch {
	case errors.As(err, &verr):
		writeErr(w, http.StatusBadRequest, verr.Msg)
	case errors.Is(err, domain.ErrNotFound):
		writeErr(w, http.StatusNotFound, "готовый персонаж не найден")
	case errors.Is(err, domain.ErrForbidden):
		writeErr(w, http.StatusConflict, "этого персонажа уже взял другой игрок")
	default:
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
	}
}
