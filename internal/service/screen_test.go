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
	saved, err := svc.Save(ctx, dm, sc)
	if err != nil {
		t.Fatal(err)
	}
	for _, tab := range saved.Tabs {
		if tab.Kind == domain.ScreenTabTools && tab.Shared {
			t.Fatal("инструменты нельзя открыть игрокам")
		}
	}

	got, err := svc.Get(ctx, gwen)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Tabs) != 2 {
		t.Fatalf("игроку должны прийти «Правила» и «Заметки»: %+v", got.Tabs)
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
	if err != nil || len(got.Tabs) != 3 {
		t.Fatalf("новая ширма — раскладка по умолчанию: %+v, %v", got, err)
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
