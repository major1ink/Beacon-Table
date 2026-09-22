package service

import (
	"strings"
	"testing"

	"beacon-table/internal/domain"
)

// chatClient — RoomClient, который запоминает всё, что ему прислали: тесты
// проверяют не только историю, но и кому что доставили.
type chatClient struct {
	role     domain.ClientRole
	playerID string
	name     string
	got      []any
}

func (c *chatClient) Send(payload any)        { c.got = append(c.got, payload) }
func (c *chatClient) Close()                  {}
func (c *chatClient) Role() domain.ClientRole { return c.role }
func (c *chatClient) PlayerID() string        { return c.playerID }
func (c *chatClient) PlayerName() string      { return c.name }

// messages — тексты полученных "chat_message".
func (c *chatClient) messages() []string {
	var out []string
	for _, p := range c.got {
		m, ok := p.(map[string]any)
		if !ok || m["type"] != "chat_message" {
			continue
		}
		out = append(out, m["message"].(*domain.ChatMessage).Text)
	}
	return out
}

// history — тексты из последнего "chat_history".
func (c *chatClient) history() []string {
	var out []string
	for _, p := range c.got {
		m, ok := p.(map[string]any)
		if !ok || m["type"] != "chat_history" {
			continue
		}
		out = nil
		for _, msg := range m["messages"].([]*domain.ChatMessage) {
			out = append(out, msg.Text)
		}
	}
	return out
}

func chatRoom() (*Room, *chatClient, *chatClient, *chatClient, *chatClient) {
	r := drawingsRoom()
	r.chat = domain.NewChatLog()
	dm := &chatClient{role: domain.RoleDM, playerID: "admin", name: "admin"}
	p1 := &chatClient{role: domain.RolePlayer, playerID: "acc-1", name: "Валера"}
	p2 := &chatClient{role: domain.RolePlayer, playerID: "acc-2", name: "Гость"}
	tv := &chatClient{role: domain.RoleTV}
	for _, c := range []RoomClient{dm, p1, p2, tv} {
		r.clients[c] = true
	}
	return r, dm, p1, p2, tv
}

func TestChatPublicGoesToEveryoneButTV(t *testing.T) {
	r, dm, p1, p2, tv := chatRoom()
	r.handleChatSend(p1, domain.ClientMsg{Type: "chat_send", Text: "  всем привет  "})

	for _, c := range []*chatClient{dm, p1, p2} {
		if got := c.messages(); len(got) != 1 || got[0] != "всем привет" {
			t.Errorf("%s получил %v, ожидалось одно общее сообщение без пробелов по краям", c.name, got)
		}
	}
	if len(tv.got) != 0 {
		t.Error("трансляция не должна получать чат")
	}
	m := r.chat.Messages[0]
	if m.FromID != "acc-1" || m.FromName != "Валера" || m.FromRole != domain.RolePlayer || m.Private() {
		t.Errorf("отправитель проставлен неверно: %+v", m)
	}
	if !r.chatDirty || !r.dirty {
		t.Error("история не помечена к сохранению")
	}
}

func TestChatDMWhisperOnlyToRecipient(t *testing.T) {
	r, dm, p1, p2, _ := chatRoom()
	r.handleChatSend(dm, domain.ClientMsg{Type: "chat_send", Text: "дверь приоткрыта", To: "acc-1"})

	if got := p1.messages(); len(got) != 1 {
		t.Fatalf("адресат не получил личное: %v", got)
	}
	if got := dm.messages(); len(got) != 1 {
		t.Errorf("отправитель не видит своё личное: %v", got)
	}
	if got := p2.messages(); len(got) != 0 {
		t.Errorf("посторонний игрок получил чужое личное: %v", got)
	}
	m := r.chat.Messages[0]
	if m.FromName != "ДМ" || m.FromID != "" || m.To != "acc-1" || m.ToName != "Валера" {
		t.Errorf("шапка личного сообщения: %+v", m)
	}
}

func TestChatPlayerWhisperToPlayerHiddenFromDM(t *testing.T) {
	r, dm, p1, p2, _ := chatRoom()
	r.handleChatSend(p1, domain.ClientMsg{Type: "chat_send", Text: "прикрой меня", To: "acc-2"})

	if got := p2.messages(); len(got) != 1 {
		t.Fatalf("адресат не получил личное: %v", got)
	}
	if got := dm.messages(); len(got) != 0 {
		t.Errorf("ДМ видит личное между игроками: %v", got)
	}
	if r.chat.Messages[0].ToName != "Гость" {
		t.Errorf("имя адресата не снято с сокета: %+v", r.chat.Messages[0])
	}
}

