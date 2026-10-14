package domain

// Лента сессии — журнал событий стола, который только дописывается
// (world/sessions/<дата>.jsonl): броски, бой, урон, состояния, смена сцены,
// заметки ведущего. Права — как в чате: каждому своя версия события.

// Виды событий ленты.
const (
	SessionStart   = "start"
	SessionEnd     = "end"
	SessionRoll    = "roll"
	SessionCombat  = "combat" // начало или конец боя
	SessionRound   = "round"
	SessionTurn    = "turn"
	SessionHP      = "hp" // урон или лечение
	SessionStatus  = "status"
	SessionScene   = "scene"
	SessionTimer   = "timer"
	SessionNote    = "note"
	SessionSummary = "summary" // по ленте сделан итог в журнал
)

// SessionEvent — одна строка .jsonl.
type SessionEvent struct {
	Seq   int    `json:"seq"`
	At    int64  `json:"at"` // unix-миллисекунды сервера
	Kind  string `json:"kind"`
	Scene string `json:"scene,omitempty"`
	// Round — раунд боя, 0 вне боя: по нему лента группирует события боя.
	Round int    `json:"round,omitempty"`
	Actor string `json:"actor,omitempty"`
	Text  string `json:"text"`
	// PublicText — что видят игроки вместо Text: у врага «тяжело ранен»
	// вместо чисел хитов (как combatPayload без ShowHP).
	PublicText string `json:"publicText,omitempty"`
	Formula    string `json:"formula,omitempty"`
	Total      *int   `json:"total,omitempty"`
	// Amount — изменение хитов: урон отрицательный.
	Amount int `json:"amount,omitempty"`
	// Secret — только ведущему (скрытый бросок, заметка, скрытая метка) и
	// OwnerID — игроку, который сам кинул скрытый бросок.
	Secret  bool   `json:"secret,omitempty"`
	OwnerID string `json:"ownerId,omitempty"`
	// Ref — id записи журнала у SessionSummary.
	Ref string `json:"ref,omitempty"`
}

// ForViewer — событие глазами клиента: ok=false — не показывать вовсе.
func (e SessionEvent) ForViewer(isDM bool, playerID string) (SessionEvent, bool) {
	if isDM {
		return e, true
	}
	if e.Secret && (playerID == "" || e.OwnerID != playerID) {
		return SessionEvent{}, false
	}
	if e.PublicText != "" {
		e.Text = e.PublicText
		e.Amount = 0
	}
	e.PublicText = ""
	e.OwnerID = ""
	if e.Kind == SessionSummary {
		e.Ref = "" // запись итога игроку может быть закрыта — откроет её через журнал
	}
	return e, true
}

// WoundState — словесное состояние вместо чисел хитов.
func WoundState(hp, hpMax int) string {
	switch {
	case hp <= 0:
		return "повержен"
	case hpMax > 0 && hp*2 <= hpMax:
		return "тяжело ранен"
	default:
		return "ранен"
	}
}

// SessionInfo — сессия в списке.
type SessionInfo struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	StartedAt int64  `json:"startedAt"`
	EndedAt   int64  `json:"endedAt,omitempty"`
	Active    bool   `json:"active"`
	Events    int    `json:"events"`
	// SummaryID — запись журнала с итогом, если делали.
	SummaryID string `json:"summaryId,omitempty"`
}
