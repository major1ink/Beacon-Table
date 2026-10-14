package service

import (
	"context"
	"strings"
	"testing"
	"time"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository/journalfile"
	"beacon-table/internal/repository/sessionfile"
)

func newTestSessionLog(t *testing.T, dir string) (*sessionLog, JournalService) {
	t.Helper()
	journal := NewJournalService(journalfile.NewStore(t.TempDir()))
	s := NewSessionLogService(context.Background(), sessionfile.NewStore(dir), journal).(*sessionLog)
	at := time.Date(2026, 10, 13, 19, 0, 0, 0, time.Local)
	s.now = func() time.Time { at = at.Add(time.Minute); return at }
	return s, journal
}

func TestSessionLogWritesOnlyWhileActive(t *testing.T) {
	ctx := context.Background()
	s, _ := newTestSessionLog(t, t.TempDir())
	if _, ok := s.Append(ctx, domain.SessionEvent{Kind: domain.SessionRoll, Text: "до сессии"}); ok {
		t.Fatal("без сессии событие не пишется")
	}
	info, _, err := s.Start(ctx, "")
	if err != nil || info.ID != "2026-10-13" || info.Title != "Сессия 1" {
		t.Fatalf("старт: %+v %v", info, err)
	}
	if _, _, err := s.Start(ctx, ""); err == nil {
		t.Fatal("вторая сессия поверх идущей")
	}
	ev, ok := s.Append(ctx, domain.SessionEvent{Kind: domain.SessionRoll, Text: "Марго: атака"})
	if !ok || ev.Seq != 2 {
		t.Fatalf("событие: %+v %v", ev, ok)
	}
	if _, err := s.End(ctx); err != nil {
		t.Fatal(err)
	}
	if _, ok := s.Append(ctx, domain.SessionEvent{Kind: domain.SessionRoll}); ok {
		t.Fatal("после конца сессии событие не пишется")
	}
	// Вторая сессия в тот же день — свой файл.
	info, _, _ = s.Start(ctx, "")
	if info.ID != "2026-10-13-2" || info.Title != "Сессия 2" {
		t.Fatalf("вторая за день: %+v", info)
	}
	list, _ := s.List(ctx)
	if len(list) != 2 || !list[0].Active || list[1].Active || list[1].Events != 3 {
		t.Fatalf("список: %+v", list)
	}
}

func TestSessionLogResumesAfterRestart(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s, _ := newTestSessionLog(t, dir)
	s.Start(ctx, "")
	s.Append(ctx, domain.SessionEvent{Kind: domain.SessionNote, Text: "a"})

	again, _ := newTestSessionLog(t, dir)
	ev, ok := again.Append(ctx, domain.SessionEvent{Kind: domain.SessionNote, Text: "b"})
	if !ok || ev.Seq != 3 {
		t.Fatalf("сессия не продолжилась: %+v %v", ev, ok)
	}
}

// Игрок видит ленту, как чат: без скрытых бросков (кроме своих), без заметок
// ведущего и без хитов врагов.
func TestSessionLogPlayerView(t *testing.T) {
	ctx := context.Background()
	s, _ := newTestSessionLog(t, t.TempDir())
	info, _, _ := s.Start(ctx, "")
	total := 17
	s.Append(ctx, domain.SessionEvent{Kind: domain.SessionRoll, Text: "ДМ: засада", Total: &total, Secret: true})
	s.Append(ctx, domain.SessionEvent{Kind: domain.SessionRoll, Text: "Лиара: скрытность", Total: &total, Secret: true, OwnerID: "liara"})
	s.Append(ctx, domain.SessionEvent{Kind: domain.SessionNote, Text: "Тобиас врёт", Secret: true})
	s.Append(ctx, domain.SessionEvent{Kind: domain.SessionHP, Text: "Гоблин: −7 (3/10)", PublicText: "Гоблин тяжело ранен", Amount: -7})

	texts := func(evs []domain.SessionEvent) string {
		var out []string
		for _, e := range evs[1:] {
			out = append(out, e.Text)
		}
		return strings.Join(out, " | ")
	}
	liara, _ := s.Events(ctx, info.ID, false, "liara")
	if got := texts(liara); got != "Лиара: скрытность | Гоблин тяжело ранен" || liara[2].Amount != 0 {
		t.Fatalf("лента Лиары: %s", got)
	}
	tom, _ := s.Events(ctx, info.ID, false, "tom")
	if got := texts(tom); got != "Гоблин тяжело ранен" {
		t.Fatalf("лента Тома: %s", got)
	}
	dm, _ := s.Events(ctx, info.ID, true, "")
	if len(dm) != 5 || dm[4].Text != "Гоблин: −7 (3/10)" {
		t.Fatalf("лента ведущего: %+v", dm)
	}
}

