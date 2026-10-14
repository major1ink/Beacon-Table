package service

import (
	"context"
	"testing"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository/screenfile"
)

func TestScreenTimersReachTVAndPlayers(t *testing.T) {
	r, dm, p1, _, tv := chatRoom()
	r.rememberScreen(&domain.Screen{Tabs: []domain.ScreenTab{{Kind: domain.ScreenTabGrid, Cells: []domain.ScreenCell{
		{ID: "t1", Kind: domain.ScreenCellTimer, Title: "Ритуал", Seconds: 300, EndsAt: 123, Public: true},
		{ID: "c1", Kind: domain.ScreenCellCounter, Title: "Тревога", Value: 2, Target: 5, ShowTarget: true, Public: true, NoTitle: true},
	}}}})
	r.broadcastScreen()
	for _, c := range []*chatClient{dm, p1, tv} {
		if len(c.got) != 1 {
			t.Fatalf("таймеры не дошли до %v: %v", c.role, c.got)
		}
		msg := c.got[0].(map[string]any)
		timers := msg["timers"].([]domain.ScreenTimer)
		counters := msg["counters"].([]domain.ScreenCounter)
		if msg["type"] != "screen_timers" || len(timers) != 1 || timers[0].Title != "Ритуал" || msg["serverNow"].(int64) == 0 {
			t.Fatalf("не то сообщение: %v", msg)
		}
		if len(counters) != 1 || counters[0] != (domain.ScreenCounter{ID: "c1", Value: 2, Target: 5}) {
			t.Fatalf("счётчик без подписи и с порогом: %+v", counters)
		}
	}
}

func TestPublicOnlyMarked(t *testing.T) {
	sc := domain.Screen{Tabs: []domain.ScreenTab{{Kind: domain.ScreenTabGrid, Cells: []domain.ScreenCell{
		{ID: "a", Kind: domain.ScreenCellTimer, Public: true, Seconds: 60},
		{ID: "b", Kind: domain.ScreenCellTimer, Seconds: 60},
		{ID: "c", Kind: domain.ScreenCellCounter, Value: 3, Target: 9},
		{ID: "d", Kind: domain.ScreenCellCounter, Value: 3, Target: 9, Public: true},
	}}}}
	got := sc.Public()
	if len(got.Timers) != 1 || got.Timers[0].ID != "a" {
		t.Fatalf("в рассылку попал закрытый таймер: %+v", got.Timers)
	}
	if len(got.Counters) != 1 || got.Counters[0] != (domain.ScreenCounter{ID: "d", Title: "Счётчик", Value: 3}) {
		t.Fatalf("закрытый счётчик или порог без ShowTarget: %+v", got.Counters)
	}
}

func counterScreen(cells ...domain.ScreenCell) domain.Screen {
	return domain.Screen{Tabs: []domain.ScreenTab{{ID: "g", Kind: domain.ScreenTabGrid, Title: "Бой", Cells: cells}}}
}

// screenRoom — комната с ширмой на диске и столом для чата.
func screenRoom(t *testing.T, cells ...domain.ScreenCell) (*Room, ScreenService, *chatClient, *chatClient) {
	t.Helper()
	r, dm, p1, _, _ := chatRoom()
	r.dice = &fixedRoller{total: 20}
	svc := NewScreenService(screenfile.NewStore(t.TempDir()), newTestJournal(t))
	if _, err := svc.Save(context.Background(), dm0, counterScreen(cells...)); err != nil {
		t.Fatal(err)
	}
	r.UseScreen(context.Background(), svc)
	return r, svc, dm, p1
}

func counterValue(t *testing.T, svc ScreenService, id string) domain.ScreenCell {
	t.Helper()
	sc, err := svc.Get(context.Background(), dm0)
	if err != nil {
		t.Fatal(err)
	}
	for _, tab := range sc.Tabs {
		for _, c := range tab.Cells {
			if c.ID == id {
				return c
			}
		}
	}
	t.Fatalf("нет ячейки %s", id)
	return domain.ScreenCell{}
}

var dm0 = domain.JournalViewer{IsDM: true}

