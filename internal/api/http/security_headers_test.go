package http_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	apihttp "beacon-table/internal/api/http"
)

// Политика, доехавшая не со всеми документами, не защищает ничего.
func TestSecurityHeadersSetOnEveryResponse(t *testing.T) {
	h := apihttp.SecurityHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	for _, path := range []string{"/", "/dm.html", "/api/me", "/uploads/maps/tavern.png"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))

		csp := rec.Header().Get("Content-Security-Policy")
		if csp == "" {
			t.Fatalf("%s: пустой Content-Security-Policy", path)
		}
		// Непочищенный текст заметки становится ровно таким скриптом.
		if strings.Contains(csp, "script-src") && strings.Contains(csp, "'unsafe-inline' 'self'") {
			t.Fatalf("%s: script-src разрешает inline: %s", path, csp)
		}
		if !strings.Contains(csp, "connect-src 'self' data:") {
			t.Fatalf("%s: connect-src без data: — Pixi не найдёт ImageBitmap: %s", path, csp)
		}
		if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
			t.Fatalf("%s: X-Content-Type-Options = %q", path, got)
		}
		if got := rec.Header().Get("Referrer-Policy"); got != "same-origin" {
			t.Fatalf("%s: Referrer-Policy = %q", path, got)
		}
	}
}

// Заголовок обязан уйти до тела: после первой записи шапка уже отправлена.
func TestSecurityHeadersBeforeBody(t *testing.T) {
	h := apihttp.SecurityHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))

	if rec.Header().Get("Content-Security-Policy") == "" {
		t.Fatal("после записи тела политика не выставлена")
	}
}