func TestSessionSummaryToJournal(t *testing.T) {
	ctx := context.Background()
	s, journal := newTestSessionLog(t, t.TempDir())
	info, _, _ := s.Start(ctx, "")
	total := 12
	s.Append(ctx, domain.SessionEvent{Kind: domain.SessionScene, Scene: "Колокольня", Text: "Сцена: Колокольня"})
	s.Append(ctx, domain.SessionEvent{Kind: domain.SessionRoll, Scene: "Колокольня", Text: "Марго: атака", Total: &total, Formula: "1d20+3"})
	s.Append(ctx, domain.SessionEvent{Kind: domain.SessionCombat, Scene: "Колокольня", Round: 1, Text: "Бой начался"})
	s.Append(ctx, domain.SessionEvent{Kind: domain.SessionTurn, Scene: "Колокольня", Round: 1, Text: "Ход: Гоблин"})
	s.End(ctx)

	id, _, err := s.Summary(ctx, info.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	e, err := journal.Get(ctx, domain.JournalViewer{IsDM: true}, id)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"# Сессия 1 — 13 октября 2026", "## Колокольня", "Марго: атака — **12** (1d20+3)", "**Раунд 1**"} {
		if !strings.Contains(e.Content, want) {
			t.Fatalf("в итоге нет %q:\n%s", want, e.Content)
		}
	}
	if strings.Contains(e.Content, "Ход:") || e.Folder != "Сессии" || e.IsShared() {
		t.Fatalf("итог: %+v", e)
	}
	list, _ := s.List(ctx)
	if list[0].SummaryID != id {
		t.Fatalf("итог не отмечен в списке: %+v", list[0])
	}
}

// Итог уже есть — кнопка ведёт в ту же запись, правки ведущего не теряются;
// пересборка переписывает её, удалённая запись делается заново.
func TestSessionSummaryReusesEntry(t *testing.T) {
	ctx := context.Background()
	s, journal := newTestSessionLog(t, t.TempDir())
	dm := domain.JournalViewer{IsDM: true}
	info, _, _ := s.Start(ctx, "")
	s.Append(ctx, domain.SessionEvent{Kind: domain.SessionNote, Text: "Тобиас врёт"})
	s.End(ctx)

	first, changed, err := s.Summary(ctx, info.ID, false)
	if err != nil || !changed {
		t.Fatalf("первый итог: %v %v", changed, err)
	}
	if _, err := journal.Update(ctx, dm, first, "# Сессия 1\n\nПравка ведущего"); err != nil {
		t.Fatal(err)
	}
	again, changed, _ := s.Summary(ctx, info.ID, false)
	e, _ := journal.Get(ctx, dm, first)
	if again != first || changed || !strings.Contains(e.Content, "Правка ведущего") {
		t.Fatalf("повторный итог: %s %v %q", again, changed, e.Content)
	}
	rebuilt, changed, _ := s.Summary(ctx, info.ID, true)
	e, _ = journal.Get(ctx, dm, first)
	if rebuilt != first || !changed || !strings.Contains(e.Content, "Тобиас врёт") {
		t.Fatalf("пересборка: %s %v %q", rebuilt, changed, e.Content)
	}
	all, _ := journal.List(ctx, dm)
	if len(all) != 1 {
		t.Fatalf("записей итога: %d", len(all))
	}

	if err := journal.Delete(ctx, dm, first); err != nil {
		t.Fatal(err)
	}
	fresh, changed, _ := s.Summary(ctx, info.ID, false)
	list, _ := s.List(ctx)
	if fresh == first || !changed || list[0].SummaryID != fresh {
		t.Fatalf("итог после удаления: %s %v %+v", fresh, changed, list[0])
	}
}
