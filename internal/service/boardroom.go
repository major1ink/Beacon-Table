// boardroom.go — живая доска: те, кто открыл её прямо сейчас, и
// авторитетный набор элементов холста.
//
// Отдельно от Room: та про сцену стола, а доска к сцене не привязана и живёт
// в своём окне. Общее у них только устройство — актор с горутиной, вся
// работа внутри run(), снаружи только каналы.
//
// Правки принимаются поэлементно и сверяются по version/versionNonce — так
// сам Excalidraw разрешает конфликты при совместной правке, и поля эти мы
// храним с самого импорта. Пишет файл ТОЛЬКО сервер: клиентского PUT на
// холст больше нет, иначе двое за одной доской снова затирали бы друг друга.
package service

import (
	"context"
	"log/slog"
	"time"

	"beacon-table/internal/excalidraw"
	"beacon-table/internal/repository"
)

// boardAutosave — как часто сбрасывать накопленные правки на диск. Реже, чем
// у сцены: доска не переживает бой, а файл переписывается целиком.
const boardAutosave = 3 * time.Second

// maxBoardFrameElements — сколько элементов принимаем в одном сообщении.
// Excalidraw шлёт только изменившиеся, так что счёт идёт на единицы; предел —
// защита от залипшего клиента, который начнёт слать всю доску на каждый кадр.
const maxBoardFrameElements = 2000

// BoardClient — одно подключение к доске (см. api/ws).
type BoardClient interface {
	Send(v any)
	Close()
	AccountID() string
	AccountName() string
	// CanEdit — вправе ли этот человек менять холст. Считается один раз при
	// подключении по domain.Board (см. api/ws/board.go) и дальше не меняется:
	// права переписывают редко, а переподключиться после этого недорого.
	CanEdit() bool
}

type boardInbound struct {
	client BoardClient
	msg    BoardMsg
}

// boardLeave — отключение с распиской. done закрывается, когда комната уже
// разобрала уход и, если ушёл последний, дописала доску на диск: закрытие
// окна не должно возвращать управление раньше, чем правка сохранена.
type boardLeave struct {
	client BoardClient
	done   chan struct{}
}

// BoardMsg — то, что приходит от клиента доски. Своя структура, а не
// domain.ClientMsg: канал другой, и мешать протокол стола с протоколом доски
// незачем.
type BoardMsg struct {
	Type string `json:"type"`
	// Elements — изменившиеся элементы целиком (удалённые приходят с
	// isDeleted, Excalidraw их не выбрасывает).
	Elements []*excalidraw.Element `json:"elements,omitempty"`
	// Курсор и выделение соседа: не хранятся и на диск не попадают.
	X        float64  `json:"x,omitempty"`
	Y        float64  `json:"y,omitempty"`
	Selected []string `json:"selected,omitempty"`
}

type boardRoom struct {
	id     string
	boards repository.BoardRepository

	doc      *excalidraw.Document
	order    []string // порядок элементов, как в файле
	elements map[string]*excalidraw.Element

	clients  map[BoardClient]bool
	join     chan BoardClient
	leave    chan boardLeave
	inbound  chan boardInbound
	shutdown chan chan struct{}

	dirty bool
	// done закрывается, когда горутина доски вышла: по нему Join и Leave
	// отличают живую комнату от уже закрывшейся, не пытаясь писать в её
	// каналы (см. tryJoin).
	done chan struct{}
}

func newBoardRoom(id string, boards repository.BoardRepository, doc *excalidraw.Document) *boardRoom {
	r := &boardRoom{
		id:       id,
		boards:   boards,
		doc:      doc,
		elements: map[string]*excalidraw.Element{},
		clients:  map[BoardClient]bool{},
		join:     make(chan BoardClient),
		leave:    make(chan boardLeave),
		inbound:  make(chan boardInbound, 64),
		shutdown: make(chan chan struct{}),
		done:     make(chan struct{}),
	}
	for _, e := range doc.Scene.Elements {
		if e == nil || e.ID == "" {
			continue
		}
		if _, seen := r.elements[e.ID]; seen {
			continue
		}
		r.elements[e.ID] = e
		r.order = append(r.order, e.ID)
	}
	go r.run()
	return r
}

// tryJoin/tryLeave — «если комната ещё жива». Комната закрывается сама,
// когда её покинул последний, и подключение, пришедшее в этот же миг, иначе
// повисло бы на записи в канал навсегда.
func (r *boardRoom) tryJoin(c BoardClient) bool {
	select {
	case r.join <- c:
		return true
	case <-r.done:
		return false
	}
}

