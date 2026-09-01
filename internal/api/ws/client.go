// Package ws содержит WebSocket-транспорт стола: разбирает входящие кадры в
// domain.ClientMsg и передаёт их в service.RoomService, транслирует исходящие
// сообщения комнаты обратно в клиента. Как и api/http, не содержит бизнес-
// логики — только протокол поверх gorilla/websocket.
package ws

import (
	"encoding/json"
	"log"
	"log/slog"
	"net/http"
	"time"

	"github.com/gorilla/websocket"

	"beacon-table/internal/domain"
	"beacon-table/internal/service"
)

const (
	maxClientFrame = 1 << 20
	writeWait = 10 * time.Second
)

var (
	pongWait = 60 * time.Second
	pingEvery = 15 * time.Second
)

// Client — одно WS-подключение; реализация service.RoomClient для
// транспорта на базе gorilla/websocket. PlayerID/PlayerName заполнены для
// RoleDM и RolePlayer из аккаунта, к которому привязана cookie сессии —
// playerID это Account.ID, стабильный между устройствами и реконнектами.
type Client struct {
	conn       *websocket.Conn
	room       service.RoomService
	out        chan any
	role       domain.ClientRole
	playerID   string
	playerName string
}

// Send implements service.RoomClient.
func (c *Client) Send(v any) {
	select {
	case c.out <- v:
	default:
		// клиент не успевает читать — не блокируем хаб, просто теряем кадр
		// состояния (следующий snapshot/delta его всё равно догонит по факту)
	}
}

// Close implements service.RoomClient. Room зовёт его при обработке leave —
// закрывает исходящую очередь, что останавливает writeLoop.
func (c *Client) Close() { close(c.out) }

// Role implements service.RoomClient.
func (c *Client) Role() domain.ClientRole { return c.role }

// PlayerID implements service.RoomClient.
func (c *Client) PlayerID() string { return c.playerID }

// PlayerName implements service.RoomClient.
func (c *Client) PlayerName() string { return c.playerName }

func serveWs(gw *Gateway, room service.RoomService, w http.ResponseWriter, r *http.Request, role domain.ClientRole, playerID, playerName string) {
	conn, err := gw.upgrader.Upgrade(w, r, nil)
	if err != nil {
		// Сюда же попадает отказ по Origin (см. checkOrigin): gorilla сам
		// отвечает 403, мы дописываем адрес и Origin в журнал.
		//
		slog.Warn("отклонён WS-хендшейк", "origin", r.Header.Get("Origin"), "err", err)
		return
	}
	// Соединение под присмотром Gateway до самого конца — иначе остановка
	// сервера не смогла бы его закрыть (см. Gateway.CloseAll).
	if !gw.track(conn) {
		conn.Close() // сервер уже останавливается — подключаться некуда
		return
	}
	defer gw.untrack(conn)

	c := &Client{conn: conn, room: room, out: make(chan any, 16), role: role, playerID: playerID, playerName: playerName}
	room.Join(c)

	go c.writeLoop()
	c.readLoop() // блокирует до дисконнекта
}

func (c *Client) writeLoop() {
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

func (c *Client) readLoop() {
	defer func() {
		c.room.Leave(c)
		c.conn.Close()
	}()

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
		msg, err := service.DecodeClientMsg(raw)
		if err != nil {
			log.Println("bad message:", err)
			continue
		}
		c.room.Dispatch(c, msg)
	}
}
