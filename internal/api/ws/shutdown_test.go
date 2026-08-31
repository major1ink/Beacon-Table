package ws_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/gorilla/websocket"

	apiws "beacon-table/internal/api/ws"
	"beacon-table/internal/app"
	"beacon-table/internal/domain"
	"beacon-table/internal/repository/sqlite"
	"beacon-table/internal/service"
)

// TestGatewayCloseAllSaysGoodbye — при остановке сервера экраны должны
// получить закрытие с кодом 1012 «сервис перезапускается», а не обрыв
// соединения: http.Server.Shutdown про hijacked-сокеты не знает и сам их не
// трогает, поэтому без Gateway браузер узнавал бы о рестарте только по
// таймауту мёртвого TCP.
func TestGatewayCloseAllSaysGoodbye(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()

	db, err := sqlite.Open(filepath.Join(dir, "beacon.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	accounts := sqlite.NewAccountStore(db)
	sessions := sqlite.NewSessionStore(db, accounts)
	companies := sqlite.NewCompanyStore(db)
	mgr := app.NewCompanyManager(db, companies, accounts, sessions, service.NewDiceRoller(),
		fstest.MapFS{}, filepath.Join(dir, "data"), filepath.Join(dir, "uploads"), "/uploads/", true)
	if err := mgr.Bootstrap(ctx); err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}
	company, err := mgr.Create(ctx, "Мир", domain.SystemDnD5e2024)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := mgr.Launch(ctx, company.ID); err != nil {
		t.Fatalf("Launch: %v", err)
	}
	t.Cleanup(mgr.Shutdown)

	if err := accounts.Create(ctx, &domain.Account{
		ID: "dm-1", Username: "dm", PasswordHash: "x",
		Role: domain.AccountRoleAdmin, Status: domain.AccountStatusActive,
	}); err != nil {
		t.Fatalf("аккаунт: %v", err)
	}
	if err := sessions.Create(ctx, "sess-dm", "dm-1"); err != nil {
		t.Fatalf("сессия: %v", err)
	}

	mux := http.NewServeMux()
	gw := apiws.RegisterRoutes(mux, mgr, service.NewAuthService(accounts, sessions),
		service.NewBroadcastService(sqlite.NewServerStateStore(db)), apiws.Options{})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	conn, resp, err := websocket.DefaultDialer.Dial(
		"ws"+strings.TrimPrefix(srv.URL, "http")+"/ws/dm",
		http.Header{"Cookie": {domain.SessionCookieName + "=sess-dm"}},
	)
	if resp != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("dial /ws/dm: %v", err)
	}
	defer conn.Close()

	// Снапшот при подключении — убеждаемся, что соединение живое и учтено.
	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatalf("SetReadDeadline: %v", err)
	}
	if _, _, err := conn.ReadMessage(); err != nil {
		t.Fatalf("снапшот не пришёл: %v", err)
	}

	gw.CloseAll()

	// Дочитываем то, что уже лежало в очереди (снапшот, состав стола), — нас
	// интересует, чем закончится поток, а не сколько кадров успело прийти.
	for {
		if _, _, err = conn.ReadMessage(); err != nil {
			break
		}
	}
	if !websocket.IsCloseError(err, websocket.CloseServiceRestart) {
		t.Fatalf("соединение закрыто как %v, ожидался код 1012 (сервис перезапускается)", err)
	}
}