func (r *boardRoom) tryLeave(c BoardClient) {
	done := make(chan struct{})
	select {
	case r.leave <- boardLeave{client: c, done: done}:
		<-done
	case <-r.done:
	}
}

func (r *boardRoom) run() {
	ticker := time.NewTicker(boardAutosave)
	defer ticker.Stop()
	defer close(r.done)

	for {
		select {
		case c := <-r.join:
			r.clients[c] = true
			c.Send(map[string]any{
				"type":     "board_snapshot",
				"elements": r.scene().Elements,
				"canEdit":  c.CanEdit(),
			})
			r.broadcastPeers()

		case l := <-r.leave:
			if !r.clients[l.client] {
				close(l.done)
				continue
			}
			delete(r.clients, l.client)
			l.client.Close()
			// Ушедший мог оставить курсор на чужих экранах.
			r.broadcast(nil, map[string]any{"type": "board_peer_left", "id": l.client.AccountID()})
			r.broadcastPeers()
			if len(r.clients) == 0 {
				r.flushIfDirty()
				close(l.done)
				return
			}
			close(l.done)

		case in := <-r.inbound:
			r.handle(in.client, in.msg)

		case <-ticker.C:
			r.flushIfDirty()

		case done := <-r.shutdown:
			r.flushIfDirty()
			for c := range r.clients {
				c.Close()
			}
			r.clients = nil
			close(done)
			return
		}
	}
}

func (r *boardRoom) handle(c BoardClient, msg BoardMsg) {
	switch msg.Type {
	case "board_change":
		if !c.CanEdit() || len(msg.Elements) == 0 || len(msg.Elements) > maxBoardFrameElements {
			return
		}
		accepted := make([]*excalidraw.Element, 0, len(msg.Elements))
		for _, e := range msg.Elements {
			if e == nil || e.ID == "" {
				continue
			}
			if !r.apply(e) {
				continue
			}
			accepted = append(accepted, e)
		}
		if len(accepted) == 0 {
			return
		}
		r.dirty = true
		// Отправителю не шлём: у него эта правка уже есть, а эхо заставило
		// бы Excalidraw перерисовать сцену под рукой рисующего.
		r.broadcast(c, map[string]any{"type": "board_change", "elements": accepted})

	case "board_cursor":
		r.broadcast(c, map[string]any{
			"type":     "board_cursor",
			"id":       c.AccountID(),
			"name":     c.AccountName(),
			"x":        msg.X,
			"y":        msg.Y,
			"selected": msg.Selected,
		})
	}
}

// apply — правило Excalidraw для совместной правки: побеждает больший
// version, при равном — больший versionNonce. Так два клиента, применившие
// правки в разном порядке, приходят к одному и тому же холсту.
func (r *boardRoom) apply(e *excalidraw.Element) bool {
	cur, ok := r.elements[e.ID]
	if !ok {
		r.elements[e.ID] = e
		r.order = append(r.order, e.ID)
		return true
	}
	if e.Version < cur.Version {
		return false
	}
	if e.Version == cur.Version && e.VersionNonce <= cur.VersionNonce {
		return false
	}
	r.elements[e.ID] = e
	return true
}

// scene собирает сцену в порядке файла.
func (r *boardRoom) scene() *excalidraw.Scene {
	s := *r.doc.Scene
	s.Elements = make([]*excalidraw.Element, 0, len(r.order))
	for _, id := range r.order {
		if e, ok := r.elements[id]; ok {
			s.Elements = append(s.Elements, e)
		}
	}
	return &s
}

func (r *boardRoom) flushIfDirty() {
	if !r.dirty {
		return
	}
	doc := *r.doc
	doc.Scene = r.scene()
	if _, err := r.boards.SetScene(context.Background(), r.id, &doc); err != nil {
		slog.Error("не удалось сохранить доску, попробую ещё раз позже", "board", r.id, "err", err)
		return
	}
	r.dirty = false
}

// broadcast шлёт всем, кроме except (nil — вообще всем).
func (r *boardRoom) broadcast(except BoardClient, v any) {
	for c := range r.clients {
		if c == except {
			continue
		}
		c.Send(v)
	}
}

func (r *boardRoom) broadcastPeers() {
	peers := make([]map[string]any, 0, len(r.clients))
	for c := range r.clients {
		peers = append(peers, map[string]any{"id": c.AccountID(), "name": c.AccountName()})
	}
	r.broadcast(nil, map[string]any{"type": "board_peers", "peers": peers})
}

// Shutdown дописывает доску и завершает горутину. Уже закрывшаяся комната
// просто ничего не делает.
func (r *boardRoom) Shutdown() {
	done := make(chan struct{})
	select {
	case r.shutdown <- done:
		<-done
	case <-r.done:
	}
}
