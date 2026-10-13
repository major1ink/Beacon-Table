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
	maxScreenColumns  = 6
	maxScreenRows     = 6
	maxScreenCounter  = 1_000_000
	maxScreenTimer    = 7 * 24 * 3600
)

var screenID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,40}$`)

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
	if err != nil {
		return nil, err
	}
	for i, t := range sc.Tabs {
		if t.Kind == domain.ScreenTabTools {
			sc.Tabs[i] = withShared(domain.ToolsTab(t.ID, t.Title), t.Shared)
		}
	}
	return sc, nil
}

func withShared(t domain.ScreenTab, shared bool) domain.ScreenTab {
	t.Shared = shared
	return t
}

func (s *screenService) Get(ctx context.Context, v domain.JournalViewer) (*domain.Screen, error) {
	sc, err := s.load(ctx)
	if err != nil || v.IsDM {
		return sc, err
	}
	out := &domain.Screen{Tabs: []domain.ScreenTab{}, UpdatedAt: sc.UpdatedAt}
	for _, t := range sc.Tabs {
		if !t.Shared {
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
		if !screenID.MatchString(t.ID) || seen[t.ID] {
			return nil, &domain.ValidationError{Msg: "неверный id вкладки ширмы"}
		}
		seen[t.ID] = true
		if t.Kind == domain.ScreenTabTools {
			t = withShared(domain.ToolsTab(t.ID, t.Title), t.Shared)
		}
		switch t.Kind {
		case domain.ScreenTabRules, domain.ScreenTabNotes, domain.ScreenTabGrid:
		default:
			return nil, &domain.ValidationError{Msg: "неизвестный вид вкладки ширмы"}
		}
		t.Title = strings.TrimSpace(t.Title)
		if t.Title == "" || len([]rune(t.Title)) > maxScreenTabTitle {
			return nil, &domain.ValidationError{Msg: "название вкладки — от 1 до 60 символов"}
		}
		if t.Kind == domain.ScreenTabGrid {
			t.Columns = clampInt(t.Columns, 1, maxScreenColumns, 3)
		} else {
			t.Columns = 0
		}
		if len(t.Cells) > maxScreenCells {
			return nil, &domain.ValidationError{Msg: "слишком много ячеек на вкладке"}
		}
		cells, err := normalizeCells(t)
		if err != nil {
			return nil, err
		}
		t.Cells = cells
		out.Tabs = append(out.Tabs, t)
	}
	return out, nil
}

func normalizeCells(t domain.ScreenTab) ([]domain.ScreenCell, error) {
	cells := make([]domain.ScreenCell, 0, len(t.Cells))
	refs := map[string]bool{}
	ids := map[string]bool{}
	for _, c := range t.Cells {
		if !cellAllowed(t.Kind, c.Kind) {
			return nil, &domain.ValidationError{Msg: "неизвестный вид ячейки ширмы"}
		}
		c.Ref = strings.TrimSpace(c.Ref)
		if c.Kind == domain.ScreenCellJournal || c.Kind == domain.ScreenCellReference {
			if c.Ref == "" || len(c.Ref) > maxScreenRef {
				continue
			}
		} else {
			c.Ref = ""
		}
		if t.Kind != domain.ScreenTabGrid {
			// В готовых вкладках ячейка — просто ссылка, повторы не нужны.
			key := c.Kind + "|" + c.Ref
			if refs[key] {
				continue
			}
			refs[key] = true
			cells = append(cells, domain.ScreenCell{Kind: c.Kind, Ref: c.Ref})
			continue
		}
		if !screenID.MatchString(c.ID) || ids[c.ID] {
			c.ID = newID()
		}
		ids[c.ID] = true
		c.Title = strings.TrimSpace(c.Title)
		if r := []rune(c.Title); len(r) > maxScreenTabTitle {
			c.Title = string(r[:maxScreenTabTitle])
		}
		c.W = clampInt(c.W, 1, t.Columns, 1)
		c.H = clampInt(c.H, 1, maxScreenRows, 1)
		c.Value = clampInt(c.Value, -maxScreenCounter, maxScreenCounter, c.Value)
		c.Seconds = clampInt(c.Seconds, 0, maxScreenTimer, 0)
		if c.Kind != domain.ScreenCellTimer {
			c.Seconds, c.EndsAt, c.Left, c.Public = 0, 0, 0, false
		}
		if c.Kind != domain.ScreenCellCounter {
			c.Value = 0
		}
		c.EndsAt = max(c.EndsAt, 0)
		c.Left = min(max(c.Left, 0), int64(c.Seconds)*1000)
		cells = append(cells, c)
	}
	return cells, nil
}

func cellAllowed(tab, cell string) bool {
	switch tab {
	case domain.ScreenTabNotes:
		return cell == domain.ScreenCellJournal
	case domain.ScreenTabRules:
		return cell == domain.ScreenCellReference || cell == domain.ScreenCellJournal
	case domain.ScreenTabGrid:
		switch cell {
		case domain.ScreenCellJournal, domain.ScreenCellReference, domain.ScreenCellConditions,
			domain.ScreenCellRoll, domain.ScreenCellTimer, domain.ScreenCellCounter:
			return true
		}
	}
	return false
}

// clampInt — v в [lo, hi]; ноль (не задано) превращается в def.
func clampInt(v, lo, hi, def int) int {
	if v == 0 {
		v = def
	}
	return min(max(v, lo), hi)
}
