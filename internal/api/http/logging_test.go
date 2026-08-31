package http

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// captureLogs подменяет журнал на буфер и возвращает разобранные записи.
func captureLogs(t *testing.T, level slog.Level, do func()) []map[string]any {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: level})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	do()

	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		if line == "" {
			continue
		}
		var rec map[string]any
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			t.Fatalf("строка журнала не JSON: %q", line)
		}
		out = append(out, rec)
	}
	return out
}

func serveThrough(status int, path string) func() {
	return func() {
		h := LogRequests(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(status)
		}))
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, path, nil))
	}
}

// TestLogRequestsLevels — код ответа определяет уровень: 5xx видно всегда,
// 4xx на warn, обычная работа — только на debug, чтобы журнал не рос сам.
func TestLogRequestsLevels(t *testing.T) {
	cases := []struct {
		status int
		level  slog.Level
		want   string
	}{
		{http.StatusOK, slog.LevelDebug, "DEBUG"},
		{http.StatusNotFound, slog.LevelWarn, "WARN"},
		{http.StatusInternalServerError, slog.LevelWarn, "ERROR"},
	}
	for _, c := range cases {
		recs := captureLogs(t, c.level, serveThrough(c.status, "/api/companies"))
		if len(recs) != 1 {
			t.Fatalf("статус %d: записей %d, ожидалась одна", c.status, len(recs))
		}
		if recs[0]["level"] != c.want {
			t.Errorf("статус %d: уровень %v, ожидался %s", c.status, recs[0]["level"], c.want)
		}
		if recs[0]["status"] != float64(c.status) {
			t.Errorf("в записи статус %v, ожидался %d", recs[0]["status"], c.status)
		}
	}
}

// TestLogRequestsQuietOnInfo — на обычном уровне успешные запросы в журнал
// не попадают: одна игровая сессия — это тысячи запросов.
func TestLogRequestsQuietOnInfo(t *testing.T) {
	if recs := captureLogs(t, slog.LevelInfo, serveThrough(http.StatusOK, "/api/companies")); len(recs) != 0 {
		t.Fatalf("на уровне info записано %d строк об успешном запросе", len(recs))
	}
}

// TestLogRequestsSkipsStatic — статика и загруженные файлы не логируются
// даже на debug: одна открытая карта даёт десятки запросов.
func TestLogRequestsSkipsStatic(t *testing.T) {
	for _, path := range []string{"/dm.html", "/uploads/maps/tavern.png", "/assets/index.js"} {
		if recs := captureLogs(t, slog.LevelDebug, serveThrough(http.StatusOK, path)); len(recs) != 0 {
			t.Errorf("%s попал в журнал", path)
		}
	}
}

// TestLogRequestsRecordsImplicitOK — хендлер, который пишет тело без
// WriteHeader, всё равно логируется как 200, а не как 0.
func TestLogRequestsRecordsImplicitOK(t *testing.T) {
	recs := captureLogs(t, slog.LevelDebug, func() {
		h := LogRequests(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte("ok"))
		}))
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/version", nil))
	})
	if len(recs) != 1 || recs[0]["status"] != float64(http.StatusOK) {
		t.Fatalf("записи: %v", recs)
	}
}
