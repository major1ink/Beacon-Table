// room_session.go — лента сессии в комнате: события стола в журнал сессии
// (см. SessionLogService) и каждому клиенту — его версия события, как в чате.
package service

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"beacon-table/internal/domain"
)

// maxSessionNote — потолок быстрой заметки ведущего.
const maxSessionNote = 500

// UseSessions — подключить ленту мира; вызывается один раз при запуске.
func (r *Room) UseSessions(svc SessionLogService) {
	r.sessionsMu.Lock()
	r.sessions = svc
	r.sessionsMu.Unlock()
}

func (r *Room) sessionLog() SessionLogService {
	r.sessionsMu.Lock()
	defer r.sessionsMu.Unlock()
	return r.sessions
}

func (r *Room) sessionPayload() map[string]any {
	out := map[string]any{"type": "session_state", "active": false}
	if svc := r.sessionLog(); svc != nil {
		if info, ok := svc.Active(); ok {
			out["active"], out["id"], out["title"] = true, info.ID, info.Title
		}
	}
	return out
}

func (r *Room) broadcastSessionState() {
	payload := r.sessionPayload()
	for c := range r.clients {
		if c.Role() != domain.RoleTV {
			c.Send(payload)
		}
	}
}

// logSession — в горутине run(): дописать событие, если сессия идёт, и
// разослать. Сцена и раунд проставляются здесь — по ним лента группирует.
func (r *Room) logSession(ev domain.SessionEvent) {
	svc := r.sessionLog()
	if svc == nil {
		return
	}
	if ev.Scene == "" && r.scene != nil {
		ev.Scene = r.scene.Name
	}
	if r.combat.Active && ev.Round == 0 {
		ev.Round = r.combat.Round
	}
	saved, ok := svc.Append(context.Background(), ev)
	if !ok {
		return
	}
	r.sendSessionEvent(saved)
}

func (r *Room) sendSessionEvent(ev domain.SessionEvent) {
	for c := range r.clients {
		if c.Role() == domain.RoleTV {
			continue
		}
		if v, ok := ev.ForViewer(c.Role() == domain.RoleDM, c.PlayerID()); ok {
			c.Send(map[string]any{"type": "session_event", "event": v})
		}
	}
}

// handleSession — "session_start" / "session_end" / "session_note" (только ДМ).
func (r *Room) handleSession(msg domain.ClientMsg) {
	svc := r.sessionLog()
	if svc == nil {
		return
	}
	ctx := context.Background()
	switch msg.Type {
	case "session_start":
		scene := ""
		if r.scene != nil {
			scene = r.scene.Name
		}
		_, ev, err := svc.Start(ctx, scene)
		if err != nil {
			slog.Warn("Не удалось начать сессию", "err", err)
			return
		}
		r.broadcastSessionState()
		r.sendSessionEvent(ev)
	case "session_end":
		ev, err := svc.End(ctx)
		if err != nil {
			return
		}
		r.sendSessionEvent(ev)
		r.broadcastSessionState()
	case "session_note":
		text := clampRunes(strings.TrimSpace(msg.Text), maxSessionNote)
		if text != "" {
			r.logSession(domain.SessionEvent{Kind: domain.SessionNote, Actor: "ДМ", Text: text, Secret: true})
		}
	}
}

// logRoll — бросок из relayRoll; скрытый видят ведущий и сам бросивший.
func (r *Room) logRoll(from RoomClient, name, formula, label string, total int, hidden bool) {
	text := name
	if label != "" {
		text += ": " + label
	}
	ev := domain.SessionEvent{Kind: domain.SessionRoll, Actor: name, Text: text, Formula: formula, Total: &total, Secret: hidden}
	if hidden && from != nil && from.Role() == domain.RolePlayer {
		ev.OwnerID = from.PlayerID()
	}
	r.logSession(ev)
}

