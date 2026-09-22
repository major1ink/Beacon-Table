// room_chat.go — чат за столом (domain.ChatMessage). Выполняется в горутине
// Room.run(). Личное уходит только отправителю и адресату — не «всем и
// спрятать» (см. ChatMessage.VisibleTo). ДМ — роль, не аккаунт: все его
// сокеты — один «ведущий». История в памяти (r.chatLog), при лимите > 0
// дублируется в базу синхронно из актора. В экспорт мира не входит.
package service

import (
	"context"
	"log/slog"
	"strings"
	"sync/atomic"
	"time"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository"
)

// maxChatTextLen — текст со стороны недоверенного клиента, как Label у "roll_dice".
const maxChatTextLen = 2000

// DefaultChatHistory — сколько хранить, если BEACON_CHAT_HISTORY не задан.
const DefaultChatHistory = 500

// chatSessionCap — потолок в памяти при лимите 0, чтобы история не росла бесконечно.
const chatSessionCap = 500

// ChatHistoryLimit — сколько сообщений хранить между перезапусками; 0 — только
// в памяти. Atomic: меняется на лету из формы настроек.
type ChatHistoryLimit struct{ n atomic.Int64 }

func NewChatHistoryLimit(n int) *ChatHistoryLimit {
	l := &ChatHistoryLimit{}
	l.Set(n)
	return l
}

func (l *ChatHistoryLimit) Set(n int) {
	if n < 0 {
		n = 0
	}
	l.n.Store(int64(n))
}

func (l *ChatHistoryLimit) Get() int {
	if l == nil {
		return 0
	}
	return int(l.n.Load())
}

// loadChatLog поднимает историю при старте; при лимите 0 стирает остатки прежней настройки.
func loadChatLog(repo repository.ChatRepository, limit *ChatHistoryLimit) ([]*domain.ChatMessage, error) {
	if repo == nil {
		return []*domain.ChatMessage{}, nil
	}
	ctx := context.Background()
	if limit.Get() == 0 {
		return []*domain.ChatMessage{}, repo.Clear(ctx)
	}
	if err := repo.Trim(ctx, limit.Get()); err != nil {
		return nil, err
	}
	return repo.List(ctx)
}

func (r *Room) chatCap() int {
	if n := r.chatLimit.Get(); n > 0 {
		return n
	}
	return chatSessionCap
}

// handleChatSend — "chat_send": отправителя ставит сервер по сокету.
func (r *Room) handleChatSend(from RoomClient, msg domain.ClientMsg) {
	text := strings.TrimSpace(clampRunes(msg.Text, maxChatTextLen))
	if text == "" {
		return
	}
	m := &domain.ChatMessage{
		ID:       newID(),
		At:       time.Now().UnixMilli(),
		FromRole: from.Role(),
		FromName: from.PlayerName(),
		Text:     text,
	}
	if from.Role() == domain.RoleDM {
		m.FromName = "ДМ"
	} else {
		m.FromID = from.PlayerID()
	}
	if msg.To != "" {
		toName, ok := r.chatRecipient(from, msg.To)
		if !ok {
			return // адресата нет за столом или пишут себе
		}
		m.To, m.ToName = msg.To, toName
	}
	r.chatLog = append(r.chatLog, m)
	if cap := r.chatCap(); len(r.chatLog) > cap {
		r.chatLog = r.chatLog[len(r.chatLog)-cap:]
	}
	r.persistChat(m)

	payload := map[string]any{"type": "chat_message", "message": m}
	for c := range r.clients {
		if m.VisibleTo(c.Role(), c.PlayerID()) {
			c.Send(payload)
		}
	}
}

// persistChat пишет в базу и режет хвост; при лимите 0 чистит остатки прежней настройки.
func (r *Room) persistChat(m *domain.ChatMessage) {
	if r.chatRepo == nil {
		return
	}
	ctx := context.Background()
	limit := r.chatLimit.Get()
	if limit == 0 {
		if err := r.chatRepo.Clear(ctx); err != nil {
			slog.Warn("Не удалось очистить историю чата", "err", err)
		}
		return
	}
	if err := r.chatRepo.Add(ctx, m); err != nil {
		slog.Warn("Не удалось сохранить сообщение чата", "err", err)
		return
	}
	if err := r.chatRepo.Trim(ctx, limit); err != nil {
		slog.Warn("Не удалось обрезать историю чата", "err", err)
	}
}

// chatRecipient — адресат среди подключённых; имя берём у его сокета, не у
// отправителя. Себе лично не пишут.
func (r *Room) chatRecipient(from RoomClient, to string) (string, bool) {
	if to == domain.ChatToDM {
		if from.Role() == domain.RoleDM {
			return "", false
		}
		for c := range r.clients {
			if c.Role() == domain.RoleDM {
				return "ДМ", true
			}
		}
		return "", false
	}
	if from.Role() == domain.RolePlayer && from.PlayerID() == to {
		return "", false
	}
	for c := range r.clients {
		if c.Role() == domain.RolePlayer && c.PlayerID() == to {
			return c.PlayerName(), true
		}
	}
	return "", false
}

// handleChatClear — "chat_clear" (только ДМ): всем уходит пустая история.
func (r *Room) handleChatClear() {
	r.chatLog = []*domain.ChatMessage{}
	if r.chatRepo != nil {
		if err := r.chatRepo.Clear(context.Background()); err != nil {
			slog.Warn("Не удалось очистить историю чата", "err", err)
		}
	}
	for c := range r.clients {
		r.sendChatHistory(c)
	}
}

// sendChatHistory — только видимое этому клиенту; трансляции ничего.
func (r *Room) sendChatHistory(c RoomClient) {
	if c.Role() == domain.RoleTV {
		return
	}
	visible := make([]*domain.ChatMessage, 0, len(r.chatLog))
	for _, m := range r.chatLog {
		if m.VisibleTo(c.Role(), c.PlayerID()) {
			visible = append(visible, m)
		}
	}
	c.Send(map[string]any{"type": "chat_history", "messages": visible})
}