func TestScreenCounterCountsRoundsAndNotifiesDM(t *testing.T) {
	r, svc, dm, p1 := screenRoom(t,
		domain.ScreenCell{ID: "rounds", Kind: domain.ScreenCellCounter, Title: "Ритуал", Auto: domain.ScreenAutoRound, Target: 2, Notice: "Ритуал завершён"},
		domain.ScreenCell{ID: "turns", Kind: domain.ScreenCellCounter, Auto: domain.ScreenAutoTurn, Who: domain.ScreenWhoPlayers},
	)
	r.combat.Combatants["a"] = &domain.Combatant{ID: "a", Initiative: 20, CharacterID: "ch-1"}
	r.combat.Combatants["b"] = &domain.Combatant{ID: "b", Initiative: 5}

	r.handleStartCombat() // раунд 1, ход a
	r.handleTurnStep(1)   // ход b
	r.handleTurnStep(-1)  // назад не считается
	r.handleTurnStep(1)
	r.handleTurnStep(1) // раунд 2, ход a

	if c := counterValue(t, svc, "rounds"); c.Value != 2 || !c.Done {
		t.Fatalf("раунды: %+v", c)
	}
	if c := counterValue(t, svc, "turns"); c.Value != 2 {
		t.Fatalf("ходы персонажей: %+v", c)
	}
	if got := dm.messages(); len(got) != 1 || got[0] != "Ритуал завершён" {
		t.Fatalf("ведущему: %v", got)
	}
	if got := p1.messages(); len(got) != 0 {
		t.Fatalf("игроку не положено: %v", got)
	}
	if m := r.chatLog[0]; !m.System || m.FromName != "Ритуал" {
		t.Fatalf("системное сообщение: %+v", m)
	}

	r.handleTurnStep(1)
	r.handleTurnStep(1) // раунд 3 — счётчик стоит
	if c := counterValue(t, svc, "rounds"); c.Value != 2 {
		t.Fatalf("после порога счёт стоит: %+v", c)
	}
}

func TestScreenCounterRollsRepeatAndTellsEveryone(t *testing.T) {
	r, svc, dm, p1 := screenRoom(t, domain.ScreenCell{ID: "crit", Kind: domain.ScreenCellCounter,
		Auto: domain.ScreenAutoRoll, Roll: domain.ScreenRollNat20, Who: domain.ScreenWhoPlayers,
		Target: 2, Repeat: true, NoticeTo: domain.ScreenNoticeAll, Public: true})

	r.handleRollDice(dm, domain.ClientMsg{Type: "roll_dice", Formula: "1d20"}) // ведущий не считается
	r.handleRollDice(p1, domain.ClientMsg{Type: "roll_dice", Formula: "1d6"})  // не d20
	r.handleRollDice(p1, domain.ClientMsg{Type: "roll_dice", Formula: "1d20+3"})
	if c := counterValue(t, svc, "crit"); c.Value != 1 {
		t.Fatalf("одна натуральная 20 игрока: %+v", c)
	}
	r.handleRollDice(p1, domain.ClientMsg{Type: "roll_dice", Formula: "d20"})
	if c := counterValue(t, svc, "crit"); c.Value != 0 || c.Done {
		t.Fatalf("порог с повтором — снова с нуля: %+v", c)
	}
	if got := p1.messages(); len(got) != 1 || got[0] != "Достигнуто 2" {
		t.Fatalf("всем: %v", got)
	}
	last := p1.got[len(p1.got)-2].(map[string]any) // перед сообщением в чат — плашка
	if last["type"] != "screen_timers" || len(last["counters"].([]domain.ScreenCounter)) != 1 {
		t.Fatalf("открытый счётчик не разослан: %v", last)
	}
}

func TestScreenCounterKilledSceneAndManualStep(t *testing.T) {
	r, svc, dm, _ := screenRoom(t,
		domain.ScreenCell{ID: "dead", Kind: domain.ScreenCellCounter, Auto: domain.ScreenAutoKilled, Who: domain.ScreenWhoMonsters},
		domain.ScreenCell{ID: "scenes", Kind: domain.ScreenCellCounter, Auto: domain.ScreenAutoScene},
		domain.ScreenCell{ID: "hand", Kind: domain.ScreenCellCounter, Target: 3},
	)
	r.combat.Active = true
	r.killCombatant(&domain.Combatant{ID: "orc"})
	r.killCombatant(&domain.Combatant{ID: "hero", CharacterID: "ch-1"})
	r.scenes["scene-2"] = domain.NewScene("scene-2", "Лес")
	r.switchScene("scene-2")
	r.switchScene("scene-2") // та же — не считается

	r.handleScreenCounter(domain.ClientMsg{Type: "screen_counter", ID: "hand", CounterDelta: 3})
	r.handleScreenCounter(domain.ClientMsg{Type: "screen_counter", ID: "hand", CounterDelta: -1})
	r.handleScreenCounter(domain.ClientMsg{Type: "screen_counter", ID: "hand", CounterDelta: 1}) // порог уже взят

	for id, want := range map[string]int{"dead": 1, "scenes": 1, "hand": 3} {
		if c := counterValue(t, svc, id); c.Value != want {
			t.Errorf("%s: %+v, ждали %d", id, c, want)
		}
	}
	if got := dm.messages(); len(got) != 1 {
		t.Fatalf("порог ручного счётчика — одно сообщение: %v", got)
	}
	r.handleScreenCounter(domain.ClientMsg{Type: "screen_counter", ID: "hand", CounterReset: true})
	if c := counterValue(t, svc, "hand"); c.Value != 0 || c.Done {
		t.Fatalf("сброс: %+v", c)
	}
}
