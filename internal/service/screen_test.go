package service

import (
	"context"
	"errors"
	"testing"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository/screenfile"
)

func TestScreenPlayerSeesOnlySharedTabsAndReadableNotes(t *testing.T) {
	ctx := context.Background()
	journal := newTestJournal(t)
	svc := NewScreenService(screenfile.NewStore(t.TempDir()), journal)

	open, err := journal.Create(ctx, dm, JournalDraft{Content: "# Отдых\n", Default: domain.JournalObserver})
	if err != nil {
		t.Fatal(err)
	}
	secret, err := journal.Create(ctx, dm, JournalDraft{Content: "# Сцена 3\n", Default: domain.JournalNone})
	if err != nil {
		t.Fatal(err)
	}

	sc := *domain.DefaultScreen()
	for i := range sc.Tabs {
		sc.Tabs[i].Shared = true
		if sc.Tabs[i].Kind == domain.ScreenTabNotes {
			sc.Tabs[i].Cells = []domain.ScreenCell{
				{Kind: domain.ScreenCellJournal, Ref: open.ID},
				{Kind: domain.ScreenCellJournal, Ref: secret.ID},
			}
		}
	}
	if _, err := svc.Save(ctx, dm, sc); err != nil {
		t.Fatal(err)
	}

	got, err := svc.Get(ctx, gwen)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Tabs) != 3 {
		t.Fatalf("игроку должны прийти все открытые вкладки: %+v", got.Tabs)
	}
	for _, tab := range got.Tabs {
		if tab.Kind != domain.ScreenTabNotes {
			continue
		}
		if len(tab.Cells) != 1 || tab.Cells[0].Ref != open.ID {
			t.Fatalf("личная запись ушла игроку: %+v", tab.Cells)
		}
	}

	full, err := svc.Get(ctx, dm)
	if err != nil {
		t.Fatal(err)
	}
	if len(full.Tabs) != 3 || len(full.Tabs[1].Cells) != 2 {
		t.Fatalf("ведущий видит ширму целиком: %+v", full.Tabs)
	}
}

func TestScreenSaveOnlyDM(t *testing.T) {
	svc := NewScreenService(screenfile.NewStore(t.TempDir()), newTestJournal(t))
	if _, err := svc.Save(context.Background(), gwen, *domain.DefaultScreen()); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("игрок сохранил ширму: %v", err)
	}
}

func TestScreenDefaultAndValidation(t *testing.T) {
	ctx := context.Background()
	svc := NewScreenService(screenfile.NewStore(t.TempDir()), newTestJournal(t))
	got, err := svc.Get(ctx, dm)
	if err != nil || len(got.Tabs) != 3 || got.Tabs[2].Kind != domain.ScreenTabGrid {
		t.Fatalf("новая ширма — раскладка по умолчанию, «Инструменты» сеткой: %+v, %v", got, err)
	}
	old := domain.Screen{Tabs: []domain.ScreenTab{{ID: "tools", Kind: domain.ScreenTabTools, Title: "Мои кубы"}}}
	migrated, err := svc.Save(ctx, dm, old)
	if err != nil || migrated.Tabs[0].Kind != domain.ScreenTabGrid || len(migrated.Tabs[0].Cells) != 1 || migrated.Tabs[0].Title != "Мои кубы" {
		t.Fatalf("прежние «Инструменты» должны стать сеткой с броском: %+v, %v", migrated, err)
	}
	bad := domain.Screen{Tabs: []domain.ScreenTab{{ID: "x", Kind: "map", Title: "Карта"}}}
	var verr *domain.ValidationError
	if _, err := svc.Save(ctx, dm, bad); !errors.As(err, &verr) {
		t.Fatalf("неизвестный вид вкладки прошёл: %v", err)
	}
	dup := domain.Screen{Tabs: []domain.ScreenTab{
		{ID: "a", Kind: domain.ScreenTabRules, Title: "Правила"},
		{ID: "a", Kind: domain.ScreenTabNotes, Title: "Заметки"},
	}}
	if _, err := svc.Save(ctx, dm, dup); !errors.As(err, &verr) {
		t.Fatalf("повтор id вкладки прошёл: %v", err)
	}
}

