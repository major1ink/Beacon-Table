// Package ws содержит WebSocket-транспорт стола: разбирает входящие кадры в
// domain.ClientMsg и передаёт их в service.RoomService, транслирует исходящие
// сообщения комнаты обратно в клиента. Как и api/http, не содержит бизнес-
// логики — только протокол поверх gorilla/websocket.
package ws

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/gorilla/websocket"

	"beacon-table/internal/domain"
	"beacon-table/internal/service"
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
		// отвечает 403, нам остаётся записать, с какого адреса пришли — на
		// публичном сервере это первый признак, что кто-то ходит не оттуда.
		//
		//nolint:gosec // G706: заголовок приходит по сети, но печатается
		// через %q — переводы строк и прочие управляющие символы
		// экранируются, подделать лишнюю строку в журнале через него нельзя.
		log.Printf("отклонён WS-хендшейк (origin %q): %v", r.Header.Get("Origin"), err)
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
	defer c.conn.Close()
	for v := range c.out {
		b, err := json.Marshal(v)
		if err != nil {
			continue
		}
		if err := c.conn.WriteMessage(websocket.TextMessage, b); err != nil {
			return
		}
	}
}

func (c *Client) readLoop() {
	defer func() {
		c.room.Leave(c)
		c.conn.Close()
	}()
	for {
		_, raw, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		msg, err := service.DecodeClientMsg(raw)
		if err != nil {
			log.Println("bad message:", err)
			continue
		}
		c.room.Dispatch(c, msg)
	}
}
