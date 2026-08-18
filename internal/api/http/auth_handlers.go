package http

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"beacon-table/internal/domain"
)

func characterListJSON(chars []*domain.Character) []map[string]string {
	out := make([]map[string]string, 0, len(chars))
	for _, c := range chars {
		out = append(out, map[string]string{"id": c.ID, "name": c.Name, "avatarUrl": c.AvatarURL})
	}
	return out
}

// myCharacters — персонажи acc в ТЕКУЩЕМ запущенном мире; пустой список
// (не ошибка), если сейчас ничего не запущено или acc принадлежит другому
// миру — в обоих случаях у аккаунта сейчас просто нет доступного стола (см.
// meResponseJSON: тому же ответу — worldActive=false — фронт покажет
// сообщение вместо списка персонажей).
func (a *API) myCharacters(ctx context.Context, acc *domain.Account) ([]*domain.Character, error) {
	world := a.Companies.Current()
	if world == nil || (!acc.IsAdmin() && acc.CompanyID != world.Company.ID) {
		return nil, nil
	}
	return world.Characters.List(ctx, acc.ID)
}

// meResponseJSON — для admin ничего сверх обычных полей не добавляет: ДМ
// всегда идёт на экран выбора мира (worlds.html), ему не нужно знать про
// конкретный "свой" мир. Для игрока добавляет worldActive (виден ли ему
// сейчас стол) и, если мир запущен, его систему — фронт (index.js,
// character-sheet.js) не должен сам лазить в /api/companies, чтобы это
// узнать.
func (a *API) meResponseJSON(acc *domain.Account, chars []*domain.Character) map[string]any {
	resp := map[string]any{
		"id":                 acc.ID,
		"username":           acc.Username,
		"role":               acc.Role,
		"mustChangePassword": acc.MustChangePassword,
		"characters":         characterListJSON(chars),
	}
	if acc.IsAdmin() {
		return resp
	}
	world := a.Companies.Current()
	active := world != nil && acc.CompanyID == world.Company.ID
	resp["worldActive"] = active
	switch {
	case active:
		resp["system"] = world.Company.System
		resp["worldName"] = world.Company.Name
	case world != nil:
		// Сервер сейчас ведёт ДРУГОЙ мир (не тот, что у этого игрока) —
		// говорим об этом прямо, а не голым "не запущен".
		resp["activeWorldName"] = world.Company.Name
	}
	return resp
}

func (a *API) handleRegister(w http.ResponseWriter, r *http.Request) {
	var req struct{ Username, Password string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	// Саморегистрация привязывает игрока к тому миру, что сейчас запущен —
	// без запущенного мира регистрировать некуда (см. AuthService.Register).
	companyID := a.Companies.ActiveCompanyID()
	if companyID == "" {
		writeErr(w, http.StatusServiceUnavailable, "мир сейчас не запущен, регистрация недоступна")
		return
	}
	if err := a.Auth.Register(r.Context(), companyID, req.Username, req.Password); err != nil {
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
	// Открытая форма, но аккаунт неактивен, пока ДМ не одобрит его в панели
	// управления (см. handleAdminAccountApprove).
	writeJSON(w, http.StatusCreated, map[string]string{"status": "pending"})
}

func (a *API) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct{ Username, Password string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	token, acc, err := a.Auth.Login(r.Context(), req.Username, req.Password)
	if err != nil {
		if errors.Is(err, domain.ErrForbidden) {
			writeErr(w, http.StatusForbidden, "аккаунт ждёт подтверждения ДМ")
			return
		}
		writeErr(w, http.StatusUnauthorized, "неверный логин или пароль")
		return
	}
	setSessionCookie(w, token)
	chars, err := a.myCharacters(r.Context(), acc)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, a.meResponseJSON(acc, chars))
}

func (a *API) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(domain.SessionCookieName); err == nil {
		_ = a.Auth.Logout(r.Context(), c.Value)
	}
	clearSessionCookie(w)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleMe — сознательно НЕ через requireAccount: та ручка уже отказывает
// 403-м игроку, чей мир сейчас не запущен (см. её комментарий), а именно
// /api/me должна суметь ответить такому игроку "твой мир не запущен" (см.
// meResponseJSON.worldActive), чтобы фронт (index.js) показал понятное
// сообщение, а не голый 403 без деталей. Проверяем только валидность
// сессии, без проверки мира.
func (a *API) handleMe(w http.ResponseWriter, r *http.Request) {
	acc, err := a.sessionAccount(r)
	if err != nil || !acc.IsActive() {
		writeErr(w, http.StatusUnauthorized, "не авторизован")
		return
	}
	chars, err := a.myCharacters(r.Context(), acc)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, a.meResponseJSON(acc, chars))
}

// handleChangeOwnPassword — самообслуживание: своя смена пароля, зная
// старый (в отличие от admin-сброса, которому старый пароль не нужен).
// Успех сносит ВСЕ сессии этого аккаунта (включая текущую) — приходится
// перелогиниться, зато старый пароль нигде больше не работает. Через
// sessionAccount напрямую (не requireAccount) — тем же принципом, что и
// handleMe: смена пароля не должна зависеть от того, запущен ли сейчас мир
// этого игрока.
func (a *API) handleChangeOwnPassword(w http.ResponseWriter, r *http.Request) {
	acc, err := a.sessionAccount(r)
	if err != nil || !acc.IsActive() {
		writeErr(w, http.StatusUnauthorized, "не авторизован")
		return
	}
	var req struct{ OldPassword, NewPassword string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	if err := a.Auth.ChangeOwnPassword(r.Context(), acc.ID, req.OldPassword, req.NewPassword); err != nil {
		var verr *domain.ValidationError
		switch {
		case errors.Is(err, domain.ErrUnauthorized):
			writeErr(w, http.StatusUnauthorized, "неверный текущий пароль")
		case errors.As(err, &verr):
			writeErr(w, http.StatusBadRequest, verr.Msg)
		default:
			writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		}
		return
	}
	clearSessionCookie(w)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
