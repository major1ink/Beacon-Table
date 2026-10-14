package domain

import (
	"slices"
	"time"
)

// Вкладки ширмы. rules/notes собираются сами, grid — ячейки ведущего.
const (
	ScreenTabRules = "rules" // состояния и правила из справочника
	ScreenTabNotes = "notes" // закреплённые записи журнала
	ScreenTabGrid  = "grid"  // ячейки, расставленные ведущим
	// ScreenTabTools — прежние «Инструменты», при чтении становятся сеткой.
	ScreenTabTools = "tools"
)

// Виды ячеек ширмы.
const (
	ScreenCellJournal    = "journal"
	ScreenCellReference  = "reference"
	ScreenCellConditions = "conditions"
	ScreenCellRoll       = "roll"
	ScreenCellTimer      = "timer"
	ScreenCellCounter    = "counter"
	// Лента сессии и граф связей журнала — виды без настроек.
	ScreenCellFeed  = "feed"
	ScreenCellGraph = "graph"
)

// Screen — ширма ведущего, одна на мир.
type Screen struct {
	Tabs      []ScreenTab `json:"tabs"`
	UpdatedAt time.Time   `json:"updatedAt"`
	// ServerNow — часы сервера (unix ms) в ответе: таймеры считаются по ним.
	ServerNow int64 `json:"serverNow,omitempty"`
}

type ScreenTab struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	Title string `json:"title"`
	// Shared — вкладку видят игроки, только для чтения.
	Shared bool `json:"shared,omitempty"`
	// Columns — ширина сетки в колонках (только grid).
	Columns int          `json:"columns,omitempty"`
	Cells   []ScreenCell `json:"cells,omitempty"`
}

type ScreenCell struct {
	ID   string `json:"id,omitempty"`
	Kind string `json:"kind"`
	// Ref — id карточки или записи журнала.
	Ref   string `json:"ref,omitempty"`
	Title string `json:"title,omitempty"`
	// W/H — сколько колонок и строк сетки занимает ячейка.
	W int `json:"w,omitempty"`
	H int `json:"h,omitempty"`
	// Value — значение счётчика.
	Value int `json:"value,omitempty"`
	// Таймер: Seconds — длительность; EndsAt — когда кончится (unix ms), пока
	// идёт; Left — сколько осталось (ms), пока стоит на паузе.
	Seconds int   `json:"seconds,omitempty"`
	EndsAt  int64 `json:"endsAt,omitempty"`
	Left    int64 `json:"left,omitempty"`
	// Public — таймер или счётчик видят игроки и трансляция; NoTitle — без подписи.
	Public  bool `json:"public,omitempty"`
	NoTitle bool `json:"noTitle,omitempty"`

	// Счётчик: Auto — событие стола, которое он считает сам (ScreenAuto*),
	// пусто — только руками. Who — чьё событие: ScreenWhoPlayers/Monsters,
	// пусто — любое. Roll/RollMin — какой бросок считать.
	Auto    string `json:"auto,omitempty"`
	Who     string `json:"who,omitempty"`
	Roll    string `json:"roll,omitempty"`
	RollMin int    `json:"rollMin,omitempty"`
	// Target — порог: при достижении Notice уходит в чат (NoticeTo), потом
	// счёт начинается заново (Repeat) или стоит (Done) до сброса.
	Target     int    `json:"target,omitempty"`
	Notice     string `json:"notice,omitempty"`
	NoticeTo   string `json:"noticeTo,omitempty"`
	Repeat     bool   `json:"repeat,omitempty"`
	Done       bool   `json:"done,omitempty"`
	ShowTarget bool   `json:"showTarget,omitempty"`
}

// События стола, которые умеет считать счётчик.
const (
	ScreenAutoRound  = "round"  // новый раунд боя
	ScreenAutoTurn   = "turn"   // ход бойца
	ScreenAutoKilled = "killed" // боец выбыл
	ScreenAutoRoll   = "roll"   // бросок
	ScreenAutoScene  = "scene"  // показана другая сцена
	ScreenAutoCombat = "combat" // начат бой
)

