package http_test

import (
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
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

// TestCSPAllowsBroadcastInlineScripts проверяет, что CSP разрешает inline-скрипты legacy-плагина на странице трансляции.
func TestCSPAllowsBroadcastInlineScripts(t *testing.T) {
	page, err := os.ReadFile(filepath.Join("..", "..", "..", "cmd", "beacon-table", "static", "broadcast.html"))
	if err != nil {
		t.Skipf("нет собранного фронтенда: %v", err)
	}
	h := apihttp.SecurityHeaders(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/broadcast.html", nil))
	csp := rec.Header().Get("Content-Security-Policy")

	re := regexp.MustCompile(`(?s)<script\b([^>]*)>(.*?)</script>`)
	inline := 0
	for _, m := range re.FindAllStringSubmatch(string(page), -1) {
		if m[2] == "" || strings.Contains(m[1], " src=") {
			continue
		}
		inline++
		sum := sha256.Sum256([]byte(m[2]))
		hash := "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
		if !strings.Contains(csp, hash) {
			t.Errorf("inline-скрипт страницы трансляции не разрешён CSP (%s): %.80s", hash, m[2])
		}
	}
	if inline == 0 {
		t.Fatal("в broadcast.html нет inline-скриптов legacy-плагина — сборка идёт без vite.broadcast.config.js?")
	}
}
