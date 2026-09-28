package http_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	apihttp "beacon-table/internal/api/http"
	"beacon-table/internal/domain"
	"beacon-table/internal/repository/memory"
	"beacon-table/internal/service"
)

// diagServer — страница трансляции и ручки её журнала так, как их собирает
// cmd/beacon-table/main.go, плюс cookie ДМ для чтения журнала.
func diagServer(t *testing.T) (*httptest.Server, *http.Cookie) {
	t.Helper()
	ctx := context.Background()
	accounts := memory.NewAccountStore()
	sessions := memory.NewSessionStore(accounts)
	if err := accounts.Create(ctx, &domain.Account{
		ID: "dm", Username: "дм", PasswordHash: "x",
		Role: domain.AccountRoleAdmin, Status: domain.AccountStatusActive,
	}); err != nil {
		t.Fatalf("аккаунт ДМ: %v", err)
	}
	if err := sessions.Create(ctx, "sess-dm", "dm"); err != nil {
		t.Fatalf("сессия ДМ: %v", err)
	}
	api := &apihttp.API{
		Auth:       service.NewAuthService(accounts, sessions),
		Broadcast:  service.NewBroadcastService(memory.NewServerStateStore()),
		LANOrigins: func() []string { return []string{"http://192.168.1.5:8080"} },
	}
	page := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("страница трансляции"))
	})
	mux := http.NewServeMux()
	mux.Handle("GET /broadcast.html", api.BroadcastEntry(page))
	api.RegisterRoutes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, &http.Cookie{Name: domain.SessionCookieName, Value: "sess-dm"}
}

// reply — прочитанный ответ: тело забираем и закрываем сразу, тестам нужны
// только статус, заголовки и байты.
type reply struct {
	StatusCode int
	Header     http.Header
	Body       []byte
}

func do(t *testing.T, srv *httptest.Server, method, path, ua, body string, cookies ...*http.Cookie) reply {
	t.Helper()
	req, err := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatalf("запрос %s: %v", path, err)
	}
	if ua != "" {
		req.Header.Set("User-Agent", ua)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for _, c := range cookies {
		req.AddCookie(c)
	}
	client := srv.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("%s %s: тело: %v", method, path, err)
	}
	return reply{StatusCode: resp.StatusCode, Header: resp.Header, Body: data}
}

type diagScreen struct {
	UserAgent string            `json:"userAgent"`
	Loads     int               `json:"loads"`
	Started   bool              `json:"started"`
	TimedOut  bool              `json:"timedOut"`
	Info      map[string]string `json:"info"`
	Errors    []string          `json:"errors"`
}

// TestBroadcastDiagCollectsScreen — телевизор, на котором не выполнилось
// ничего, всё равно оставляет в журнале свой браузер; сторож страницы
// добавляет сведения и ошибки; ДМ читает это одним запросом.
func TestBroadcastDiagCollectsScreen(t *testing.T) {
	srv, dm := diagServer(t)
	const tv = "Mozilla/5.0 (Linux; Android 7.1.2; TV Box) Chrome/69.0.3497.100"

	do(t, srv, http.MethodGet, "/broadcast.html", tv, "")
	do(t, srv, http.MethodPost, "/api/broadcast/diag", tv, `{"kind":"page","info":{"webgl":"да","modules":"да"}}`)
	do(t, srv, http.MethodPost, "/api/broadcast/diag", tv, `{"kind":"error","message":"SyntaxError: Unexpected token '?'"}`)
	do(t, srv, http.MethodPost, "/api/broadcast/diag", tv, `{"kind":"timeout"}`)

	if code := do(t, srv, http.MethodGet, "/api/broadcast/diag", tv, "").StatusCode; code != http.StatusUnauthorized && code != http.StatusForbidden {
		t.Fatalf("журнал без входа: статус %d, ожидался отказ", code)
	}

	resp := do(t, srv, http.MethodGet, "/api/broadcast/diag", "", "", dm)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("журнал у ДМ: статус %d", resp.StatusCode)
	}
	var screens []diagScreen
	if err := json.Unmarshal(resp.Body, &screens); err != nil {
		t.Fatalf("разбор журнала: %v", err)
	}
	if len(screens) != 1 {
		t.Fatalf("экранов %d, ожидался один: %+v", len(screens), screens)
	}
	s := screens[0]
	if s.UserAgent != tv || s.Loads != 1 || s.Started || !s.TimedOut {
		t.Fatalf("экран записан не так: %+v", s)
	}
	if s.Info["webgl"] != "да" {
		t.Fatalf("сведения сторожа потерялись: %+v", s.Info)
	}
	if len(s.Errors) != 1 || !strings.Contains(s.Errors[0], "SyntaxError") {
		t.Fatalf("ошибки: %+v", s.Errors)
	}
}