const (
	ScreenWhoPlayers  = "players"
	ScreenWhoMonsters = "monsters"

	ScreenRollNat20 = "nat20"
	ScreenRollNat1  = "nat1"
	ScreenRollMin   = "min"

	ScreenNoticeAll = "all"
	ScreenNoticeDM  = "dm"
)

// ScreenEvent — событие стола для счётчиков. Player — персонаж или игрок, а
// не противник; D20/Total — грани d20 и итог броска.
type ScreenEvent struct {
	Kind   string
	Player bool
	D20    []int
	Total  int
}

// Counts — засчитать ли событие этому счётчику.
func (c *ScreenCell) Counts(ev ScreenEvent) bool {
	if c.Kind != ScreenCellCounter || c.Auto != ev.Kind || c.Done {
		return false
	}
	switch {
	case c.Who == ScreenWhoPlayers && !ev.Player, c.Who == ScreenWhoMonsters && ev.Player:
		return false
	}
	if ev.Kind != ScreenAutoRoll {
		return true
	}
	switch c.Roll {
	case ScreenRollNat20:
		return slices.Contains(ev.D20, 20)
	case ScreenRollNat1:
		return slices.Contains(ev.D20, 1)
	default:
		return ev.Total >= c.RollMin
	}
}

// ScreenTimer — таймер ширмы, открытый игрокам и трансляции.
type ScreenTimer struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Seconds int    `json:"seconds"`
	EndsAt  int64  `json:"endsAt,omitempty"`
	Left    int64  `json:"left,omitempty"`
}

// ScreenCounter — счётчик ширмы, открытый игрокам и трансляции.
type ScreenCounter struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Value  int    `json:"value"`
	Target int    `json:"target,omitempty"`
}

// ScreenPublic — что с ширмы видят игроки и трансляция.
type ScreenPublic struct {
	Timers   []ScreenTimer   `json:"timers"`
	Counters []ScreenCounter `json:"counters"`
}

// Public — открытые таймеры и счётчики со всех вкладок.
func (s *Screen) Public() ScreenPublic {
	out := ScreenPublic{Timers: []ScreenTimer{}, Counters: []ScreenCounter{}}
	if s == nil {
		return out
	}
	for _, t := range s.Tabs {
		for _, c := range t.Cells {
			if !c.Public {
				continue
			}
			title := c.Title
			switch {
			case c.NoTitle:
				title = ""
			case title == "" && c.Kind == ScreenCellTimer:
				title = "Таймер"
			case title == "":
				title = "Счётчик"
			}
			switch c.Kind {
			case ScreenCellTimer:
				out.Timers = append(out.Timers, ScreenTimer{ID: c.ID, Title: title, Seconds: c.Seconds, EndsAt: c.EndsAt, Left: c.Left})
			case ScreenCellCounter:
				pc := ScreenCounter{ID: c.ID, Title: title, Value: c.Value}
				if c.ShowTarget {
					pc.Target = c.Target
				}
				out.Counters = append(out.Counters, pc)
			}
		}
	}
	return out
}

// AutoKinds — события, которые считает хоть один счётчик.
func (s *Screen) AutoKinds() map[string]bool {
	out := map[string]bool{}
	if s == nil {
		return out
	}
	for _, t := range s.Tabs {
		for _, c := range t.Cells {
			if c.Kind == ScreenCellCounter && c.Auto != "" && !c.Done {
				out[c.Auto] = true
			}
		}
	}
	return out
}

// DefaultScreen — раскладка, с которой ширма открывается впервые.
func DefaultScreen() *Screen {
	return &Screen{Tabs: []ScreenTab{
		{ID: "rules", Kind: ScreenTabRules, Title: "Правила"},
		{ID: "notes", Kind: ScreenTabNotes, Title: "Заметки"},
		ToolsTab("tools", "Инструменты"),
	}}
}

// ToolsTab — сетка с ячейкой броска.
func ToolsTab(id, title string) ScreenTab {
	return ScreenTab{ID: id, Kind: ScreenTabGrid, Title: title, Columns: 3,
		Cells: []ScreenCell{{ID: "roll", Kind: ScreenCellRoll, W: 1, H: 3}}}
}
