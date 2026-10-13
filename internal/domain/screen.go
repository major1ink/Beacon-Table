package domain

import "time"

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
	// Public — таймер видят игроки и трансляция.
	Public bool `json:"public,omitempty"`
}

// ScreenTimer — таймер ширмы, открытый игрокам и трансляции.
type ScreenTimer struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Seconds int    `json:"seconds"`
	EndsAt  int64  `json:"endsAt,omitempty"`
	Left    int64  `json:"left,omitempty"`
}

// PublicTimers — открытые таймеры со всех вкладок.
func (s *Screen) PublicTimers() []ScreenTimer {
	out := []ScreenTimer{}
	if s == nil {
		return out
	}
	for _, t := range s.Tabs {
		for _, c := range t.Cells {
			if c.Kind == ScreenCellTimer && c.Public {
				out = append(out, ScreenTimer{ID: c.ID, Title: c.Title, Seconds: c.Seconds, EndsAt: c.EndsAt, Left: c.Left})
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
