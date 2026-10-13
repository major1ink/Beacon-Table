package service

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository"
)

const (
	maxScreenTabs     = 20
	maxScreenCells    = 200
	maxScreenTabTitle = 60
	maxScreenRef      = 200
)

var screenTabID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,40}$`)

// ScreenService — ширма ведущего. Игрок получает только открытые ему вкладки
// и только те записи журнала, которые может читать.
type ScreenService interface {
	Get(ctx context.Context, v domain.JournalViewer) (*domain.Screen, error)
	// Save — только ведущий.
	Save(ctx context.Context, v domain.JournalViewer, sc domain.Screen) (*domain.Screen, error)
}

type screenService struct {
	screens repository.ScreenRepository
	journal JournalService
}

func NewScreenService(screens repository.ScreenRepository, journal JournalService) ScreenService {
	return &screenService{screens: screens, journal: journal}
}

func (s *screenService) load(ctx context.Context) (*domain.Screen, error) {
	sc, err := s.screens.Get(ctx)
	if errors.Is(err, domain.ErrNotFound) {
		return domain.DefaultScreen(), nil
	}
	return sc, err
}

func (s *screenService) Get(ctx context.Context, v domain.JournalViewer) (*domain.Screen, error) {
	sc, err := s.load(ctx)
	if err != nil || v.IsDM {
		return sc, err
	}
	out := &domain.Screen{Tabs: []domain.ScreenTab{}, UpdatedAt: sc.UpdatedAt}
	for _, t := range sc.Tabs {
		if !t.Shared || !t.Shareable() {
			continue
		}
		cells := make([]domain.ScreenCell, 0, len(t.Cells))
		for _, c := range t.Cells {
			if c.Kind == domain.ScreenCellJournal && !s.canRead(ctx, v, c.Ref) {
				continue
			}
			cells = append(cells, c)
		}
		t.Cells = cells
		out.Tabs = append(out.Tabs, t)
	}
	return out, nil
}

func (s *screenService) canRead(ctx context.Context, v domain.JournalViewer, id string) bool {
	e, err := s.journal.Get(ctx, v, id)
	return err == nil && e.CanRead(v)
}

func (s *screenService) Save(ctx context.Context, v domain.JournalViewer, sc domain.Screen) (*domain.Screen, error) {
	if !v.IsDM {
		return nil, domain.ErrForbidden
	}
	clean, err := normalizeScreen(sc)
	if err != nil {
		return nil, err
	}
	clean.UpdatedAt = time.Now()
	if err := s.screens.Save(ctx, clean); err != nil {
		return nil, err
	}
	return clean, nil
}

func normalizeScreen(sc domain.Screen) (*domain.Screen, error) {
	if len(sc.Tabs) == 0 || len(sc.Tabs) > maxScreenTabs {
		return nil, &domain.ValidationError{Msg: "у ширмы должно быть от 1 до 20 вкладок"}
	}
	out := &domain.Screen{Tabs: make([]domain.ScreenTab, 0, len(sc.Tabs))}
	seen := map[string]bool{}
	for _, t := range sc.Tabs {
		if !screenTabID.MatchString(t.ID) || seen[t.ID] {
			return nil, &domain.ValidationError{Msg: "неверный id вкладки ширмы"}
		}
		seen[t.ID] = true
		switch t.Kind {
		case domain.ScreenTabRules, domain.ScreenTabNotes, domain.ScreenTabTools:
		default:
			return nil, &domain.ValidationError{Msg: "неизвестный вид вкладки ширмы"}
		}
		t.Title = strings.TrimSpace(t.Title)
		if t.Title == "" || len([]rune(t.Title)) > maxScreenTabTitle {
			return nil, &domain.ValidationError{Msg: "название вкладки — от 1 до 60 символов"}
		}
		t.Shared = t.Shared && t.Shareable()
		if len(t.Cells) > maxScreenCells {
			return nil, &domain.ValidationError{Msg: "слишком много ячеек на вкладке"}
		}
		cells := make([]domain.ScreenCell, 0, len(t.Cells))
		refs := map[domain.ScreenCell]bool{}
		for _, c := range t.Cells {
			if c.Kind != domain.ScreenCellJournal && c.Kind != domain.ScreenCellReference {
				return nil, &domain.ValidationError{Msg: "неизвестный вид ячейки ширмы"}
			}
			c.Ref = strings.TrimSpace(c.Ref)
			if c.Ref == "" || len(c.Ref) > maxScreenRef || refs[c] {
				continue
			}
			refs[c] = true
			cells = append(cells, c)
		}
		t.Cells = cells
		out.Tabs = append(out.Tabs, t)
	}
	return out, nil
}
