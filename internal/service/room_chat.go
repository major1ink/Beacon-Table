// room_chat.go — чат за столом (domain.ChatMessage): ведущий пишет всем или
// одному игроку, игроки — всем, ведущему или друг другу. Отдельный файл по
// той же причине, что room_drawings.go: механика самодостаточная, завязана
// только на r.chat и список клиентов.
//
// Всё, что здесь происходит, выполняется в горутине Room.run().
//
// Личное сообщение доставляется только отправителю и адресату — остальные
// его не получают вовсе, а не «получают и прячут»: пересылать то, чего
// клиент видеть не должен, нельзя (см. domain.ChatMessage.VisibleTo). ДМ —
// роль, а не аккаунт: у него может быть несколько сокетов, и все они и
// пишут, и читают как один «ведущий».
package service

import (
	"strings"
	"time"

	"beacon-table/internal/domain"
)

// maxChatTextLen — предел текста одного сообщения: текст со стороны
// недоверенного клиента, как Label у "roll_dice".
const maxChatTextLen = 2000

// maxChatMessages — сколько сообщений держим в истории. Хвост обрезается
// при добавлении: история едет каждому подключившемуся целиком (см.
// sendChatHistory), и бесконечный лог сессий за год раздул бы и chat.json,
// и первый пакет при входе.
const maxChatMessages = 500

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
	r.chat.Messages = append(r.chat.Messages, m)
	if len(r.chat.Messages) > maxChatMessages {
		r.chat.Messages = r.chat.Messages[len(r.chat.Messages)-maxChatMessages:]
	}
	r.chatDirty = true
	r.dirty = true

	payload := map[string]any{"type": "chat_message", "message": m}
	for c := range r.clients {
		if m.VisibleTo(c.Role(), c.PlayerID()) {
			c.Send(payload)
		}
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
	r.chat.Messages = []*domain.ChatMessage{}
	r.chatDirty = true
	r.dirty = true
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
	visible := make([]*domain.ChatMessage, 0, len(r.chat.Messages))
	for _, m := range r.chat.Messages {
		if m.VisibleTo(c.Role(), c.PlayerID()) {
			visible = append(visible, m)
		}
	}
	c.Send(map[string]any{"type": "chat_history", "messages": visible})
}
