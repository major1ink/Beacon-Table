// room_screen.go — ширма ведущего в комнате: открытые игрокам таймеры и
// счётчики, автоподсчёт событий стола. Считает сервер, чтобы счётчик шёл и
// при закрытой ширме.
package service

import (
	"context"
	"log/slog"
	"time"

	"beacon-table/internal/domain"
)

// UseScreen — подключить ширму мира; вызывается один раз при запуске.
func (r *Room) UseScreen(ctx context.Context, svc ScreenService) {
	r.screenMu.Lock()
	r.screenSvc = svc
	r.screenMu.Unlock()
	if sc, err := svc.Get(ctx, domain.JournalViewer{IsDM: true}); err == nil {
		r.SetScreen(sc)
	}
}

// SetScreen — запомнить открытое игрокам и разослать всем, включая трансляцию.
func (r *Room) SetScreen(sc *domain.Screen) {
	r.rememberScreen(sc)
	select {
	case r.screenChanged <- struct{}{}:
	default:
	}
}

func (r *Room) rememberScreen(sc *domain.Screen) {
	r.screenMu.Lock()
	r.screenPub = sc.Public()
	r.screenAuto = sc.AutoKinds()
	r.screenMu.Unlock()
}

func (r *Room) screenPayload() map[string]any {
	r.screenMu.Lock()
	defer r.screenMu.Unlock()
	pub := r.screenPub
	if pub.Timers == nil {
		pub = (*domain.Screen)(nil).Public()
	}
	// serverNow — чтобы клиенты считали остаток по часам сервера.
	return map[string]any{"type": "screen_timers", "serverNow": time.Now().UnixMilli(), "timers": pub.Timers, "counters": pub.Counters}
}

func (r *Room) broadcastScreen() {
	payload := r.screenPayload()
	for c := range r.clients {
		c.Send(payload)
	}
}

// countScreen — в горутине run(): событие стола счётчикам ширмы.
func (r *Room) countScreen(ev domain.ScreenEvent) {
	r.screenMu.Lock()
	svc, listens := r.screenSvc, r.screenAuto[ev.Kind]
	r.screenMu.Unlock()
	if svc == nil || !listens {
		return
	}
	up, err := svc.Count(context.Background(), ev)
	if err != nil {
		slog.Warn("Не удалось засчитать событие счётчикам ширмы", "event", ev.Kind, "err", err)
		return
	}
	r.applyCounters(up)
}

// countTurn — ход того, кто сейчас текущий в бою.
func (r *Room) countTurn() {
	cmb := r.combat.Combatants[r.combat.CurrentID]
	if !r.combat.Active || cmb == nil {
		return
	}
	r.countScreen(domain.ScreenEvent{Kind: domain.ScreenAutoTurn, Player: cmb.CharacterID != ""})
}

// handleScreenCounter — "screen_counter": ведущий двигает счётчик руками.
func (r *Room) handleScreenCounter(msg domain.ClientMsg) {
	r.screenMu.Lock()
	svc := r.screenSvc
	r.screenMu.Unlock()
	if svc == nil || msg.ID == "" {
		return
	}
	up, err := svc.StepCounter(context.Background(), msg.ID, max(min(msg.CounterDelta, maxScreenCounter), -maxScreenCounter), msg.CounterReset)
	if err != nil {
		slog.Warn("Не удалось сдвинуть счётчик ширмы", "id", msg.ID, "err", err)
		return
	}
	r.applyCounters(up)
}

// applyCounters — новые значения в открытые ширмы и на плашки, сообщения о порогах в чат.
func (r *Room) applyCounters(up *CounterUpdate) {
	if up == nil {
		return
	}
	r.rememberScreen(up.Screen)
	r.broadcastScreen()

	shared := map[string]bool{}
	for _, t := range up.Screen.Tabs {
		if t.Shared {
			for _, c := range t.Cells {
				shared[c.ID] = true
			}
		}
	}
	type counter struct {
		ID    string `json:"id"`
		Value int    `json:"value"`
		Done  bool   `json:"done,omitempty"`
	}
	all, open := []counter{}, []counter{}
	for _, c := range up.Cells {
		all = append(all, counter{c.ID, c.Value, c.Done})
		if shared[c.ID] {
			open = append(open, counter{c.ID, c.Value, c.Done})
		}
	}
	for c := range r.clients {
		switch {
		case c.Role() == domain.RoleDM:
			c.Send(map[string]any{"type": "screen_counters", "counters": all})
		case c.Role() == domain.RolePlayer && len(open) > 0:
			c.Send(map[string]any{"type": "screen_counters", "counters": open})
		}
	}
	for _, n := range up.Notices {
		r.postNotice(n)
	}
}