// TestGatewayRefusesConnectionsAfterClose — соединение, проскочившее уже
// после начала остановки, не должно повиснуть необорванным: закрывать его
// повторным CloseAll никто не будет.
func TestGatewayRefusesConnectionsAfterClose(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()

	db, err := sqlite.Open(filepath.Join(dir, "beacon.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	accounts := sqlite.NewAccountStore(db)
	sessions := sqlite.NewSessionStore(db, accounts)
	companies := sqlite.NewCompanyStore(db)
	mgr := app.NewCompanyManager(db, companies, accounts, sessions, service.NewDiceRoller(),
		fstest.MapFS{}, filepath.Join(dir, "data"), filepath.Join(dir, "uploads"), "/uploads/", true)
	if err := mgr.Bootstrap(ctx); err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}
	company, err := mgr.Create(ctx, "Мир", domain.SystemDnD5e2024)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := mgr.Launch(ctx, company.ID); err != nil {
		t.Fatalf("Launch: %v", err)
	}
	t.Cleanup(mgr.Shutdown)

	broadcast := service.NewBroadcastService(sqlite.NewServerStateStore(db))
	key, err := broadcast.Key(ctx)
	if err != nil {
		t.Fatalf("Key: %v", err)
	}

	mux := http.NewServeMux()
	gw := apiws.RegisterRoutes(mux, mgr, service.NewAuthService(accounts, sessions), broadcast, apiws.Options{})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	gw.CloseAll()

	conn, resp, err := websocket.DefaultDialer.Dial(
		"ws"+strings.TrimPrefix(srv.URL, "http")+"/ws/view",
		http.Header{"Cookie": {domain.BroadcastCookieName + "=" + key}},
	)
	if resp != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		return // хендшейк не состоялся — тоже приемлемый исход
	}
	defer conn.Close()

	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatalf("SetReadDeadline: %v", err)
	}
	if _, _, err := conn.ReadMessage(); err == nil {
		t.Fatal("соединение, открытое после остановки, осталось живым")
	}
}

// TestHandshakeRejectsForeignOrigin — проверка Origin на настоящем
// хендшейке, а не только в чистой функции: чужая страница с живой cookie
// сессии ДМ не должна получить сокет к столу.
func TestHandshakeRejectsForeignOrigin(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()

	db, err := sqlite.Open(filepath.Join(dir, "beacon.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	accounts := sqlite.NewAccountStore(db)
	sessions := sqlite.NewSessionStore(db, accounts)
	companies := sqlite.NewCompanyStore(db)
	mgr := app.NewCompanyManager(db, companies, accounts, sessions, service.NewDiceRoller(),
		fstest.MapFS{}, filepath.Join(dir, "data"), filepath.Join(dir, "uploads"), "/uploads/", true)
	if err := mgr.Bootstrap(ctx); err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}
	company, err := mgr.Create(ctx, "Мир", domain.SystemDnD5e2024)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := mgr.Launch(ctx, company.ID); err != nil {
		t.Fatalf("Launch: %v", err)
	}
	t.Cleanup(mgr.Shutdown)

	if err := accounts.Create(ctx, &domain.Account{
		ID: "dm-1", Username: "dm", PasswordHash: "x",
		Role: domain.AccountRoleAdmin, Status: domain.AccountStatusActive,
	}); err != nil {
		t.Fatalf("аккаунт: %v", err)
	}
	if err := sessions.Create(ctx, "sess-dm", "dm-1"); err != nil {
		t.Fatalf("сессия: %v", err)
	}

	mux := http.NewServeMux()
	apiws.RegisterRoutes(mux, mgr, service.NewAuthService(accounts, sessions),
		service.NewBroadcastService(sqlite.NewServerStateStore(db)), apiws.Options{})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	dial := func(origin string) (*websocket.Conn, int) {
		h := http.Header{"Cookie": {domain.SessionCookieName + "=sess-dm"}}
		if origin != "" {
			h.Set("Origin", origin)
		}
		conn, resp, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws/dm", h)
		code := 0
		if resp != nil {
			code = resp.StatusCode
			_ = resp.Body.Close()
		}
		if err != nil {
			return nil, code
		}
		return conn, code
	}

	// Чужой сайт: cookie сессии браузер приложил бы сам, но сокета не будет.
	if conn, code := dial("https://злодей.example.net"); conn != nil {
		conn.Close()
		t.Fatalf("чужой origin принят (http %d)", code)
	} else if code != http.StatusForbidden {
		t.Fatalf("чужой origin отклонён с кодом %d, ожидался 403", code)
	}

	// Своя страница — как обычно.
	conn, _ := dial(srv.URL)
	if conn == nil {
		t.Fatal("собственная страница стола не смогла подключиться")
	}
	defer conn.Close()
	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatalf("SetReadDeadline: %v", err)
	}
	if _, _, err := conn.ReadMessage(); err != nil {
		t.Fatalf("снапшот не пришёл: %v", err)
	}
}
