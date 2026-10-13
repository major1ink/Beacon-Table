package service

import (
	"context"
	"testing"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository/sessionfile"
)

// sessionEvents — тексты событий ленты, дошедших до клиента.
func sessionEvents(c *chatClient) []string {
	var out []string
	for _, m := range c.got {
		if msg, ok := m.(map[string]any); ok && msg["type"] == "session_event" {
			out = append(out, msg["event"].(domain.SessionEvent).Text)
		}
	}
	return out
}

func TestRoomSessionFeedRespectsVisibility(t *testing.T) {
	r, dm, p1, p2, tv := chatRoom()
	r.dice = &fixedRoller{total: 15}
	svc, _ := newTestSessionLog(t, t.TempDir())
	r.UseSessions(svc)

	// Без начатой сессии лента молчит.
	r.handleRollDice(p1, domain.ClientMsg{Formula: "1d20"})
	if len(sessionEvents(dm)) != 0 {
		t.Fatal("событие без сессии")
	}

	r.handleSession(domain.ClientMsg{Type: "session_start"})
	hidden := true
	r.handleRollDice(p1, domain.ClientMsg{Formula: "1d20", Label: "Скрытность", Hidden: &hidden})
	r.handleSession(domain.ClientMsg{Type: "session_note", Text: "Тобиас врёт"})
	r.combat.Combatants["g"] = &domain.Combatant{ID: "g", Name: "Гоблин", HPCurrent: 10, HPMax: 10}
	delta := -7
	r.handleSetCombatantHP("g", nil, nil, nil, &delta)

	want := map[*chatClient][]string{
		dm: {"Сессия 1", "Валера: Скрытность", "Тобиас врёт", "Гоблин: урон 7 (3/10)"},
		p1: {"Сессия 1", "Валера: Скрытность", "Гоблин: тяжело ранен"},
		p2: {"Сессия 1", "Гоблин: тяжело ранен"},
		tv: nil,
	}
	for c, w := range want {
		if got := sessionEvents(c); len(got) != len(w) || (len(w) > 0 && got[len(got)-1] != w[len(w)-1]) || (len(w) > 1 && got[1] != w[1]) {
			t.Errorf("%v %s: %v, ждали %v", c.role, c.name, got, w)
		}
	}
	evs, _ := svc.Events(context.Background(), "2026-10-13", false, "acc-2")
	if len(evs) != 2 {
		t.Fatalf("в файле для игрока: %+v", evs)
	}
}

func TestSessionFileStoreRejectsBadID(t *testing.T) {
	s := sessionfile.NewStore(t.TempDir())
	if err := s.Append(context.Background(), "../x", domain.SessionEvent{}); err == nil {
		t.Fatal("id с путём")
	}
}
