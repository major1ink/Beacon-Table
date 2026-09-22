// room_chat.go — чат за столом (domain.ChatMessage): ведущий пишет всем или
// одному игроку, игроки — всем, ведущему или друг другу. Отдельный файл по
// той же причине, что room_drawings.go: механика самодостаточная, завязана
// только на r.chatLog и список клиентов.
//
// Всё, что здесь происходит, выполняется в горутине Room.run().
//
// Личное сообщение доставляется только отправителю и адресату — остальные
// его не получают вовсе, а не «получают и прячут»: пересылать то, чего
// клиент видеть не должен, нельзя (см. domain.ChatMessage.VisibleTo). ДМ —
// роль, а не аккаунт: у него может быть несколько сокетов, и все они и
// пишут, и читают как один «ведущий».
//
// История живёт в памяти (r.chatLog) и, если ChatHistoryLimit больше нуля,
// дублируется в базу (r.chatRepo) — синхронно, прямо из актора: одна
// вставка на сообщение, сравнимо с самой рассылкой. В экспорт мира не
// входит: переписка за столом — не контент мира.
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

// maxChatTextLen — предел текста одного сообщения: текст со стороны
// недоверенного клиента, как Label у "roll_dice".
const maxChatTextLen = 2000

// DefaultChatHistory — сколько сообщений хранить, если настройка не задана
// (см. cmd/beacon-table: BEACON_CHAT_HISTORY).
const DefaultChatHistory = 500

// chatSessionCap — потолок истории В ПАМЯТИ, когда хранить на диске
// запрещено (лимит 0): чат живёт до перезапуска, но не растёт бесконечно.
const chatSessionCap = 500

// ChatHistoryLimit — сколько сообщений чата хранить между перезапусками.
// 0 — не хранить: история только в памяти, пока запущен сервер. Меняется на
// лету из формы настроек (см. cmd/beacon-table/settings.go), поэтому
// atomic, а не поле Config.
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

// loadChatLog поднимает историю из базы при старте комнаты. Лимит 0 —
// в базе ничего не держим: то, что осталось от прежней настройки, стираем.
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

// chatCap — сколько сообщений держим в памяти сейчас.
func (r *Room) chatCap() int {
	if n := r.chatLimit.Get(); n > 0 {
		return n
	}
	return chatSessionCap
}

// handleChatSend — "chat_send": проверяет текст и адресата, проставляет
// отправителя по сокету и доставляет тем, кому положено.
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
			return // адресата за столом нет (или пишут сами себе) — молча игнорируем
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

// persistChat пишет сообщение в базу и режет хвост под лимит. Лимит 0 —
// наоборот, чистит то, что могло остаться от прежней настройки (один раз:
// дальше база и так пуста, но DELETE по пустой таблице дёшев).
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

// chatRecipient резолвит адресата личного сообщения по сейчас подключённым
// клиентам: имя берём у сокета, а не у клиента-отправителя (он мог бы
// подписать кого угодно). ДМ не пишет лично сам себе, игрок — тоже.
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

// handleChatClear — "chat_clear" (только ДМ, см. authorize): стирает
// историю у всех. Клиенты получают пустую историю тем же сообщением, что
// и при входе.
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

// sendChatHistory шлёт клиенту историю чата — только те сообщения, что
// ему положено видеть. Трансляции не шлём ничего: у неё чата нет.
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
