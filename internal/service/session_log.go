package service

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository"
)

// SessionLogService — лента сессии: идёт ли сессия, дописать событие,
// прочитать ленту глазами игрока или ведущего, сделать итог в журнал.
// Пишет одна комната (её горутина), читают HTTP-хендлеры — отсюда мьютекс.
type SessionLogService interface {
	// Active — идущая сессия, если есть.
	Active() (domain.SessionInfo, bool)
	// Start — scene: сцена стола в момент начала, с неё лента и начинается.
	Start(ctx context.Context, scene string) (domain.SessionInfo, domain.SessionEvent, error)
	End(ctx context.Context) (domain.SessionEvent, error)
	// Append — дописать в идущую сессию; false — сессия не идёт, событие
	// никуда не пишется.
	Append(ctx context.Context, ev domain.SessionEvent) (domain.SessionEvent, bool)
	List(ctx context.Context) ([]domain.SessionInfo, error)
	Events(ctx context.Context, id string, isDM bool, playerID string) ([]domain.SessionEvent, error)
	// Summary — итог сессии записью журнала ведущего; возвращает её id.
	Summary(ctx context.Context, id string) (string, error)
}

type sessionLog struct {
	repo    repository.SessionLogRepository
	journal JournalService
	now     func() time.Time

	mu     sync.Mutex
	active string
	title  string
	seq    int
}

// NewSessionLogService — journal нужен только для итога.
func NewSessionLogService(ctx context.Context, repo repository.SessionLogRepository, journal JournalService) SessionLogService {
	s := &sessionLog{repo: repo, journal: journal, now: time.Now}
	// Сессия, которую не закончили (сервер выключили посреди игры), идёт
	// дальше после перезапуска.
	if ids, err := repo.IDs(ctx); err == nil && len(ids) > 0 {
		last := ids[len(ids)-1]
		if evs, err := repo.Events(ctx, last); err == nil && len(evs) > 0 {
			info := sessionInfo(last, evs)
			if info.Active {
				s.active, s.title, s.seq = last, info.Title, evs[len(evs)-1].Seq
			}
		}
	}
	return s
}

func (s *sessionLog) Active() (domain.SessionInfo, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active == "" {
		return domain.SessionInfo{}, false
	}
	return domain.SessionInfo{ID: s.active, Title: s.title, Active: true}, true
}

func (s *sessionLog) Start(ctx context.Context, scene string) (domain.SessionInfo, domain.SessionEvent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active != "" {
		return domain.SessionInfo{}, domain.SessionEvent{}, &domain.ValidationError{Msg: "сессия уже идёт"}
	}
	ids, err := s.repo.IDs(ctx)
	if err != nil {
		return domain.SessionInfo{}, domain.SessionEvent{}, err
	}
	now := s.now()
	id := now.Format("2006-01-02")
	taken := map[string]bool{}
	for _, x := range ids {
		taken[x] = true
	}
	for n := 2; taken[id]; n++ {
		id = now.Format("2006-01-02") + "-" + strconv.Itoa(n)
	}
	title := fmt.Sprintf("Сессия %d", len(ids)+1)
	ev := domain.SessionEvent{Seq: 1, At: now.UnixMilli(), Kind: domain.SessionStart, Scene: scene, Text: title}
	if err := s.repo.Append(ctx, id, ev); err != nil {
		return domain.SessionInfo{}, domain.SessionEvent{}, err
	}
	s.active, s.title, s.seq = id, title, 1
	return domain.SessionInfo{ID: id, Title: title, StartedAt: ev.At, Active: true, Events: 1}, ev, nil
}

func (s *sessionLog) End(ctx context.Context) (domain.SessionEvent, error) {
	ev, ok := s.Append(ctx, domain.SessionEvent{Kind: domain.SessionEnd, Text: "Сессия закончена"})
	if !ok {
		return ev, &domain.ValidationError{Msg: "сессия не идёт"}
	}
	s.mu.Lock()
	s.active, s.title = "", ""
	s.mu.Unlock()
	return ev, nil
}

func (s *sessionLog) Append(ctx context.Context, ev domain.SessionEvent) (domain.SessionEvent, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active == "" {
		return ev, false
	}
	s.seq++
	ev.Seq = s.seq
	ev.At = s.now().UnixMilli()
	if err := s.repo.Append(ctx, s.active, ev); err != nil {
		s.seq--
		return ev, false
	}
	return ev, true
}