func TestScreenGridCellsAreClamped(t *testing.T) {
	svc := NewScreenService(screenfile.NewStore(t.TempDir()), newTestJournal(t))
	sc := domain.Screen{Tabs: []domain.ScreenTab{{
		ID: "my", Kind: domain.ScreenTabGrid, Title: "Бой", Columns: 9,
		Cells: []domain.ScreenCell{
			{ID: "a", Kind: domain.ScreenCellTimer, W: 20, H: 0, Seconds: 60, Left: 999_999, Value: 5},
			{ID: "a", Kind: domain.ScreenCellCounter, Value: 3},
			{Kind: domain.ScreenCellReference},
		},
	}}}
	saved, err := svc.Save(context.Background(), dm, sc)
	if err != nil {
		t.Fatal(err)
	}
	tab := saved.Tabs[0]
	if tab.Columns != 6 || len(tab.Cells) != 2 {
		t.Fatalf("колонки и пустая ссылка: %+v", tab)
	}
	timer, counter := tab.Cells[0], tab.Cells[1]
	if timer.W != 6 || timer.H != 1 || timer.Left != 60_000 || timer.Value != 0 {
		t.Fatalf("таймер не ужат: %+v", timer)
	}
	if counter.ID == "a" || counter.Value != 3 {
		t.Fatalf("повтор id или счётчик: %+v", counter)
	}
}

func TestScreenCounterSettingsNormalized(t *testing.T) {
	svc := NewScreenService(screenfile.NewStore(t.TempDir()), newTestJournal(t))
	saved, err := svc.Save(context.Background(), dm, counterScreen(
		domain.ScreenCell{ID: "a", Kind: domain.ScreenCellCounter, Auto: "weather", Who: "gods", Roll: "nat20", Target: -4, Notice: "x", NoticeTo: "everyone"},
		domain.ScreenCell{ID: "b", Kind: domain.ScreenCellCounter, Auto: domain.ScreenAutoRoll, Roll: "big", RollMin: 15, Target: 3, Notice: "  Хватит  "},
		domain.ScreenCell{ID: "c", Kind: domain.ScreenCellRoll, Auto: domain.ScreenAutoRound, Target: 3, Public: true, NoTitle: true},
	))
	if err != nil {
		t.Fatal(err)
	}
	a, b, c := saved.Tabs[0].Cells[0], saved.Tabs[0].Cells[1], saved.Tabs[0].Cells[2]
	if a.Auto != "" || a.Who != "" || a.Roll != "" || a.Target != 0 || a.Notice != "" || a.NoticeTo != domain.ScreenNoticeDM {
		t.Fatalf("неизвестное условие и пустой порог: %+v", a)
	}
	if b.Roll != domain.ScreenRollMin || b.RollMin != 15 || b.Notice != "Хватит" {
		t.Fatalf("бросок с итогом: %+v", b)
	}
	if c.Auto != "" || c.Target != 0 || c.Public || c.NoTitle {
		t.Fatalf("не счётчик: %+v", c)
	}
}

func TestScreenSaveKeepsServerCounterValue(t *testing.T) {
	ctx := context.Background()
	svc := NewScreenService(screenfile.NewStore(t.TempDir()), newTestJournal(t))
	cell := domain.ScreenCell{ID: "a", Kind: domain.ScreenCellCounter, Auto: domain.ScreenAutoScene, Target: 1}
	if _, err := svc.Save(ctx, dm, counterScreen(cell)); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Count(ctx, domain.ScreenEvent{Kind: domain.ScreenAutoScene}); err != nil {
		t.Fatal(err)
	}
	// Окно ширмы ещё не знает о подсчёте и шлёт старое значение.
	saved, err := svc.Save(ctx, dm, counterScreen(cell))
	if err != nil {
		t.Fatal(err)
	}
	if got := saved.Tabs[0].Cells[0]; got.Value != 1 || !got.Done {
		t.Fatalf("значение сервера затёрто: %+v", got)
	}
	cell.Target = 5
	saved, _ = svc.Save(ctx, dm, counterScreen(cell))
	if got := saved.Tabs[0].Cells[0]; got.Value != 1 || got.Done {
		t.Fatalf("новый порог — считать снова: %+v", got)
	}
}

func TestD20Faces(t *testing.T) {
	got := d20Faces("2d6+1d20-d20+3", []int{4, 5, 20, 1})
	if len(got) != 2 || got[0] != 20 || got[1] != 1 {
		t.Fatalf("грани d20: %v", got)
	}
}
