package service

import (
	"context"
	"strings"
	"testing"
	"time"

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

// Конец таймера ширмы — в ленту один раз; закрытый от игроков таймер видит
// только ведущий. Кончившийся до запуска сервера задним числом не пишется.
func TestRoomSessionLogsTimerEnd(t *testing.T) {
	ctx := context.Background()
	now := time.Now().UnixMilli()
	r, svc, dm, p1 := screenRoom(t,
		domain.ScreenCell{ID: "old", Kind: domain.ScreenCellTimer, Title: "Вчерашний", Seconds: 60, EndsAt: now - 5000, Public: true},
	)
	sessions, _ := newTestSessionLog(t, t.TempDir())
	r.UseSessions(sessions)
	r.handleSession(domain.ClientMsg{Type: "session_start"})
	r.logTimers() // снимок при запуске сервера
	r.logTimerEnds(now)
	if got := sessionEvents(dm); len(got) != 1 {
		t.Fatalf("таймер, кончившийся без сервера, попал в ленту: %v", got)
	}

	if _, err := svc.Save(ctx, dm0, counterScreen(
		domain.ScreenCell{ID: "dawn", Kind: domain.ScreenCellTimer, Title: "До рассвета", Seconds: 60, EndsAt: now + 60000},
		domain.ScreenCell{ID: "bell", Kind: domain.ScreenCellTimer, Title: "Колокол", Seconds: 30, EndsAt: now + 30000, Public: true},
	)); err != nil {
		t.Fatal(err)
	}
	r.logTimers()
	r.logTimerEnds(now + 31000)
	r.logTimerEnds(now + 61000)
	r.logTimerEnds(now + 62000)

	ends := func(c *chatClient) []string {
		var out []string
		for _, s := range sessionEvents(c) {
			if strings.HasSuffix(s, "время вышло") {
				out = append(out, s)
			}
		}
		return out
	}
	if got := ends(dm); strings.Join(got, " | ") != "Таймер «Колокол»: время вышло | Таймер «До рассвета»: время вышло" {
		t.Fatalf("ведущему: %v", sessionEvents(dm))
	}
	if got := ends(p1); strings.Join(got, " | ") != "Таймер «Колокол»: время вышло" {
		t.Fatalf("игроку: %v", sessionEvents(p1))
	}
}
