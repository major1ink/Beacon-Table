package http

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"beacon-table/internal/domain"
)

// ---- ДМ: управление аккаунтами (только текущего запущенного мира, см.
// internal/service/admin.go: adminService.companyID) ----

func (a *API) handleAdminAccountsList(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	accs, err := world.Admin.ListAccounts(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	out := make([]map[string]any, 0, len(accs))
	for _, acc := range accs {
		out = append(out, map[string]any{
			"id": acc.ID, "username": acc.Username, "role": acc.Role, "status": acc.Status,
			"createdAt": acc.CreatedAt.Format(time.RFC3339),
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// handleAdminAccountCreate — ДМ заводит аккаунт напрямую: сразу "active",
// без ожидания подтверждения (в отличие от саморегистрации). Привязывается
// к тому миру, в котором сейчас находится ДМ (см. adminService.companyID).
func (a *API) handleAdminAccountCreate(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	var req struct{ Username, Password, Role string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	acc, err := world.Admin.CreateAccount(r.Context(), req.Username, req.Password, req.Role)
	if err != nil {
		var verr *domain.ValidationError
		switch {
		case errors.As(err, &verr):
			writeErr(w, http.StatusBadRequest, verr.Msg)
		case errors.Is(err, domain.ErrConflict):
			writeErr(w, http.StatusConflict, "это имя уже занято")
		default:
			writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		}
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"id": acc.ID, "username": acc.Username, "role": acc.Role, "status": acc.Status})
}

func (a *API) handleAdminAccountApprove(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	if err := world.Admin.ApproveAccount(r.Context(), r.PathValue("id")); err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (a *API) handleAdminAccountDelete(w http.ResponseWriter, r *http.Request) {
	admin, ok := a.requireAdminAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if err := world.Admin.DeleteAccount(r.Context(), admin.ID, id); err != nil {
		if errors.Is(err, domain.ErrForbidden) {
			writeErr(w, http.StatusBadRequest, "нельзя удалить свой собственный аккаунт")
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleAdminAccountPassword — ДМ сбрасывает пароль кому угодно, не зная
// старого (в отличие от handleChangeOwnPassword). Тоже сносит все сессии
// аккаунта.
func (a *API) handleAdminAccountPassword(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	id := r.PathValue("id")
	var req struct{ Password string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	if err := world.Admin.ResetPassword(r.Context(), id, req.Password); err != nil {
		var verr *domain.ValidationError
		if errors.As(err, &verr) {
			writeErr(w, http.StatusBadRequest, verr.Msg)
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleAdminCharactersList — все персонажи всех игроков разом, с именем
// аккаунта-владельца, для панели "Персонажи" в dm.html — оттуда ДМ
// перетаскивает персонажа на карту (создаёт токен с уже проставленными
// OwnerID/CharacterID/Label/Image, см. web/src/pages/dm.js), а не
// назначает владельца задним числом через контекстное меню токена.
func (a *API) handleAdminCharactersList(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	chars, err := world.Admin.ListAllCharacters(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	out := make([]map[string]any, 0, len(chars))
	for _, cw := range chars {
		out = append(out, map[string]any{
			"id": cw.Character.ID, "accountId": cw.Character.AccountID, "accountUsername": cw.OwnerUsername,
			"name": cw.Character.Name, "avatarUrl": cw.Character.AvatarURL,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// handleAdminCharacterGet — персонаж ЛЮБОГО игрока целиком (с листом), для
// просмотра/редактирования в dm.html (character-sheet.html?id=... — фронт
// сам решает по своей роли, какой из двух эндпоинтов дёрнуть на чтение и на
// сохранение, см. web/src/pages/character-sheet.js: isAdminView).
func (a *API) handleAdminCharacterGet(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	cw, err := world.Admin.GetCharacter(r.Context(), r.PathValue("id"))
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "персонаж не найден")
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id": cw.Character.ID, "accountUsername": cw.OwnerUsername,
		"name": cw.Character.Name, "avatarUrl": cw.Character.AvatarURL, "system": cw.Character.System,
		"sheet": cw.Character.Sheet,
	})
}

// handleAdminCharacterUpdate — ДМ правит имя/аватар ЛЮБОГО персонажа
// (панель "Персонажи" в dm.html, кнопка ✎), не только своего — в отличие от
// handleCharacterUpdate, привязанного к accountID сессии.
func (a *API) handleAdminCharacterUpdate(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
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
	if err := world.Admin.UpdateCharacter(r.Context(), id, req.Name, req.AvatarURL); err != nil {
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

// handleAdminCharacterSheetUpdate — ДМ сохраняет лист ЛЮБОГО персонажа
// (character-sheet.html в режиме ДМ — там же полноценно редактирует, не
// только смотрит, см. web/src/pages/character-sheet.js).
func (a *API) handleAdminCharacterSheetUpdate(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
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
	if err := world.Admin.UpdateCharacterSheet(r.Context(), r.PathValue("id"), sheet); err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "персонаж не найден")
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
