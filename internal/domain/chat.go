package domain

// ChatToDM — адресат «ведущему». ДМ в чате — роль, не аккаунт: FromID пуст,
// личное ему уходит на все его сокеты.
const ChatToDM = "dm"

// ChatMessage — сообщение чата. Отправителя ставит сервер по сокету. To пуст —
// общее; иначе личное (ChatToDM или id игрока), видят только двое. ToName —
// снимок имени: адресат мог уже отключиться.
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

// VisibleTo — видно ли клиенту с такой ролью/id; трансляции — ничего.
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