// TestBroadcastDiagBounded — приём без авторизации, поэтому мусор из сети
// не должен копить память: экранов и ошибок держится не больше потолка.
func TestBroadcastDiagBounded(t *testing.T) {
	srv, dm := diagServer(t)
	for i := 0; i < 30; i++ {
		ua := "bot-" + strings.Repeat("x", i)
		do(t, srv, http.MethodPost, "/api/broadcast/diag", ua, `{"kind":"error","message":"`+strings.Repeat("я", 2000)+`"}`)
	}
	for i := 0; i < 50; i++ {
		do(t, srv, http.MethodPost, "/api/broadcast/diag", "tv", `{"kind":"error","message":"ошибка"}`)
	}

	var screens []diagScreen
	if err := json.Unmarshal(do(t, srv, http.MethodGet, "/api/broadcast/diag", "", "", dm).Body, &screens); err != nil {
		t.Fatalf("разбор журнала: %v", err)
	}
	if len(screens) > 8 {
		t.Fatalf("экранов %d — журнал не ограничен", len(screens))
	}
	for _, s := range screens {
		if len(s.Errors) > 12 {
			t.Fatalf("ошибок у экрана %d — не ограничено", len(s.Errors))
		}
		for _, e := range s.Errors {
			if len(e) > 700 {
				t.Fatalf("ошибка длиной %d байт не обрезана", len(e))
			}
		}
	}
}

// TestBroadcastShortcut — короткий адрес для пульта ведёт на страницу
// трансляции и переносит ключ, а подставить в редирект чужой адрес нельзя.
func TestBroadcastShortcut(t *testing.T) {
	srv, _ := diagServer(t)
	cases := map[string]string{
		"/tv":                           "/broadcast.html",
		"/broadcast":                    "/broadcast.html",
		"/tv?key=abc":                   "/broadcast.html?key=abc",
		"/tv?key=%2F%2Fevil.example%2F": "/broadcast.html?key=%2F%2Fevil.example%2F",
	}
	for path, want := range cases {
		resp := do(t, srv, http.MethodGet, path, "", "")
		if resp.StatusCode != http.StatusFound {
			t.Fatalf("%s: статус %d, ожидался 302", path, resp.StatusCode)
		}
		if loc := resp.Header.Get("Location"); loc != want {
			t.Fatalf("%s: редирект на %q, ожидался %q", path, loc, want)
		}
	}
}

// TestBroadcastLinkLANOrigins — ДМ получает адреса стола в сети: по ним фронт
// соберёт ссылку для телевизора, если сам стол открыт как localhost.
func TestBroadcastLinkLANOrigins(t *testing.T) {
	srv, dm := diagServer(t)
	var link struct {
		ShortPath  string   `json:"shortPath"`
		LANOrigins []string `json:"lanOrigins"`
	}
	if err := json.Unmarshal(do(t, srv, http.MethodGet, "/api/broadcast/link", "", "", dm).Body, &link); err != nil {
		t.Fatalf("разбор ссылки: %v", err)
	}
	if link.ShortPath != "/tv" || len(link.LANOrigins) != 1 || link.LANOrigins[0] != "http://192.168.1.5:8080" {
		t.Fatalf("ссылка: %+v", link)
	}
}
