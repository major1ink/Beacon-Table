package ws

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/gorilla/websocket"

	"beacon-table/internal/app"
	"beacon-table/internal/domain"
	"beacon-table/internal/service"
)

// board.go — канал одной доски, /ws/board?id=…. Отдельно от /ws/dm и
// /ws/player: те про сцену стола и разведены по ролям, а к доске ходят и ДМ,
// и игроки, и решает тут не роль, а раздача прав самой доски.

// boardClient — реализация service.BoardClient поверх gorilla/websocket.
// Устроен так же, как Client (см. client.go), но своя структура: протокол и
// набор полей другие.
type boardClient struct {
	conn    *websocket.Conn
	out     chan any
	id      string
	name    string
	canEdit bool
}

func (c *boardClient) Send(v any) {
	select {
	case c.out <- v:
	default:
		// Не успевает читать — теряем кадр, но хаб не держим.
	}
}

func (c *boardClient) Close()              { close(c.out) }
func (c *boardClient) AccountID() string   { return c.id }
func (c *boardClient) AccountName() string { return c.name }
func (c *boardClient) CanEdit() bool       { return c.canEdit }

// registerBoardRoute навешивает /ws/board. Доступ считает BoardService по
// domain.JournalViewer — тот же расчёт, что и у HTTP-ручек доски: не видно —
// 404, видно только название — 403, «чтение» пускает наблюдателем.
func registerBoardRoute(mux *http.ServeMux, mgr *app.CompanyManager, auth service.AuthService, gw *Gateway) {
	mux.HandleFunc("/ws/board", func(w http.ResponseWriter, r *http.Request) {
		acc, err := sessionAccount(auth, r)
		if err != nil || !acc.IsActive() {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		world := mgr.Current()
		if world == nil {
			http.Error(w, "world not running", http.StatusServiceUnavailable)
			return
		}
		boardID := r.URL.Query().Get("id")
		if boardID == "" {
			http.Error(w, "нет доски", http.StatusBadRequest)
			return
		}
		v := domain.JournalViewer{ID: acc.ID, Name: acc.Username, IsDM: acc.IsGM()}
		b, err := world.Boards.Get(r.Context(), v, boardID)
		if err != nil {
			http.Error(w, "доска не найдена", http.StatusNotFound)
			return
		}
		if !b.CanRead(v) {
			http.Error(w, "нет доступа к доске", http.StatusForbidden)
			return
		}
		serveBoardWs(gw, world.BoardSync, boardID, w, r, acc.ID, acc.Username, b.CanEdit(v))
	})
}

func serveBoardWs(gw *Gateway, hub *service.BoardHub, boardID string, w http.ResponseWriter, r *http.Request, accountID, accountName string, canEdit bool) {
	conn, err := gw.upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Warn("отклонён WS-хендшейк доски", "origin", r.Header.Get("Origin"), "err", err)
		return
	}
	if !gw.track(conn) {
		conn.Close()
		return
	}
	defer gw.untrack(conn)

	c := &boardClient{conn: conn, out: make(chan any, 32), id: accountID, name: accountName, canEdit: canEdit}
	session, err := hub.Open(r.Context(), boardID, c)
	if err != nil {
		conn.Close()
		return
	}
	defer session.Leave()

	go boardWriteLoop(c)
	boardReadLoop(c, session)
}

func boardWriteLoop(c *boardClient) {
	ping := time.NewTicker(pingEvery)
	defer func() {
		ping.Stop()
		c.conn.Close()
	}()
	for {
		select {
		case v, ok := <-c.out:
			if !ok {
				_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
				_ = c.conn.WriteMessage(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
				return
			}
			b, err := json.Marshal(v)
			if err != nil {
				continue
			}
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.TextMessage, b); err != nil {
				return
			}
		case <-ping.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func boardReadLoop(c *boardClient, session *service.BoardSession) {
	defer c.conn.Close()

	c.conn.SetReadLimit(maxClientFrame)
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		_, raw, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
		var msg service.BoardMsg
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}
		session.Dispatch(msg)
	}
}
