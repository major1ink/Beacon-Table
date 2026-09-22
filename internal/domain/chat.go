package domain

// ChatToDM — адресат «ведущему» в ChatMessage.To/ClientMsg.To. ДМ в чате —
// роль, а не аккаунт (как «ДМ» в логе бросков, см. service.Room.rollerName):
// личное сообщение ведущему уходит на все его сокеты, FromID у его
// сообщений пуст.
const ChatToDM = "dm"

// ChatMessage — одно сообщение чата за столом. Отправителя проставляет
// сервер по сокету (как AuthorID/AuthorName у Drawing), клиент присылает
// только текст и адресата ("chat_send" в ClientMsg).
//
// To пуст — сообщение общее, видят все за столом (кроме трансляции). Иначе
// личное: видят только отправитель и адресат — ChatToDM либо id аккаунта
// игрока. ToName — снимок имени на момент отправки, чтобы история читалась
// и когда адресат уже отключился.
type ChatMessage struct {
	ID       string     `json:"id"`
	At       int64      `json:"at"` // unix-миллисекунды сервера
	FromRole ClientRole `json:"fromRole"`
	FromID   string     `json:"fromId,omitempty"`
	FromName string     `json:"fromName"`
	To       string     `json:"to,omitempty"`
	ToName   string     `json:"toName,omitempty"`
	Text     string     `json:"text"`
}

// Private — личное сообщение (есть адресат).
func (m *ChatMessage) Private() bool { return m.To != "" }

// VisibleTo — видно ли сообщение клиенту с такой ролью/id. Трансляция не
// видит ничего: экран на проекторе — не участник разговора.
func (m *ChatMessage) VisibleTo(role ClientRole, playerID string) bool {
	switch role {
	case RoleDM:
		return !m.Private() || m.FromRole == RoleDM || m.To == ChatToDM
	case RolePlayer:
		return !m.Private() || (m.FromRole == RolePlayer && m.FromID == playerID) || m.To == playerID
	default:
		return false
	}
}
