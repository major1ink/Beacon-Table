package http

import (
	"net/http"

	"beacon-table/internal/app"
	"beacon-table/internal/domain"
)

func setSessionCookie(w http.ResponseWriter, token string) {
	//nolint:gosec // G124: Secure сознательно не ставим — сервер по умолчанию
	// плейн HTTP (см. README "Доступ через интернет"), Secure-cookie тут
	// просто не долетела бы обратно. За HTTPS-реверс-прокси включайте
	// отдельно на уровне прокси (или форкайте это место под свой деплой).
	http.SetCookie(w, &http.Cookie{
		Name:     domain.SessionCookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		// SameSite=Lax: не улетает на кросс-сайтовые POST/WS из чужого
		// origin, но переживает обычную навигацию.
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(domain.SessionTTL.Seconds()),
	})
}

func clearSessionCookie(w http.ResponseWriter) {
	//nolint:gosec // G124: см. обоснование в setSessionCookie выше.
	http.SetCookie(w, &http.Cookie{
		Name:     domain.SessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}

// sessionAccount — аккаунт по cookie сессии, без проверки статуса/мира
// (та проверка — в requireAccount ниже). Метод API (а не свободная функция,
// как раньше), потому что часть хендлеров (upload/assets) обращались к ней
// напрямую в обход requireAccount и теперь должны получить ту же проверку
// активного мира — проще держать всё на *API.
func (a *API) sessionAccount(r *http.Request) (*domain.Account, error) {
	c, err := r.Cookie(domain.SessionCookieName)
	if err != nil {
		return nil, domain.ErrNotFound
	}
	return a.Auth.AccountBySession(r.Context(), c.Value)
}

// requireAccount — общий гейт для большинства /api/* эндпоинтов, кроме
// register/login: валидная сессия + активный (не pending) аккаунт +, для
// игрока, его компания сейчас должна быть запущенным миром сервера (см.
// app.CompanyManager.AccountInActiveWorld) — если ДМ сейчас ведёт другой
// мир, аккаунт этого игрока временно не может делать вообще ничего через
// API, кроме как получить это самое сообщение через /api/me (см.
// auth_handlers.go). ДМ (admin) эту проверку не проходит — он не привязан к
// компании и управляет всеми ими. Пишет статус сам и возвращает ok=false,
// если что-то не так — вызывающему остаётся один ранний `if !ok { return }`.
func (a *API) requireAccount(w http.ResponseWriter, r *http.Request) (*domain.Account, bool) {
	acc, err := a.sessionAccount(r)
	if err != nil || !acc.IsActive() {
		writeErr(w, http.StatusUnauthorized, "не авторизован")
		return nil, false
	}
	if !acc.IsAdmin() && !a.Companies.AccountInActiveWorld(acc) {
		writeErr(w, http.StatusForbidden, "твой мир сейчас не запущен ДМ")
		return nil, false
	}
	return acc, true
}

// viewerAllowed — можно ли этому запросу отдавать содержимое стола, которое
// не является чьими-то личными данными: загруженные карты/токены/аудио
// (/uploads/) и картинку сцены по /ws/view. Пускаем два вида клиентов:
//
//   - любой активный аккаунт — ДМ и игроки; намеренно БЕЗ проверки
//     активного мира (в отличие от requireAccount), иначе у игрока, чей мир
//     сейчас не запущен, перестал бы грузиться аватар собственного
//     персонажа на странице листа;
//   - телевизор с ключом трансляции — аккаунта у него нет по устройству
//     сценария (см. domain.BroadcastCookieName).
//
// Разделения «чей это файл» тут нет и не предполагается: внутри одного стола
// карты и токены и так общие, а границей служит сам факт участия в столе.
func (a *API) viewerAllowed(r *http.Request) bool {
	if acc, err := a.sessionAccount(r); err == nil && acc.IsActive() {
		return true
	}
	return a.Broadcast.Valid(r.Context(), broadcastKey(r))
}

func (a *API) requireAdminAccount(w http.ResponseWriter, r *http.Request) (*domain.Account, bool) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return nil, false
	}
	if !acc.IsAdmin() {
		writeErr(w, http.StatusForbidden, "только для ДМ")
		return nil, false
	}
	return acc, true
}

// requireWorld — сервисы ТЕКУЩЕГО запущенного мира (see app.ActiveWorld).
// nil, только если сейчас в принципе ничего не запущено (свежая установка
// до первого "Создать мир", либо доля секунды посреди app.CompanyManager.Launch,
// см. его комментарий) — вызывающий уже прошёл requireAccount/
// requireAdminAccount, так что игрок с чужой (не активной) компанией сюда
// вообще не попадёт, это только защита от гонки/пустого сервера.
func (a *API) requireWorld(w http.ResponseWriter) (*app.ActiveWorld, bool) {
	world := a.Companies.Current()
	if world == nil {
		writeErr(w, http.StatusServiceUnavailable, "мир сейчас не запущен")
		return nil, false
	}
	return world, true
}
