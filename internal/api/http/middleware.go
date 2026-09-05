package http

import (
	"net/http"
	"strings"

	"beacon-table/internal/app"
	"beacon-table/internal/domain"
)

// maxAPIBody — потолок на тело обычного запроса к /api/*. Лист персонажа,
// заметка, карточка — это килобайты; мегабайт с огромным запасом. Без него
// любой залогиненный игрок мог прислать гигабайтный JSON, и сервер прочитал
// бы его в память.
const maxAPIBody = 1 << 20

// bigBodyAPIPaths — /api/*-ручки, принимающие файлы: у каждой свой, больший
// предел в самом хендлере (см. maxWorldImportSize, maxBoardUpload). /upload
// лежит вне /api/ и под этот middleware не попадает вовсе.
var bigBodyAPIPaths = map[string]bool{
	"/api/companies/import": true,
	"/api/boards/import":    true,
}

// multipartMemoryBudget — второй аргумент http.Request.ParseMultipartForm:
// сколько тела запроса разбирать В ПАМЯТИ, остальное уходит во временный
// файл на диске. На предел размера НЕ влияет — тот уже поставлен отдельно,
// http.MaxBytesReader'ом перед вызовом (см. upload_handlers.go/
// company_handlers.go). Раньше сюда передавали сам предел размера (200 МБ у
// /upload, 1 ГБ у импорта мира) — это значило «держать в RAM почти весь
// файл целиком», а не «столько-то на диск и точка», и обесценивало любой
// потолок памяти процесса (см. deploy/beacon-table.service: MemoryMax,
// docker-compose.yml: mem_limit) — тот убивал бы службу ровно на легальной
// крупной загрузке. 32 МБ с запасом хватает на форму с обычными полями и
// маленькими файлами (аватар, значок), не разбираясь в диск зря.
const multipartMemoryBudget = 32 << 20

// LimitAPIBodies оборачивает весь mux: тело запроса к /api/* читается не
// дальше maxAPIBody. Слишком длинный Content-Length отсекается сразу, тело
// без него (chunked) — на чтении в хендлере.
func (a *API) LimitAPIBodies(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") && !bigBodyAPIPaths[r.URL.Path] {
			if r.ContentLength > maxAPIBody {
				writeErr(w, http.StatusRequestEntityTooLarge, "тело запроса слишком большое")
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, maxAPIBody)
		}
		next.ServeHTTP(w, r)
	})
}

// setSessionCookie — cookie сессии. Secure ставится по флагу
// --behind-proxy (см. API.SecureCookies): на голом HTTP, каким сервер
// работает в локальной сети, такая cookie просто не долетела бы обратно, а
// за HTTPS-прокси она обязательна — иначе токен на месяцы уходит открытым
// текстом при первом же заходе по http://.
func (a *API) setSessionCookie(w http.ResponseWriter, token string) {
	//nolint:gosec // G124: Secure выставляется из конфигурации (--behind-proxy),
	// а не константой — статический анализ видит переменную и считает флаг
	// потенциально снятым. Так и задумано: на голом HTTP в локальной сети
	// Secure-cookie просто не долетела бы обратно.
	http.SetCookie(w, &http.Cookie{
		Name:     domain.SessionCookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   a.SecureCookies,
		// SameSite=Lax: не улетает на кросс-сайтовые POST/WS из чужого
		// origin, но переживает обычную навигацию.
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(domain.SessionTTL.Seconds()),
	})
}

func (a *API) clearSessionCookie(w http.ResponseWriter) {
	//nolint:gosec // G124: см. обоснование в setSessionCookie выше.
	http.SetCookie(w, &http.Cookie{
		Name:     domain.SessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   a.SecureCookies,
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
	acc, err := a.Auth.AccountBySession(r.Context(), c.Value)
	// Единственная точка, через которую cookie превращается в аккаунт, — она
	// же и место, где видно «гость ещё здесь». Отсюда, а не из requireAccount:
	// картинки карты идут мимо него (см. viewerAllowed), а разглядывание
	// карты — ровно то присутствие, за которое гостя не должно вынести (см.
	// app.GuestKeeper).
	if err == nil && acc.IsDemo() {
		a.Guests.Touch(acc.ID)
	}
	return acc, err
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
	if !acc.IsGM() && !a.Companies.AccountInActiveWorld(acc) {
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

// requireAdminAccount — гейт всего, что относится к ведению стола: сцены,
// бестиарий, журнал, плейлисты, готовые персонажи. Пускает и настоящего ДМ,
// и гостя публичного демо: за столом им можно одно и то же.
func (a *API) requireAdminAccount(w http.ResponseWriter, r *http.Request) (*domain.Account, bool) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return nil, false
	}
	if !acc.IsGM() {
		writeErr(w, http.StatusForbidden, "только для ДМ")
		return nil, false
	}
	return acc, true
}

// requireOwner — гейт всего, что относится к серверу, а не к игре: аккаунты,
// миры, настройки, ключ трансляции, импорт модулей из интернета.
//
// Гостя демо сюда не пускаем. Иначе публичное демо означало бы «возьмите мой
// сервер»: гость с правами ДМ мог бы удалить чужие миры, переписать
// beacon.conf, завести себе постоянный аккаунт или заставить сервер ходить
// по ссылкам в интернет.
func (a *API) requireOwner(w http.ResponseWriter, r *http.Request) (*domain.Account, bool) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return nil, false
	}
	if !acc.IsOwner() {
		writeErr(w, http.StatusForbidden, "это может только владелец сервера")
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
