package http

import (
	"errors"
	"net"
	"net/http"
	"time"

	"beacon-table/internal/domain"
)

// broadcastPagePath — страница трансляции. Константа, а не r.URL.Path: на
// неё уводит редирект после обмена ключа на cookie, и брать цель редиректа
// из запроса значило бы открыть перенаправление на чужой адрес.
const broadcastPagePath = "/broadcast.html"

// setBroadcastCookie — выдать этому браузеру право смотреть трансляцию (см.
// domain.BroadcastCookieName). Значение — сам ключ: он проверяется на каждом
// запросе, поэтому перевыпуск ключа отзывает доступ мгновенно, без списка
// выданных зрительских сессий.
func (a *API) setBroadcastCookie(w http.ResponseWriter, key string) {
	//nolint:gosec // G124: Secure — из конфигурации, см. setSessionCookie
	// (middleware.go).
	http.SetCookie(w, &http.Cookie{
		Name:     domain.BroadcastCookieName,
		Value:    key,
		Path:     "/",
		HttpOnly: true,
		Secure:   a.SecureCookies,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(domain.BroadcastCookieTTL.Seconds()),
	})
}

// broadcastKey — ключ трансляции, предъявленный этим запросом: cookie
// зрителя либо ?key= в адресе. Второе нужно не только на входе (см.
// BroadcastEntry): телевизор, которому cookie не досталась (режим без
// cookie, встроенный браузер приставки), продолжит работать по ключу в
// адресе — картинки со сцены он запрашивает уже без него, но WS-хендшейк
// страница делает сама и ключ приложить может.
func broadcastKey(r *http.Request) string {
	if c, err := r.Cookie(domain.BroadcastCookieName); err == nil && c.Value != "" {
		return c.Value
	}
	return r.URL.Query().Get(domain.BroadcastKeyParam)
}

// handleBroadcastLink — GET /api/broadcast/link (только ДМ): текущий ключ и
// путь, который нужно открыть на телевизоре. Полный адрес собирает фронт из
// location.origin — сервер за обратным прокси своего внешнего имени не знает
// и угадывать его по заголовкам не должен.
func (a *API) handleBroadcastLink(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireOwner(w, r); !ok {
		return
	}
	key, err := a.Broadcast.Key(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"key":  key,
		"path": broadcastPagePath + "?" + domain.BroadcastKeyParam + "=" + key,
	})
}

// handleBroadcastRotate — POST /api/broadcast/link/rotate (только ДМ):
// перевыпуск ключа. Все экраны, которым раздали прежнюю ссылку, теряют
// доступ немедленно — это и есть способ отозвать трансляцию, если ссылка
// ушла не туда.
func (a *API) handleBroadcastRotate(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireOwner(w, r); !ok {
		return
	}
	key, err := a.Broadcast.Rotate(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"key":  key,
		"path": broadcastPagePath + "?" + domain.BroadcastKeyParam + "=" + key,
	})
}

