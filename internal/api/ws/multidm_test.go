package ws_test

import (
	"context"
	"encoding/json"
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

// TestTwoDMsInSameWorld — два разных аккаунта ДМ держат по сокету /ws/dm на
// одном запущенном мире одновременно: оба получают снапшот при подключении,
// правка одного долетает до другого (общее состояние Room, см. room.go: run —
// один поток на комнату, клиенты в map без ролевого синглтона).
func TestTwoDMsInSameWorld(t *testing.T) {
	ctx := context.Background()

	db, err := sqlite.Open(":memory:")
	if err != nil {
		t.Fatalf("sqlite.Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	accounts := sqlite.NewAccountStore(db)
	sessions := sqlite.NewSessionStore(db, accounts)
	root := t.TempDir()
	mgr := app.NewCompanyManager(
		db, sqlite.NewCompanyStore(db), accounts, sessions,
		service.NewDiceRoller(), fstest.MapFS{},
		filepath.Join(root, "data"), filepath.Join(root, "uploads"), "/uploads/", true,
	)

	co, err := mgr.Create(ctx, "Мир", domain.SystemDnD5e2024)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := mgr.Launch(ctx, co.ID); err != nil {
		t.Fatalf("Launch: %v", err)
	}

	mkDM := func(id, name string) string {
		if err := accounts.Create(ctx, &domain.Account{
			ID: id, Username: name, PasswordHash: "x",
			Role: domain.AccountRoleAdmin, Status: domain.AccountStatusActive,
		}); err != nil {
			t.Fatalf("account %s: %v", name, err)
		}
		tok := "sess-" + id
		if err := sessions.Create(ctx, tok, id); err != nil {
			t.Fatalf("session %s: %v", name, err)
		}
		return tok
	}
	tok1 := mkDM("dm-1", "dm")
	tok2 := mkDM("dm-2", "dm2")

	mux := http.NewServeMux()
	apiws.RegisterRoutes(mux, mgr, service.NewAuthService(accounts, sessions),
		service.NewBroadcastService(sqlite.NewServerStateStore(db)), apiws.Options{})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	dialDM := func(tok string) *websocket.Conn {
		u := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws/dm"
		h := http.Header{"Cookie": {domain.SessionCookieName + "=" + tok}}
		c, resp, err := websocket.DefaultDialer.Dial(u, h)
		if resp != nil {
			_ = resp.Body.Close()
		}
		if err != nil {
			code := 0
			if resp != nil {
				code = resp.StatusCode
			}
			t.Fatalf("dial /ws/dm: %v (http %d)", err, code)
		}
		return c
	}

	c1 := dialDM(tok1)
	t.Cleanup(func() { _ = c1.Close() })
	c2 := dialDM(tok2)
	t.Cleanup(func() { _ = c2.Close() })

	waitFor := func(c *websocket.Conn, match func(string) bool, what string) {
		_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
		for {
			_, data, err := c.ReadMessage()
			if err != nil {
				t.Fatalf("не дождались %s: %v", what, err)
			}
			if match(string(data)) {
				return
			}
		}
	}
	isSnapshot := func(s string) bool {
		var m map[string]any
		return json.Unmarshal([]byte(s), &m) == nil && m["type"] == "snapshot"
	}

	// оба сокета приняты и оба получают снапшот сцены
	waitFor(c1, isSnapshot, "снапшот у dm1")
	waitFor(c2, isSnapshot, "снапшот у dm2")

	// dm1 ставит токен → dm2 видит его в следующем снапшоте
	if err := c1.WriteMessage(websocket.TextMessage,
		[]byte(`{"type":"add_token","token":{"id":"tst-1","x":10,"y":10,"size":48,"label":"T","color":"#f00"}}`)); err != nil {
		t.Fatalf("write add_token: %v", err)
	}
	waitFor(c2, func(s string) bool { return strings.Contains(s, "tst-1") },
		"токен от dm1 у dm2")
}