func (s *sessionLog) List(ctx context.Context) ([]domain.SessionInfo, error) {
	ids, err := s.repo.IDs(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]domain.SessionInfo, 0, len(ids))
	for i := len(ids) - 1; i >= 0; i-- { // новые сверху
		evs, err := s.repo.Events(ctx, ids[i])
		if err != nil || len(evs) == 0 {
			continue
		}
		out = append(out, sessionInfo(ids[i], evs))
	}
	return out, nil
}

func sessionInfo(id string, evs []domain.SessionEvent) domain.SessionInfo {
	info := domain.SessionInfo{ID: id, Title: id, StartedAt: evs[0].At, Active: true}
	for _, e := range evs {
		switch e.Kind {
		case domain.SessionStart:
			info.Title = e.Text
		case domain.SessionEnd:
			info.Active, info.EndedAt = false, e.At
		case domain.SessionSummary:
			info.SummaryID = e.Ref
			continue
		}
		info.Events++
	}
	return info
}

func (s *sessionLog) Events(ctx context.Context, id string, isDM bool, playerID string) ([]domain.SessionEvent, error) {
	evs, err := s.repo.Events(ctx, id)
	if err != nil {
		return nil, err
	}
	out := make([]domain.SessionEvent, 0, len(evs))
	for _, e := range evs {
		if v, ok := e.ForViewer(isDM, playerID); ok {
			out = append(out, v)
		}
	}
	return out, nil
}

func (s *sessionLog) Summary(ctx context.Context, id string) (string, error) {
	evs, err := s.repo.Events(ctx, id)
	if err != nil {
		return "", err
	}
	if len(evs) == 0 {
		return "", domain.ErrNotFound
	}
	info := sessionInfo(id, evs)
	dm := domain.JournalViewer{IsDM: true, Name: "ДМ"}
	e, err := s.journal.Create(ctx, dm, JournalDraft{Folder: "Сессии", Content: SessionMarkdown(info, evs), Default: domain.JournalNone})
	if err != nil {
		return "", err
	}
	// Итог дописывается и в закончившуюся ленту — прямо в её файл.
	s.mu.Lock()
	seq := evs[len(evs)-1].Seq + 1
	if id == s.active {
		s.seq++
		seq = s.seq
	}
	err = s.repo.Append(ctx, id, domain.SessionEvent{Seq: seq, At: s.now().UnixMilli(), Kind: domain.SessionSummary, Scene: evs[len(evs)-1].Scene, Text: "Итог в журнале", Ref: e.ID})
	s.mu.Unlock()
	return e.ID, err
}

// SessionMarkdown — итог сессии: разделы по сценам, бой по раундам.
// Ходы пропускаются — в итоге это шум.
func SessionMarkdown(info domain.SessionInfo, evs []domain.SessionEvent) string {
	var b strings.Builder
	start := time.UnixMilli(info.StartedAt)
	fmt.Fprintf(&b, "# %s — %s\n\n", info.Title, ruDate(start))
	if info.EndedAt > 0 {
		fmt.Fprintf(&b, "Длительность: %s.\n", ruDuration(time.Duration(info.EndedAt-info.StartedAt)*time.Millisecond))
	}
	scene, round := "\x00", -1
	for _, e := range evs {
		switch e.Kind {
		case domain.SessionStart, domain.SessionEnd, domain.SessionSummary, domain.SessionTurn, domain.SessionRound:
			continue
		}
		if e.Scene != scene {
			scene, round = e.Scene, -1
			title := e.Scene
			if title == "" {
				title = "Без сцены"
			}
			fmt.Fprintf(&b, "\n## %s\n\n", title)
		}
		if e.Kind == domain.SessionScene {
			continue // заголовок раздела уже сказал, куда перешли
		}
		if e.Round != round && e.Round > 0 {
			fmt.Fprintf(&b, "\n**Раунд %d**\n\n", e.Round)
		}
		round = e.Round
		line := e.Text
		if e.Total != nil {
			line += fmt.Sprintf(" — **%d**", *e.Total)
			if e.Formula != "" {
				line += " (" + e.Formula + ")"
			}
		}
		if e.Kind == domain.SessionNote {
			line = "*" + line + "*"
		}
		if e.Secret {
			line += " · скрыто"
		}
		fmt.Fprintf(&b, "- %s %s\n", time.UnixMilli(e.At).Format("15:04"), line)
	}
	return b.String()
}

var ruMonths = [...]string{"января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"}

func ruDate(t time.Time) string {
	return fmt.Sprintf("%d %s %d", t.Day(), ruMonths[t.Month()-1], t.Year())
}

func ruDuration(d time.Duration) string {
	h, m := int(d.Hours()), int(d.Minutes())%60
	if h == 0 {
		return fmt.Sprintf("%d мин", m)
	}
	return fmt.Sprintf("%d ч %d мин", h, m)
}
