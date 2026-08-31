package http

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"beacon-table/internal/repository/sqlite"
)

type fakePinger struct{ err error }

func (p fakePinger) PingContext(context.Context) error { return p.err }

func healthResponse(t *testing.T, api *API) (int, map[string]string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	api.handleHealth(rec, req)

	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("ответ не JSON: %q", rec.Body.String())
	}
	return rec.Code, body
}

// TestHealthOK — база отвечает: 200 и версия сервера в ответе.
func TestHealthOK(t *testing.T) {
	api := &API{Version: "v1.2.3", Health: fakePinger{}}

	code, body := healthResponse(t, api)
	if code != http.StatusOK {
		t.Fatalf("код %d, ожидался 200", code)
	}
	if body["status"] != "ok" {
		t.Fatalf("status = %q", body["status"])
	}
	if body["version"] != "v1.2.3" {
		t.Fatalf("version = %q", body["version"])
	}
}

// TestHealthDBDown — база не отвечает: 503, чтобы мониторинг и docker
// healthcheck увидели проблему, а не «сервер жив» от процесса, который не
// может обслужить ни одного запроса.
func TestHealthDBDown(t *testing.T) {
	api := &API{Version: "v1", Health: fakePinger{err: errors.New("нет соединения")}}

	code, body := healthResponse(t, api)
	if code != http.StatusServiceUnavailable {
		t.Fatalf("код %d, ожидался 503", code)
	}
	if body["status"] == "ok" {
		t.Fatal("статус «ok» при мёртвой базе")
	}
}

// TestHealthWithoutPinger — без проверки базы ручка всё равно отвечает: сам
// факт ответа означает, что процесс жив и слушает.
func TestHealthWithoutPinger(t *testing.T) {
	api := &API{Version: "v1"}

	code, body := healthResponse(t, api)
	if code != http.StatusOK || body["status"] != "ok" {
		t.Fatalf("код %d, status %q", code, body["status"])
	}
}

// TestHealthOnClosedDB — 503 на настоящей закрытой базе, а не на подставном
// пингере: именно так выглядит сервер, у которого база отвалилась.
func TestHealthOnClosedDB(t *testing.T) {
	db, err := sqlite.Open(filepath.Join(t.TempDir(), "beacon.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	api := &API{Version: "v1", Health: db}

	if code, _ := healthResponse(t, api); code != http.StatusOK {
		t.Fatalf("на живой базе код %d, ожидался 200", code)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	code, body := healthResponse(t, api)
	if code != http.StatusServiceUnavailable {
		t.Fatalf("на закрытой базе код %d, ожидался 503", code)
	}
	if body["status"] == "ok" {
		t.Fatal("статус «ok» на закрытой базе")
	}
}
