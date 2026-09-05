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

// boardTestbed — запущенный мир с одной доской и поднятым HTTP-сервером.
type boardTestbed struct {
	srv     *httptest.Server
	boardID string
	world   *app.ActiveWorld
	dm      string // токен сессии ДМ
	// newPlayer заводит ещё один аккаунт и возвращает его токен сессии.
	newPlayer func(id, name, role string) string
}

func newBoardTestbed(t *testing.T) *boardTestbed {
	t.Helper()
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
		filepath.Join(root, "data"), filepath.Join(root, "uploads"), "/uploads/", true, nil,
	)
	co, err := mgr.Create(ctx, "Мир", domain.SystemDnD5e2024)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := mgr.Launch(ctx, co.ID); err != nil {
		t.Fatalf("Launch: %v", err)
	}

	mkAccount := func(id, name, role string) string {
		if err := accounts.Create(ctx, &domain.Account{
			ID: id, Username: name, PasswordHash: "x",
			Role: role, Status: domain.AccountStatusActive, CompanyID: co.ID,
		}); err != nil {
			t.Fatalf("account %s: %v", name, err)
		}
		tok := "sess-" + id
		if err := sessions.Create(ctx, tok, id); err != nil {
			t.Fatalf("session %s: %v", name, err)
		}
		return tok
	}
	dmTok := mkAccount("dm-1", "dm", domain.AccountRoleAdmin)

	mux := http.NewServeMux()
	apiws.RegisterRoutes(mux, mgr, service.NewAuthService(accounts, sessions),
		service.NewBroadcastService(sqlite.NewServerStateStore(db)), apiws.Options{})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	world := mgr.Current()
	// Доска, открытая всем за столом: иначе игроку её не видно и проверять
	// совместную правку не на чем.
	b, err := world.Boards.Create(ctx, domain.JournalViewer{ID: "dm-1", Name: "dm", IsDM: true},
		service.BoardDraft{Name: "Схема", Default: domain.JournalOwner})
	if err != nil {
		t.Fatalf("создать доску: %v", err)
	}

	tb := &boardTestbed{srv: srv, boardID: b.ID, world: world, dm: dmTok}
	tb.newPlayer = mkAccount
	return tb
}

func (tb *boardTestbed) dial(t *testing.T, tok, boardID string) (*websocket.Conn, int) {
	t.Helper()
	u := "ws" + strings.TrimPrefix(tb.srv.URL, "http") + "/ws/board?id=" + boardID
	h := http.Header{"Cookie": {domain.SessionCookieName + "=" + tok}}
	c, resp, err := websocket.DefaultDialer.Dial(u, h)
	code := 0
	if resp != nil {
		code = resp.StatusCode
		_ = resp.Body.Close()
	}
	if err != nil {
		return nil, code
	}
	t.Cleanup(func() { _ = c.Close() })
	return c, code
}

func readUntil(t *testing.T, c *websocket.Conn, match func(map[string]any) bool, what string) map[string]any {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		_, data, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("не дождались %s: %v", what, err)
		}
		var m map[string]any
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		if match(m) {
			return m
		}
	}
}

func ofType(typ string) func(map[string]any) bool {
	return func(m map[string]any) bool { return m["type"] == typ }
}

// Правка ДМа долетает до игрока по настоящему каналу и ложится в файл.
func TestBoardWsRelaysBetweenAccounts(t *testing.T) {
	tb := newBoardTestbed(t)
	playerTok := tb.newPlayer("pl-1", "Гвен", domain.AccountRolePlayer)

	dm, code := tb.dial(t, tb.dm, tb.boardID)
	if dm == nil {
		t.Fatalf("ДМ не подключился к доске (http %d)", code)
	}
	pl, code := tb.dial(t, playerTok, tb.boardID)
	if pl == nil {
		t.Fatalf("игрок не подключился к доске (http %d)", code)
	}
	readUntil(t, dm, ofType("board_snapshot"), "снимок у ДМ")
	readUntil(t, pl, ofType("board_snapshot"), "снимок у игрока")

	err := dm.WriteMessage(websocket.TextMessage, []byte(
		`{"type":"board_change","elements":[{"id":"r1","type":"rectangle","x":5,"y":5,"width":10,"height":10,"version":1,"versionNonce":7}]}`))
	if err != nil {
		t.Fatalf("write board_change: %v", err)
	}

	got := readUntil(t, pl, ofType("board_change"), "правка у игрока")
	els, _ := got["elements"].([]any)
	if len(els) != 1 {
		t.Fatalf("игрок получил не ту правку: %+v", got)
	}

	// Закрываем оба окна — комната обязана дописать доску на диск.
	_ = dm.Close()
	_ = pl.Close()
	deadline := time.Now().Add(3 * time.Second)
	for {
		doc, err := tb.world.Boards.Scene(context.Background(),
			domain.JournalViewer{ID: "dm-1", Name: "dm", IsDM: true}, tb.boardID)
		if err == nil && len(doc.Scene.Elements) == 1 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("правка не доехала до файла после закрытия окон")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// К чужой закрытой доске не пускают, даже зная её id.
func TestBoardWsRejectsForeignBoard(t *testing.T) {
	tb := newBoardTestbed(t)
	playerTok := tb.newPlayer("pl-2", "Том", domain.AccountRolePlayer)

	// Личная доска ДМа — игроку её не видно вовсе.
	priv, err := tb.world.Boards.Create(context.Background(),
		domain.JournalViewer{ID: "dm-1", Name: "dm", IsDM: true},
		service.BoardDraft{Name: "Личная", Default: domain.JournalNone})
	if err != nil {
		t.Fatal(err)
	}
	if c, code := tb.dial(t, playerTok, priv.ID); c != nil {
		t.Fatalf("игрока пустили на чужую доску (http %d)", code)
	} else if code != http.StatusNotFound {
		t.Errorf("код отказа = %d, ожидался 404", code)
	}
}

// Без сессии — вообще никуда.
func TestBoardWsRequiresAccount(t *testing.T) {
	tb := newBoardTestbed(t)
	if c, code := tb.dial(t, "нет-такой-сессии", tb.boardID); c != nil {
		t.Fatalf("пустили без сессии (http %d)", code)
	} else if code != http.StatusForbidden {
		t.Errorf("код отказа = %d, ожидался 403", code)
	}
}
