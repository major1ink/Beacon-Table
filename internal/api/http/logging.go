package http

import (
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// statusRecorder запоминает код ответа: http.ResponseWriter его не отдаёт, а
// без кода запись о запросе бесполезна.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK // хендлер пишет тело сразу, без WriteHeader
	}
	return r.ResponseWriter.Write(b)
}

// LogRequests пишет строку на каждый запрос. Уровень выбран так, чтобы
// журнал на сервере не рос сам по себе:
//
//   - 5xx — error: сломались мы, это надо видеть всегда;
//   - 4xx — warn: чаще всего чужой или устаревший клиент, полезно при разборе;
//   - остальное — debug: обычная работа стола, сотни запросов на сессию.
//
// Статика и загруженные файлы не логируются вовсе: одна открытая карта даёт
// десятки запросов, и они топят в себе всё остальное.
func LogRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !worthLogging(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w}
		next.ServeHTTP(rec, r)

		status := rec.status
		if status == 0 {
			status = http.StatusOK
		}
		level := slog.LevelDebug
		switch {
		case status >= 500:
			level = slog.LevelError
		case status >= 400:
			level = slog.LevelWarn
		}
		slog.Log(r.Context(), level, "запрос",
			"method", r.Method,
			"path", r.URL.Path,
			"status", status,
			"ms", time.Since(start).Milliseconds(),
		)
	})
}

func worthLogging(path string) bool {
	switch {
	case strings.HasPrefix(path, "/api/"):
		return true
	case path == "/upload" || path == "/assets" || path == "/healthz":
		return true
	default:
		return false
	}
}
