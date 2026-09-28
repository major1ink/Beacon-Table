package http

import "net/http"

// contentSecurityPolicy — второй рубеж после экранирования на клиенте (см.
// web/src/html.js): пропущенная подстановка в чужом тексте не выполнится,
// пока исполняются только скрипты с нашего адреса.
//
// script-src без 'unsafe-inline' — своих inline-скриптов в страницах нет;
// хеши — четыре служебных скрипта @vitejs/plugin-legacy на странице
// трансляции (выбор между современной и legacy-сборкой для старых
// телевизоров, см. web/vite.broadcast.config.js). Содержимое у них
// неизменное, плагин публикует хеши сам (cspHashes), а
// TestCSPAllowsBroadcastInlineScripts сверяет их с собранной страницей. style-src
// с ним — стили модалок ставит JS (modal.js). https: у картинок и звука —
// текст заметки может ссылаться наружу; blob: — доска и видеокарты сцены;
// ws:/wss: — за прокси схема сокета отличается от страницы. data: в
// connect-src — Pixi проверяет ImageBitmap fetch'ем data:-картинки, без него
// карты декодируются в основном потоке.
const contentSecurityPolicy = "default-src 'self'; " +
	"base-uri 'self'; " +
	"object-src 'none'; " +
	"frame-ancestors 'self'; " +
	"form-action 'self'; " +
	"script-src 'self' " + legacyScriptHashes + "; " +
	"style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data: blob: https:; " +
	"media-src 'self' data: blob: https:; " +
	"font-src 'self' data:; " +
	"worker-src 'self' blob:; " +
	"connect-src 'self' data: ws: wss:"

// legacyScriptHashes — см. комментарий к contentSecurityPolicy. Обновлять
// вместе с версией @vitejs/plugin-legacy: node -e
// "import('@vitejs/plugin-legacy').then(m=>console.log(m.cspHashes))" в web/.
const legacyScriptHashes = "'sha256-MS6/3FCg4WjP9gwgaBGwLpRCY6fZBgwmhVCdrPrNf3E=' " +
	"'sha256-tQjf8gvb2ROOMapIxFvFAYBeUJ0v1HCbOcSmDNXGtDo=' " +
	"'sha256-VA8O2hAdooB288EpSTrGLl7z3QikbWU9wwoebO/QaYk=' " +
	"'sha256-+5XkZFazzJo8n0iOP4ti/cLCMUudTf//Mzkb7xNPXIc='"

// SecurityHeaders — ставятся до вызова хендлера: после первого w.Write шапка
// уже ушла в сеть.
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", contentSecurityPolicy)
		// Загруженный игроком файл с картинкой внутри, но HTML-содержимым,
		// иначе может быть показан браузером как страница нашего же origin.
		h.Set("X-Content-Type-Options", "nosniff")
		// Дублирует frame-ancestors для браузеров, которые его не знают.
		h.Set("X-Frame-Options", "SAMEORIGIN")
		// Адрес стола — это чаще всего адрес в домашней сети; во внешние
		// запросы (картинка из модуля) он попадать не должен.
		h.Set("Referrer-Policy", "same-origin")
		next.ServeHTTP(w, r)
	})
}