// handleBroadcastAccess — GET /api/broadcast/access: пускают ли этот браузер
// к трансляции. Нужен самой странице трансляции, чтобы вместо чёрного экрана
// с молча упавшим WebSocket показать понятное «нужна ссылка от ДМ» (см.
// web/src/pages/broadcast.js).
func (a *API) handleBroadcastAccess(w http.ResponseWriter, r *http.Request) {
	if !a.viewerAllowed(r) {
		writeErr(w, http.StatusForbidden, "нужна ссылка трансляции от ДМ")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// BroadcastEntry — обёртка над раздачей самой страницы /broadcast.html:
// принимает ссылку с ?key=, обменивает ключ на cookie зрителя и уводит
// браузер на чистый адрес. Редирект тут не косметика: без него ключ навсегда
// остаётся в адресной строке телевизора и в истории браузера, откуда его
// прочитает любой, кто подойдёт к экрану.
//
// Ключ неверен или его нет — страница всё равно отдаётся: разбираться, что
// доступа нет, и показывать это человеку — её работа (см.
// handleBroadcastAccess), а не работа 403-й страницы сервера.
func (a *API) BroadcastEntry(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.URL.Query().Get(domain.BroadcastKeyParam)
		if key != "" && a.Broadcast.Valid(r.Context(), key) {
			a.setBroadcastCookie(w, key)
			http.Redirect(w, r, broadcastPagePath, http.StatusSeeOther)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequireViewer — гейт на раздачу загруженных файлов (/uploads/). До этой
// обёртки каталог отдавался кому угодно: карты, токены, аудио и
// иллюстрации журналов всех миров лежали в интернете по прямой ссылке, а
// http.FileServer вдобавок отдавал список файлов на запрос каталога, так что
// и угадывать имена не требовалось.
func (a *API) RequireViewer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !a.viewerAllowed(r) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ---- заявки экранов на доступ ----
//
// Второй путь к тому же ключу: ссылку с ключом на телевизоре не набрать —
// пульт не клавиатура. Поэтому экран открывает /broadcast.html как есть,
// показывает код, а ДМ пускает его кнопкой у себя в «Настройках».

// clientAddr — адрес запроса для показа ДМ рядом с кодом заявки. Порт
// отбрасываем: человеку, сверяющему «это наш телевизор или кто-то чужой»,
// он ничего не говорит. Берём r.RemoteAddr как есть — заголовки прокси не
// учитываем.
func clientAddr(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// handleBroadcastRequestCreate — POST /api/broadcast/requests: экран просится
// к столу. Без авторизации по устройству сценария — пускает или отказывает
// ДМ, а не сервер.
func (a *API) handleBroadcastRequestCreate(w http.ResponseWriter, r *http.Request) {
	// Уже допущенному экрану заявка не нужна: отвечаем так, будто ДМ уже
	// нажал «Пустить», и страница просто перезагрузится в стол.
	if a.viewerAllowed(r) {
		writeJSON(w, http.StatusOK, map[string]string{"state": domain.BroadcastRequestApproved})
		return
	}
	req, err := a.Broadcast.RequestAccess(clientAddr(r))
	if err != nil {
		writeErr(w, http.StatusTooManyRequests, "слишком много экранов ждут подтверждения — попробуйте через несколько минут")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{
		"id":    req.ID,
		"code":  req.Code,
		"state": domain.BroadcastRequestPending,
	})
}

// handleBroadcastRequestState — GET /api/broadcast/requests/{id}: ожидающий
// экран спрашивает, чем кончилось. Именно здесь выдаётся cookie зрителя —
// ключ доезжает до телевизора сам, никто его не вводит и нигде не видит.
func (a *API) handleBroadcastRequestState(w http.ResponseWriter, r *http.Request) {
	state, key := a.Broadcast.RequestState(r.PathValue("id"))
	if state == domain.BroadcastRequestApproved && key != "" {
		a.setBroadcastCookie(w, key)
	}
	writeJSON(w, http.StatusOK, map[string]string{"state": state})
}

// handleBroadcastRequestList — GET /api/broadcast/requests (только ДМ):
// экраны, ждущие ответа. Код каждой заявки ДМ сверяет с тем, что горит на
// самом экране — иначе «Пустить» рискует пустить не тот браузер.
func (a *API) handleBroadcastRequestList(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireOwner(w, r); !ok {
		return
	}
	pending := a.Broadcast.PendingRequests()
	out := make([]map[string]any, 0, len(pending))
	for _, req := range pending {
		out = append(out, map[string]any{
			"id":         req.ID,
			"code":       req.Code,
			"remoteAddr": req.RemoteAddr,
			"createdAt":  req.CreatedAt.Format(time.RFC3339),
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// handleBroadcastRequestApprove — POST /api/broadcast/requests/{id}/approve
// (только ДМ): пустить экран.
func (a *API) handleBroadcastRequestApprove(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireOwner(w, r); !ok {
		return
	}
	if err := a.Broadcast.ApproveRequest(r.Context(), r.PathValue("id")); err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "заявка уже неактуальна")
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleBroadcastRequestReject — POST /api/broadcast/requests/{id}/reject
// (только ДМ): отказать экрану.
func (a *API) handleBroadcastRequestReject(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireOwner(w, r); !ok {
		return
	}
	if err := a.Broadcast.RejectRequest(r.PathValue("id")); err != nil {
		writeErr(w, http.StatusNotFound, "заявка уже неактуальна")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
