package http_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	apihttp "beacon-table/internal/api/http"
	"beacon-table/internal/domain"
	"beacon-table/internal/repository/memory"
	"beacon-table/internal/service"
)

// uploadsServer — раздача загрузок ровно так, как её собирает
// cmd/beacon-table/main.go: гейт зрителя поверх файлового сервера без
// листинга каталогов.
func uploadsServer(t *testing.T) (*httptest.Server, service.BroadcastService, *memory.AccountStore, *memory.SessionStore) {
	t.Helper()

	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "maps"), 0o750); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "maps", "tavern.png"), []byte("карта"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	accounts := memory.NewAccountStore()
	sessions := memory.NewSessionStore(accounts)
	auth := service.NewAuthService(accounts, sessions)
	broadcast := service.NewBroadcastService(memory.NewServerStateStore())

	api := &apihttp.API{Auth: auth, Broadcast: broadcast}

	mux := http.NewServeMux()
	mux.Handle("/uploads/", api.RequireViewer(
		http.StripPrefix("/uploads/", http.FileServer(apihttp.NoDirListing{FS: http.Dir(root)})),
	))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, broadcast, accounts, sessions
}

// status — код ответа на GET; тело тестам не нужно, поэтому хелпер отдаёт
// только статус и закрывает ответ сам.
func status(t *testing.T, srv *httptest.Server, path string, cookies ...*http.Cookie) int {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, srv.URL+path, nil)
	if err != nil {
		t.Fatalf("запрос %s: %v", path, err)
	}
	for _, c := range cookies {
		req.AddCookie(c)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	return resp.StatusCode
}

// TestUploadsRejectAnonymous — то, ради чего всё затевалось: посторонний не
// получает файл, даже зная точный путь к нему.
func TestUploadsRejectAnonymous(t *testing.T) {
	srv, _, _, _ := uploadsServer(t)

	if code := status(t, srv, "/uploads/maps/tavern.png"); code != http.StatusForbidden {
		t.Fatalf("аноним получил карту: статус %d, ожидался 403", code)
	}
}

// TestUploadsRejectDirectoryListing — каталог не отдаёт список содержимого
// даже допущенному зрителю: имена файлов подсказывать незачем никому.
func TestUploadsRejectDirectoryListing(t *testing.T) {
	srv, broadcast, _, _ := uploadsServer(t)
	key, err := broadcast.Key(context.Background())
	if err != nil {
		t.Fatalf("Key: %v", err)
	}
	viewer := &http.Cookie{Name: domain.BroadcastCookieName, Value: key}

	for _, path := range []string{"/uploads/", "/uploads/maps/"} {
		if code := status(t, srv, path, viewer); code != http.StatusNotFound {
			t.Fatalf("листинг %s: статус %d, ожидался 404", path, code)
		}
	}
}

// TestUploadsAllowBroadcastKey — телевизор с ключом трансляции карту
// получает: аккаунта у него нет и не будет.
func TestUploadsAllowBroadcastKey(t *testing.T) {
	srv, broadcast, _, _ := uploadsServer(t)
	key, err := broadcast.Key(context.Background())
	if err != nil {
		t.Fatalf("Key: %v", err)
	}

	code := status(t, srv, "/uploads/maps/tavern.png", &http.Cookie{Name: domain.BroadcastCookieName, Value: key})
	if code != http.StatusOK {
		t.Fatalf("зритель с ключом: статус %d, ожидался 200", code)
	}

	stale := status(t, srv, "/uploads/maps/tavern.png", &http.Cookie{Name: domain.BroadcastCookieName, Value: key + "x"})
	if stale != http.StatusForbidden {
		t.Fatalf("испорченный ключ: статус %d, ожидался 403", stale)
	}
}

// TestUploadsAllowActiveAccount — игрок с сессией видит файлы стола;
// аккаунт, ожидающий одобрения ДМ, — нет.
func TestUploadsAllowActiveAccount(t *testing.T) {
	srv, _, accounts, sessions := uploadsServer(t)
	ctx := context.Background()

	mk := func(id, name, status, token string) *http.Cookie {
		if err := accounts.Create(ctx, &domain.Account{
			ID: id, Username: name, PasswordHash: "x",
			Role: domain.AccountRolePlayer, Status: status, CompanyID: "world-1",
		}); err != nil {
			t.Fatalf("аккаунт %s: %v", name, err)
		}
		if err := sessions.Create(ctx, token, id); err != nil {
			t.Fatalf("сессия %s: %v", name, err)
		}
		return &http.Cookie{Name: domain.SessionCookieName, Value: token}
	}

	active := mk("acc-1", "игрок", domain.AccountStatusActive, "sess-active")
	pending := mk("acc-2", "новичок", domain.AccountStatusPending, "sess-pending")

	if code := status(t, srv, "/uploads/maps/tavern.png", active); code != http.StatusOK {
		t.Fatalf("активный игрок: статус %d, ожидался 200", code)
	}
	if code := status(t, srv, "/uploads/maps/tavern.png", pending); code != http.StatusForbidden {
		t.Fatalf("неодобренный аккаунт: статус %d, ожидался 403", code)
	}
}

// TestBroadcastEntryExchangesKeyForCookie — переход по ссылке трансляции
// оставляет cookie и уводит на адрес без ключа, чтобы секрет не остался в
// адресной строке телевизора.
func TestBroadcastEntryExchangesKeyForCookie(t *testing.T) {
	ctx := context.Background()
	broadcast := service.NewBroadcastService(memory.NewServerStateStore())
	key, err := broadcast.Key(ctx)
	if err != nil {
		t.Fatalf("Key: %v", err)
	}
	api := &apihttp.API{Broadcast: broadcast}

	page := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("страница трансляции"))
	})
	mux := http.NewServeMux()
	mux.Handle("GET /broadcast.html", api.BroadcastEntry(page))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	client := srv.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	resp, err := client.Get(srv.URL + "/broadcast.html?key=" + key)
	if err != nil {
		t.Fatalf("GET со ссылкой: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusSeeOther {
		t.Fatalf("статус %d, ожидался 303", resp.StatusCode)
	}
	if loc := resp.Header.Get("Location"); loc != "/broadcast.html" {
		t.Fatalf("редирект на %q, ожидался чистый /broadcast.html", loc)
	}
	var got string
	for _, c := range resp.Cookies() {
		if c.Name == domain.BroadcastCookieName {
			got = c.Value
		}
	}
	if got != key {
		t.Fatalf("cookie зрителя %q, ожидался ключ %q", got, key)
	}

	// Неверный ключ cookie не выдаёт, но и страницу не прячет — заглушку
	// показывает она сама (см. handleBroadcastAccess).
	bad, err := client.Get(srv.URL + "/broadcast.html?key=подделка")
	if err != nil {
		t.Fatalf("GET с подделкой: %v", err)
	}
	defer func() { _ = bad.Body.Close() }()
	if bad.StatusCode != http.StatusOK {
		t.Fatalf("статус %d, ожидался 200", bad.StatusCode)
	}
	if len(bad.Cookies()) != 0 {
		t.Fatal("подделка получила cookie зрителя")
	}
}
