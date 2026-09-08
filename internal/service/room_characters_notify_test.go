package service

import (
	"testing"

	"beacon-table/internal/domain"
)

// broadcastCharactersChanged — подсказка «перечитай список персонажей» (см.
// NotifyCharactersChanged). Раньше её не было вовсе, и назначенный ДМ
// персонаж появлялся у игрока только после перезагрузки страницы.
//
// Комната собирается напрямую, без actor-горутины — тот же приём, что в
// room_drawings_test.go.

// notifyClient — RoomClient, который только запоминает типы присланного.
type notifyClient struct {
	role domain.ClientRole
	got  []string
}

func (c *notifyClient) Send(payload any) {
	if m, ok := payload.(map[string]any); ok {
		if t, ok := m["type"].(string); ok {
			c.got = append(c.got, t)
		}
	}
}
func (c *notifyClient) Close()                  {}
func (c *notifyClient) Role() domain.ClientRole { return c.role }
func (c *notifyClient) PlayerID() string        { return "" }
func (c *notifyClient) PlayerName() string      { return "" }

func TestCharactersChangedGoesToPlayersAndDMButNotTV(t *testing.T) {
	dm := &notifyClient{role: domain.RoleDM}
	player := &notifyClient{role: domain.RolePlayer}
	tv := &notifyClient{role: domain.RoleTV}

	r := &Room{clients: map[RoomClient]bool{dm: true, player: true, tv: true}}
	r.broadcastCharactersChanged()

	for _, c := range []*notifyClient{dm, player} {
		if len(c.got) != 1 || c.got[0] != "characters_changed" {
			t.Fatalf("роль %v получила %v, ждали одно characters_changed", c.role, c.got)
		}
	}
	// Экран трансляции персонажей не показывает — незачем его будить.
	if len(tv.got) != 0 {
		t.Fatalf("TV получил %v", tv.got)
	}
}

func TestNotifyCharactersChangedDoesNotBlockWithoutRunLoop(t *testing.T) {
	// Отправка неблокирующая: HTTP-хендлер не должен виснуть, если горутина
	// комнаты занята или уже остановлена (буфер канала на 4).
	r := &Room{charactersChanged: make(chan struct{}, 4)}
	for i := 0; i < 10; i++ {
		r.NotifyCharactersChanged()
	}
}
