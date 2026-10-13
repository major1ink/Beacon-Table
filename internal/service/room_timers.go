package service

import (
	"time"

	"beacon-table/internal/domain"
)

// SetScreenTimers — открытые таймеры ширмы: запомнить и разослать всем, включая трансляцию.
func (r *Room) SetScreenTimers(timers []domain.ScreenTimer) {
	r.timersMu.Lock()
	r.timers = timers
	r.timersMu.Unlock()
	select {
	case r.timersChanged <- struct{}{}:
	default:
	}
}

func (r *Room) timersPayload() map[string]any {
	r.timersMu.Lock()
	defer r.timersMu.Unlock()
	timers := r.timers
	if timers == nil {
		timers = []domain.ScreenTimer{}
	}
	// serverNow — чтобы клиенты считали остаток по часам сервера.
	return map[string]any{"type": "screen_timers", "serverNow": time.Now().UnixMilli(), "timers": timers}
}

func (r *Room) broadcastTimers() {
	payload := r.timersPayload()
	for c := range r.clients {
		c.Send(payload)
	}
}