func TestChatPlayerWhisperToDM(t *testing.T) {
	r, dm, p1, p2, _ := chatRoom()
	r.handleChatSend(p1, domain.ClientMsg{Type: "chat_send", Text: "можно переспросить?", To: domain.ChatToDM})

	if got := dm.messages(); len(got) != 1 {
		t.Fatalf("ДМ не получил личное: %v", got)
	}
	if got := p2.messages(); len(got) != 0 {
		t.Errorf("другой игрок получил письмо ведущему: %v", got)
	}
	if r.chat.Messages[0].ToName != "ДМ" {
		t.Errorf("адресат-ведущий подписан как %q", r.chat.Messages[0].ToName)
	}
}

func TestChatRejectsEmptyUnknownAndSelf(t *testing.T) {
	r, dm, p1, _, _ := chatRoom()
	r.handleChatSend(p1, domain.ClientMsg{Type: "chat_send", Text: "   "})
	r.handleChatSend(p1, domain.ClientMsg{Type: "chat_send", Text: "кому?", To: "acc-nobody"})
	r.handleChatSend(p1, domain.ClientMsg{Type: "chat_send", Text: "себе", To: "acc-1"})
	r.handleChatSend(dm, domain.ClientMsg{Type: "chat_send", Text: "себе", To: domain.ChatToDM})
	if len(r.chat.Messages) != 0 {
		t.Errorf("в историю попало %d сообщений, ожидалось 0", len(r.chat.Messages))
	}
}

func TestChatClampsTextAndHistory(t *testing.T) {
	r, _, p1, _, _ := chatRoom()
	r.handleChatSend(p1, domain.ClientMsg{Type: "chat_send", Text: strings.Repeat("я", maxChatTextLen+50)})
	if got := len([]rune(r.chat.Messages[0].Text)); got != maxChatTextLen {
		t.Errorf("текст не обрезан: %d рун", got)
	}
	for i := 0; i < maxChatMessages+10; i++ {
		r.handleChatSend(p1, domain.ClientMsg{Type: "chat_send", Text: "x"})
	}
	if len(r.chat.Messages) != maxChatMessages {
		t.Errorf("история не обрезана: %d сообщений", len(r.chat.Messages))
	}
}

func TestChatHistoryFilteredPerClient(t *testing.T) {
	r, dm, p1, p2, tv := chatRoom()
	r.handleChatSend(p1, domain.ClientMsg{Type: "chat_send", Text: "общее"})
	r.handleChatSend(dm, domain.ClientMsg{Type: "chat_send", Text: "лично Валере", To: "acc-1"})
	r.handleChatSend(p2, domain.ClientMsg{Type: "chat_send", Text: "лично ведущему", To: domain.ChatToDM})
	r.handleChatSend(p1, domain.ClientMsg{Type: "chat_send", Text: "лично Гостю", To: "acc-2"})

	for _, c := range []*chatClient{dm, p1, p2, tv} {
		r.sendChatHistory(c)
	}
	want := map[*chatClient][]string{
		dm: {"общее", "лично Валере", "лично ведущему"},
		p1: {"общее", "лично Валере", "лично Гостю"},
		p2: {"общее", "лично ведущему", "лично Гостю"},
	}
	for c, exp := range want {
		if got := c.history(); strings.Join(got, "|") != strings.Join(exp, "|") {
			t.Errorf("%s видит %v, ожидалось %v", c.name, got, exp)
		}
	}
	if tv.history() != nil {
		t.Error("трансляция получила историю чата")
	}
}

func TestChatClearEmptiesEveryone(t *testing.T) {
	r, dm, p1, _, _ := chatRoom()
	r.handleChatSend(p1, domain.ClientMsg{Type: "chat_send", Text: "было"})
	r.handleChatClear()
	if len(r.chat.Messages) != 0 {
		t.Fatal("история не очищена")
	}
	if got := dm.history(); len(got) != 0 {
		t.Errorf("ДМ после очистки видит %v", got)
	}
	if r.authorize(p1, "chat_clear") {
		t.Error("игроку нельзя чистить чат")
	}
	if !r.authorize(p1, "chat_send") {
		t.Error("игроку можно писать в чат")
	}
}
