package http

import (
	"errors"
	"net/http"

	"beacon-table/internal/domain"
)

// maxDemoGuests — сколько гостей демо живёт одновременно. Аккаунт заводится
// по одному нажатию, без всякого участия человека, поэтому предел нужен:
// иначе один скрипт набьёт базу за минуту. Отвечаем 429, а не молча
// перестаём пускать.
const maxDemoGuests = 40

// handleDemoStatus — GET /api/demo: включён ли демо-режим. Страница входа
// спрашивает это, чтобы решить, показывать ли кнопку «Посмотреть демо».
// Без авторизации — её и спрашивают до входа.
func (a *API) handleDemoStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"enabled": a.DemoMode})
}

// handleDemoGuest — POST /api/demo/guest: завести гостя и сразу его впустить.
//
// Гость получает права ДМ ВНУТРИ стола (см. domain.AccountRoleDemo): двигает
// токены, рисует стены, ставит свет, правит бестиарий — ради этого демо и
// существует. Сервером он не распоряжается: аккаунты, миры, настройки и
// импорт из интернета закрыты гейтом requireOwner.
func (a *API) handleDemoGuest(w http.ResponseWriter, r *http.Request) {
	if !a.DemoMode {
		writeErr(w, http.StatusNotFound, "демо-режим выключен")
		return
	}
	companyID := a.Companies.ActiveCompanyID()
	if companyID == "" {
		writeErr(w, http.StatusServiceUnavailable, "демо-стол сейчас не запущен, зайдите через минуту")
		return
	}

	token, acc, err := a.Auth.CreateGuest(r.Context(), companyID, maxDemoGuests)
	if err != nil {
		if errors.Is(err, domain.ErrConflict) {
			writeErr(w, http.StatusTooManyRequests, "сейчас за столом слишком много гостей — попробуйте через несколько минут")
			return
		}
		writeErr(w, http.StatusInternalServerError, "не удалось открыть демо")
		return
	}

	a.setSessionCookie(w, token)
	chars, err := a.myCharacters(r.Context(), acc)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, a.meResponseJSON(acc, chars))
}
