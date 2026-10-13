package domain

import "time"

// Вкладки ширмы. Ячейки пока заданы видом вкладки; свободная сетка — этап 2.
const (
	ScreenTabRules = "rules" // состояния и правила из справочника
	ScreenTabNotes = "notes" // закреплённые записи журнала
	ScreenTabTools = "tools" // скрытый бросок и прочее только для ведущего
)

// Виды ячеек ширмы.
const (
	ScreenCellJournal   = "journal"
	ScreenCellReference = "reference"
)

// Screen — ширма ведущего, одна на мир.
type Screen struct {
	Tabs      []ScreenTab `json:"tabs"`
	UpdatedAt time.Time   `json:"updatedAt"`
}

type ScreenTab struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	Title string `json:"title"`
	// Shared — вкладку видят игроки, только для чтения.
	Shared bool         `json:"shared,omitempty"`
	Cells  []ScreenCell `json:"cells,omitempty"`
}

type ScreenCell struct {
	Kind string `json:"kind"`
	Ref  string `json:"ref"`
}

// DefaultScreen — раскладка, с которой ширма открывается впервые.
func DefaultScreen() *Screen {
	return &Screen{Tabs: []ScreenTab{
		{ID: "rules", Kind: ScreenTabRules, Title: "Правила"},
		{ID: "notes", Kind: ScreenTabNotes, Title: "Заметки"},
		{ID: "tools", Kind: ScreenTabTools, Title: "Инструменты"},
	}}
}

// Shareable — можно ли показать вкладку игрокам: инструменты только ведущему.
func (t ScreenTab) Shareable() bool {
	return t.Kind != ScreenTabTools
}