// logHP — урон или лечение бойца. Игроки видят числа, только если ведущий
// открыл хиты (ShowHP) или это персонаж партии; иначе — «ранен».
func (r *Room) logHP(cmb *domain.Combatant, before int) {
	delta := cmb.HPCurrent - before
	if delta == 0 {
		return
	}
	name := cmb.Name
	var text string
	if delta < 0 {
		text = fmt.Sprintf("%s: урон %d", name, -delta)
	} else {
		text = fmt.Sprintf("%s: лечение %d", name, delta)
	}
	if cmb.HPMax > 0 {
		text += fmt.Sprintf(" (%d/%d)", cmb.HPCurrent, cmb.HPMax)
	} else {
		text += fmt.Sprintf(" (%d)", cmb.HPCurrent)
	}
	ev := domain.SessionEvent{Kind: domain.SessionHP, Actor: name, Text: text, Amount: delta}
	if !r.combat.ShowHP && cmb.CharacterID == "" {
		if delta > 0 && cmb.HPCurrent > 0 && (cmb.HPMax == 0 || cmb.HPCurrent*2 > cmb.HPMax) {
			ev.PublicText = name + ": подлечился"
		} else {
			ev.PublicText = name + ": " + domain.WoundState(cmb.HPCurrent, cmb.HPMax)
		}
	}
	if t, _ := r.findToken(cmb.TokenID); t != nil && t.Hidden {
		ev.Secret = true // невидимого на карте игроки не знают
	}
	r.logSession(ev)
}

// logStatus — метка повешена или снята.
func (r *Room) logStatus(msg domain.ClientMsg, applied bool) {
	name, hidden := r.statusTargetName(msg)
	if name == "" {
		return
	}
	label := msg.StatusSlug
	if cond := r.lookupCondition(NormalizeConditionSlug(msg.StatusSlug)); cond != nil && cond.Name != "" {
		label = cond.Name
	}
	text := name + ": " + strings.ToLower(label)
	if !applied {
		text = name + ": снято «" + strings.ToLower(label) + "»"
	}
	if msg.Hidden != nil && *msg.Hidden {
		hidden = true
	}
	r.logSession(domain.SessionEvent{Kind: domain.SessionStatus, Actor: name, Text: text, Secret: hidden})
}

func (r *Room) statusTargetName(msg domain.ClientMsg) (string, bool) {
	if msg.TokenID != "" {
		if t, _ := r.findToken(msg.TokenID); t != nil {
			name := t.Label
			if cmb := r.combatantByToken(t.ID); cmb != nil && cmb.Name != "" {
				name = cmb.Name
			}
			return name, t.Hidden
		}
		return "", false
	}
	if cmb, ok := r.combat.Combatants[msg.CombatantID]; ok {
		hidden := false
		if t, _ := r.findToken(cmb.TokenID); t != nil {
			hidden = t.Hidden
		}
		return cmb.Name, hidden
	}
	return "", false
}

// logTurn — ход перешёл к текущему бойцу; скрытого бойца игроки не видят.
func (r *Room) logTurn() {
	cmb := r.combat.Combatants[r.combat.CurrentID]
	if !r.combat.Active || cmb == nil {
		return
	}
	ev := domain.SessionEvent{Kind: domain.SessionTurn, Actor: cmb.Name, Text: "Ход: " + cmb.Name}
	if t, _ := r.findToken(cmb.TokenID); t != nil && t.Hidden {
		ev.Secret = true
	}
	r.logSession(ev)
}

// logTimers — в горутине run(), после сохранения ширмы: запущенный таймер
// в ленту. Запуск видно по новому EndsAt; закрытый от игроков — секрет.
func (r *Room) logTimers() {
	r.screenMu.Lock()
	svc := r.screenSvc
	r.screenMu.Unlock()
	if svc == nil {
		return
	}
	sc, err := svc.Get(context.Background(), domain.JournalViewer{IsDM: true})
	if err != nil {
		return
	}
	ends := map[string]int64{}
	for _, t := range sc.Tabs {
		for _, c := range t.Cells {
			if c.Kind != domain.ScreenCellTimer || c.EndsAt == 0 {
				continue
			}
			ends[c.ID] = c.EndsAt
			if r.timerEnds == nil || r.timerEnds[c.ID] == c.EndsAt {
				continue
			}
			title := c.Title
			if title == "" {
				title = "Таймер"
			}
			r.logSession(domain.SessionEvent{
				Kind: domain.SessionTimer, Secret: !c.Public,
				Text: fmt.Sprintf("Таймер «%s»: %s", title, timerLabel(c.EndsAt-time.Now().UnixMilli())),
			})
		}
	}
	r.timerEnds = ends
}

func timerLabel(ms int64) string {
	sec := max(ms/1000, 0)
	return fmt.Sprintf("осталось %d:%02d", sec/60, sec%60)
}
