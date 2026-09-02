package http

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// firstRunResponse — GET /api/first-run с заданным адресом клиента.
func firstRunResponse(t *testing.T, api *API, remoteAddr string) (int, map[string]string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/first-run", nil)
	req.RemoteAddr = remoteAddr
	rec := httptest.NewRecorder()
	api.handleFirstRun(rec, req)

	var body map[string]string
	if rec.Body.Len() > 0 {
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("ответ не JSON: %q", rec.Body.String())
		}
	}
	return rec.Code, body
}

func apiWithFirstRun() *API {
	api := &API{}
	api.SetFirstRun(&FirstRun{Username: "dm", Password: "s3cret"})
	return api
}

// TestFirstRunLoopback — запрос с этой же машины: пароль отдаётся, иначе
// человеку без консоли неоткуда его взять.
func TestFirstRunLoopback(t *testing.T) {
	code, body := firstRunResponse(t, apiWithFirstRun(), "127.0.0.1:54321")
	if code != http.StatusOK {
		t.Fatalf("код %d, ожидался 200", code)
	}
	if body["username"] != "dm" || body["password"] != "s3cret" {
		t.Fatalf("ответ %v", body)
	}
}

// TestFirstRunRemote — запрос из сети: молчим. Пароль ДМ не должен уезжать
// на устройства игроков, подключившихся к столу.
func TestFirstRunRemote(t *testing.T) {
	code, _ := firstRunResponse(t, apiWithFirstRun(), "192.168.1.15:54321")
	if code != http.StatusNoContent {
		t.Fatalf("код %d, ожидался 204", code)
	}
}

// TestFirstRunBehindProxy — за прокси петлевой адрес принадлежит самому
// прокси, а не человеку за компьютером: подсказка выключена целиком.
func TestFirstRunBehindProxy(t *testing.T) {
	api := apiWithFirstRun()
	api.SecureCookies = true
	if code, _ := firstRunResponse(t, api, "127.0.0.1:54321"); code != http.StatusNoContent {
		t.Fatalf("код %d, ожидался 204", code)
	}

	api = apiWithFirstRun()
	api.DemoMode = true
	if code, _ := firstRunResponse(t, api, "127.0.0.1:54321"); code != http.StatusNoContent {
		t.Fatalf("код %d, ожидался 204 в демо", code)
	}
}

// TestFirstRunCleared — ДМ сменил пароль: подсказка исчезает, а
// композиционный корень узнаёт об этом через Done (и стирает файл с
// паролем).
func TestFirstRunCleared(t *testing.T) {
	done := false
	api := &API{}
	api.SetFirstRun(&FirstRun{Username: "dm", Password: "s3cret", Done: func() { done = true }})

	api.clearFirstRun("игрок") // чужая смена пароля подсказку не трогает
	if code, _ := firstRunResponse(t, api, "127.0.0.1:1"); code != http.StatusOK {
		t.Fatalf("код %d после смены пароля другим аккаунтом, ожидался 200", code)
	}

	api.clearFirstRun("dm")
	if !done {
		t.Fatal("Done не вызван — файл с паролем остался бы лежать")
	}
	if code, _ := firstRunResponse(t, api, "127.0.0.1:1"); code != http.StatusNoContent {
		t.Fatalf("код %d, ожидался 204", code)
	}
}

func TestIsLoopback(t *testing.T) {
	cases := map[string]bool{
		"127.0.0.1:8080": true,
		"[::1]:8080":     true,
		"127.0.0.1":      true,
		"192.168.1.5:80": false,
		"":               false,
		"не-адрес":       false,
	}
	for addr, want := range cases {
		if got := isLoopback(addr); got != want {
			t.Errorf("isLoopback(%q) = %v, ожидалось %v", addr, got, want)
		}
	}
}
