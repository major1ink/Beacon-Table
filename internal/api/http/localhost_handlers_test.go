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

// dmResetResponse — запрос к /api/dm-password-reset с заданными методом и
// адресом клиента.
func dmResetResponse(t *testing.T, api *API, method, remoteAddr string) (int, map[string]string) {
	t.Helper()
	req := httptest.NewRequest(method, "/api/dm-password-reset", nil)
	req.RemoteAddr = remoteAddr
	rec := httptest.NewRecorder()
	api.handleDMPasswordReset(rec, req)

	var body map[string]string
	if rec.Body.Len() > 0 {
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
	}
	return rec.Code, body
}

func apiWithReset() (*API, *int) {
	calls := 0
	api := &API{}
	api.ResetDMPassword = func() (string, string, error) {
		calls++
		return "dm", "новый-пароль", nil
	}
	return api, &calls
}

// Сброс с этой же машины: пароль меняется и новый возвращается на страницу.
func TestDMPasswordResetLoopback(t *testing.T) {
	api, calls := apiWithReset()
	code, body := dmResetResponse(t, api, http.MethodPost, "127.0.0.1:54321")
	if code != http.StatusOK {
		t.Fatalf("код %d, ожидался 200", code)
	}
	if body["username"] != "dm" || body["password"] != "новый-пароль" {
		t.Fatalf("ответ %v", body)
	}
	if *calls != 1 {
		t.Fatalf("сброс вызван %d раз", *calls)
	}
}

// Запрос из сети, из-за прокси и в демо: сброс не выполняется. Иначе любой
// игрок за столом одним запросом забирал бы себе аккаунт ДМ.
func TestDMPasswordResetForbidden(t *testing.T) {
	remote, calls := apiWithReset()
	if code, _ := dmResetResponse(t, remote, http.MethodPost, "192.168.1.15:54321"); code != http.StatusForbidden {
		t.Fatalf("из сети: код %d, ожидался 403", code)
	}

	proxied, proxiedCalls := apiWithReset()
	proxied.SecureCookies = true
	if code, _ := dmResetResponse(t, proxied, http.MethodPost, "127.0.0.1:54321"); code != http.StatusForbidden {
		t.Fatalf("за прокси: код %d, ожидался 403", code)
	}

	demo, demoCalls := apiWithReset()
	demo.DemoMode = true
	if code, _ := dmResetResponse(t, demo, http.MethodPost, "127.0.0.1:54321"); code != http.StatusForbidden {
		t.Fatalf("в демо: код %d, ожидался 403", code)
	}

	if *calls != 0 || *proxiedCalls != 0 || *demoCalls != 0 {
		t.Fatal("сброс выполнился там, где не должен")
	}
}

// GET говорит странице входа, показывать ли кнопку «Забыли пароль?».
func TestDMPasswordResetAvailability(t *testing.T) {
	available := func(api *API, remoteAddr string) bool {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/api/dm-password-reset", nil)
		req.RemoteAddr = remoteAddr
		rec := httptest.NewRecorder()
		api.handleDMPasswordReset(rec, req)
		var body struct {
			Available bool `json:"available"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("ответ не JSON: %q", rec.Body.String())
		}
		return body.Available
	}
	api, _ := apiWithReset()
	if !available(api, "127.0.0.1:54321") {
		t.Fatal("с этой машины сброс должен быть доступен")
	}
	if available(api, "192.168.1.15:54321") {
		t.Fatal("из сети сброс предлагать нельзя")
	}
	noReset := &API{}
	if available(noReset, "127.0.0.1:54321") {
		t.Fatal("без ResetDMPassword сброс предлагать нечем")
	}
}
