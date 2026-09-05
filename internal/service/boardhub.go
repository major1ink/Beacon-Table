package service

import (
	"context"
	"sync"

	"beacon-table/internal/repository"
)

// BoardHub — живые доски мира: по одной горутине на доску, открытую прямо
// сейчас. Комната заводится на первом подключении и закрывается сама, когда
// её покинул последний (см. boardroom.go).
//
// Права хаб не проверяет — их считает вызывающий по domain.Board и приносит
// готовыми в BoardClient.CanEdit (см. api/ws/board.go). Тот же принцип, что и
// у Room: авторизация выше, актор занимается состоянием.
type BoardHub struct {
	boards repository.BoardRepository

	mu    sync.Mutex
	rooms map[string]*boardRoom
}

func NewBoardHub(boards repository.BoardRepository) *BoardHub {
	return &BoardHub{boards: boards, rooms: map[string]*boardRoom{}}
}

// BoardSession — подключение к конкретной доске. Держит комнату напрямую,
// чтобы каждое сообщение не искало её заново по id и не наткнулось на уже
// закрывшуюся.
type BoardSession struct {
	room   *boardRoom
	client BoardClient
}

func (s *BoardSession) Dispatch(msg BoardMsg) {
	select {
	case s.room.inbound <- boardInbound{client: s.client, msg: msg}:
	case <-s.room.done:
	default:
		// Комната не успевает разгребать — теряем кадр. Для курсора это
		// норма, а правка придёт следующим сообщением: Excalidraw шлёт
		// изменившиеся элементы целиком, а не приращением.
	}
}

func (s *BoardSession) Leave() { s.room.tryLeave(s.client) }

// Open подключает клиента к доске, при необходимости подняв её с диска.
func (h *BoardHub) Open(ctx context.Context, boardID string, c BoardClient) (*BoardSession, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for {
		r, ok := h.rooms[boardID]
		if !ok {
			doc, err := h.boards.Scene(ctx, boardID)
			if err != nil {
				return nil, err
			}
			r = newBoardRoom(boardID, h.boards, doc)
			h.rooms[boardID] = r
		}
		if r.tryJoin(c) {
			return &BoardSession{room: r, client: c}, nil
		}
		// Комната закрылась ровно между поиском и подключением — поднимаем
		// заново.
		delete(h.rooms, boardID)
	}
}

// Shutdown дописывает все открытые доски и гасит их горутины. Зовётся при
// смене мира и остановке сервера — там же, где Room.Shutdown.
func (h *BoardHub) Shutdown() {
	h.mu.Lock()
	rooms := make([]*boardRoom, 0, len(h.rooms))
	for _, r := range h.rooms {
		rooms = append(rooms, r)
	}
	h.rooms = map[string]*boardRoom{}
	h.mu.Unlock()

	for _, r := range rooms {
		r.Shutdown()
	}
}
