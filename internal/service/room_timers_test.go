package service

import (
	"testing"

	"beacon-table/internal/domain"
)

func TestScreenTimersReachTVAndPlayers(t *testing.T) {
	r, dm, p1, _, tv := chatRoom()
	r.SetScreenTimers([]domain.ScreenTimer{{ID: "t1", Title: "Ритуал", Seconds: 300, EndsAt: 123}})
	r.broadcastTimers()
	for _, c := range []*chatClient{dm, p1, tv} {
		if len(c.got) != 1 {
			t.Fatalf("таймеры не дошли до %v: %v", c.role, c.got)
		}
		msg := c.got[0].(map[string]any)
		timers := msg["timers"].([]domain.ScreenTimer)
		if msg["type"] != "screen_timers" || len(timers) != 1 || timers[0].Title != "Ритуал" || msg["serverNow"].(int64) == 0 {
			t.Fatalf("не то сообщение: %v", msg)
		}
	}
}

func TestPublicTimersOnlyMarked(t *testing.T) {
	sc := domain.Screen{Tabs: []domain.ScreenTab{{Kind: domain.ScreenTabGrid, Cells: []domain.ScreenCell{
		{ID: "a", Kind: domain.ScreenCellTimer, Public: true, Seconds: 60},
		{ID: "b", Kind: domain.ScreenCellTimer, Seconds: 60},
	}}}}
	if got := sc.PublicTimers(); len(got) != 1 || got[0].ID != "a" {
		t.Fatalf("в рассылку попал закрытый таймер: %+v", got)
	}
}
