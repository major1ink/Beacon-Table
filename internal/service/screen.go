package service

import (
	"context"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"sync"
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
	maxScreenNotice   = 500
)

var screenID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,40}$`)

// ScreenService — ширма ведущего. Игрок получает только открытые ему вкладки
// и только те записи журнала, которые может читать.
type ScreenService interface {
	Get(ctx context.Context, v domain.JournalViewer) (*domain.Screen, error)
	// Save — только ведущий. Значения счётчиков ведёт сервер: из запроса
	// берутся только у новых ячеек.
	Save(ctx context.Context, v domain.JournalViewer, sc domain.Screen) (*domain.Screen, error)
	// Count — засчитать событие стола счётчикам; nil — ни один не сдвинулся.
	Count(ctx context.Context, ev domain.ScreenEvent) (*CounterUpdate, error)
	// StepCounter — ведущий двигает счётчик руками; reset — в ноль и считать снова.
	StepCounter(ctx context.Context, id string, delta int, reset bool) (*CounterUpdate, error)
}

// CounterUpdate — сдвинутые счётчики и сообщения о достигнутых порогах.
type CounterUpdate struct {
	Screen  *domain.Screen
	Cells   []domain.ScreenCell
	Notices []ScreenNotice
}

type ScreenNotice struct {
	From string
	Text string
	ToDM bool
}

type screenService struct {
	// mu — счётчики двигает и комната, и сохранение ширмы из окна.
	mu      sync.Mutex
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
	s.mu.Lock()
	defer s.mu.Unlock()
	prev, err := s.load(ctx)
	if err != nil {
		return nil, err
	}
	keepCounters(prev, clean)
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
			c.Seconds, c.EndsAt, c.Left = 0, 0, 0
		}
		if c.Kind == domain.ScreenCellCounter {
			normalizeCounter(&c)
		} else {
			c = clearCounter(c)
		}
		if c.Kind != domain.ScreenCellTimer && c.Kind != domain.ScreenCellCounter {
			c.Public, c.NoTitle = false, false
		}
		c.EndsAt = max(c.EndsAt, 0)
		c.Left = min(max(c.Left, 0), int64(c.Seconds)*1000)
		cells = append(cells, c)
	}
	return cells, nil
}

func normalizeCounter(c *domain.ScreenCell) {
	switch c.Auto {
	case "", domain.ScreenAutoRound, domain.ScreenAutoTurn, domain.ScreenAutoKilled,
		domain.ScreenAutoRoll, domain.ScreenAutoScene, domain.ScreenAutoCombat:
	default:
		c.Auto = ""
	}
	if c.Who != domain.ScreenWhoPlayers && c.Who != domain.ScreenWhoMonsters ||
		c.Auto != domain.ScreenAutoTurn && c.Auto != domain.ScreenAutoKilled && c.Auto != domain.ScreenAutoRoll {
		c.Who = ""
	}
	if c.Auto != domain.ScreenAutoRoll {
		c.Roll, c.RollMin = "", 0
	} else if c.Roll != domain.ScreenRollNat20 && c.Roll != domain.ScreenRollNat1 {
		c.Roll = domain.ScreenRollMin
		c.RollMin = clampInt(c.RollMin, -maxScreenCounter, maxScreenCounter, c.RollMin)
	} else {
		c.RollMin = 0
	}
	c.Target = min(max(c.Target, 0), maxScreenCounter)
	c.Notice = strings.TrimSpace(clampRunes(c.Notice, maxScreenNotice))
	if c.NoticeTo != domain.ScreenNoticeAll {
		c.NoticeTo = domain.ScreenNoticeDM
	}
	if c.Target == 0 {
		c.Notice, c.Repeat, c.Done, c.ShowTarget = "", false, false, false
	}
}

func clearCounter(c domain.ScreenCell) domain.ScreenCell {
	c.Value, c.Auto, c.Who, c.Roll, c.RollMin = 0, "", "", "", 0
	c.Target, c.Notice, c.NoticeTo, c.Repeat, c.Done, c.ShowTarget = 0, "", "", false, false, false
	return c
}

// keepCounters — значение и отметку порога у знакомых счётчиков берём
// сохранённые: окно ширмы могло не успеть узнать о подсчёте сервера.
func keepCounters(prev, next *domain.Screen) {
	old := map[string]domain.ScreenCell{}
	for _, t := range prev.Tabs {
		for _, c := range t.Cells {
			if c.Kind == domain.ScreenCellCounter {
				old[c.ID] = c
			}
		}
	}
	for _, t := range next.Tabs {
		for i := range t.Cells {
			c := &t.Cells[i]
			p, ok := old[c.ID]
			if c.Kind != domain.ScreenCellCounter || !ok {
				continue
			}
			c.Value = p.Value
			// Поменяли условие или порог — снова считаем.
			c.Done = p.Done && p.Auto == c.Auto && p.Target == c.Target && p.Repeat == c.Repeat
		}
	}
}

func (s *screenService) Count(ctx context.Context, ev domain.ScreenEvent) (*CounterUpdate, error) {
	return s.update(ctx, func(c *domain.ScreenCell) (bool, *ScreenNotice) {
		if !c.Counts(ev) {
			return false, nil
		}
		return true, bump(c, 1)
	})
}

func (s *screenService) StepCounter(ctx context.Context, id string, delta int, reset bool) (*CounterUpdate, error) {
	return s.update(ctx, func(c *domain.ScreenCell) (bool, *ScreenNotice) {
		if c.Kind != domain.ScreenCellCounter || c.ID != id {
			return false, nil
		}
		if reset {
			c.Value, c.Done = 0, false
			return true, nil
		}
		return true, bump(c, delta)
	})
}

// update — пройти по счётчикам; сохраняет, только если что-то сдвинулось.
// UpdatedAt не трогаем: открытая ширма обновит число на месте, не перерисовываясь.
func (s *screenService) update(ctx context.Context, fn func(c *domain.ScreenCell) (bool, *ScreenNotice)) (*CounterUpdate, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sc, err := s.load(ctx)
	if err != nil {
		return nil, err
	}
	up := &CounterUpdate{Screen: sc}
	for _, t := range sc.Tabs {
		for i := range t.Cells {
			changed, n := fn(&t.Cells[i])
			if !changed {
				continue
			}
			up.Cells = append(up.Cells, t.Cells[i])
			if n != nil {
				up.Notices = append(up.Notices, *n)
			}
		}
	}
	if len(up.Cells) == 0 {
		return nil, nil
	}
	if err := s.screens.Save(ctx, sc); err != nil {
		return nil, err
	}
	return up, nil
}

// bump — сдвинуть счётчик; порог срабатывает, когда его перешагнули снизу.
func bump(c *domain.ScreenCell, delta int) *ScreenNotice {
	old := c.Value
	c.Value = min(max(old+delta, -maxScreenCounter), maxScreenCounter)
	if c.Target <= 0 || c.Done || old >= c.Target || c.Value < c.Target {
		return nil
	}
	n := &ScreenNotice{From: c.Title, Text: c.Notice, ToDM: c.NoticeTo != domain.ScreenNoticeAll}
	if n.From == "" {
		n.From = "Счётчик"
	}
	if n.Text == "" {
		n.Text = "Достигнуто " + strconv.Itoa(c.Target)
	}
	if c.Repeat {
		c.Value = 0
	} else {
		c.Done = true
	}
	return n
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
			domain.ScreenCellRoll, domain.ScreenCellTimer, domain.ScreenCellCounter,
			domain.ScreenCellFeed, domain.ScreenCellGraph:
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
