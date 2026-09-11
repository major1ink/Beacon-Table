package service

import (
	"math"

	"beacon-table/internal/domain"
)

// ---- телепорты (см. domain.Teleport) ----
//
// Портал ставит ДМ; токен, поставленный на портал (игроком — applyOwnTokenMove,
// ДМ — move_token), «просится» на другую сцену: серверу об этом говорит
// noticeTeleport, а решает ДМ (см. web/src/pages/dm.js: teleport_request).
// Сам перенос — teleport_tokens: токены уезжают на сцену назначения, стол
// переключается туда же. Локальный портал (Teleport.Local) ведёт к порталу
// той же сцены: токены встают рядом с ним, стол на месте.

// handleTeleportUpsert — add_teleport / move_teleport: апсерт по id.
func (r *Room) handleTeleportUpsert(t *domain.Teleport) {
	if t == nil || t.ID == "" {
		return
	}
	if r.scene.Teleports == nil {
		r.scene.Teleports = make(map[string]*domain.Teleport)
	}
	r.scene.Teleports[t.ID] = t
	r.markDirty(r.currentSceneID)
}

func (r *Room) handleTeleportRemove(id string) {
	delete(r.scene.Teleports, id)
	delete(r.teleportArmed, id)
	// Снять ссылку у парного портала.
	for _, t := range r.scene.Teleports {
		if t.TargetTeleportID == id {
			t.TargetTeleportID = ""
		}
	}
	r.markDirty(r.currentSceneID)
}

// teleportUnder — портал активной сцены, на котором стоит точка.
func (r *Room) teleportUnder(x, y float64) *domain.Teleport {
	cell := r.scene.Grid.Size
	for _, t := range r.scene.Teleports {
		if math.Hypot(t.X-x, t.Y-y) <= t.Radius(cell) {
			return t
		}
	}
	return nil
}

// noticeTeleport — токен подвинулся: встал на портал — один раз сказать ДМ;
// сошёл — забыть, чтобы следующий заход спросил заново. who — кто двигал.
func (r *Room) noticeTeleport(who string, tok *domain.Token) {
	t := r.teleportUnder(tok.X, tok.Y)
	if t == nil {
		delete(r.teleportArmed, tok.ID)
		return
	}
	if r.teleportArmed[tok.ID] == t.ID {
		return
	}
	if r.teleportArmed == nil {
		r.teleportArmed = make(map[string]string)
	}
	r.teleportArmed[tok.ID] = t.ID
	payload := map[string]any{
		"type":       "teleport_request",
		"teleportId": t.ID,
		"tokenId":    tok.ID,
		"tokenLabel": tok.Label,
		"playerName": who,
	}
	if t.Local() {
		dest, ok := r.scene.Teleports[t.TargetTeleportID]
		if !ok || dest == t {
			return
		}
		payload["targetTeleportId"] = dest.ID
		payload["targetLabel"] = dest.Label
	} else {
		target, ok := r.scenes[t.TargetSceneID]
		if !ok {
			return
		}
		payload["targetSceneId"] = target.ID
		payload["targetSceneName"] = target.Name
	}
	for cl := range r.clients {
		if cl.Role() == domain.RoleDM {
			cl.Send(payload)
		}
	}
}

// handleTeleportTokens — перенести токены на сцену назначения портала и
// переключить стол туда. Приземляются у обратного портала (того, что на
// сцене назначения ведёт сюда), иначе — в центре карты; рядом друг с другом
// по клетке сетки.
func (r *Room) handleTeleportTokens(msg domain.ClientMsg) {
	t, ok := r.scene.Teleports[msg.ID]
	if !ok {
		return
	}
	if t.Local() {
		r.teleportWithin(t, msg.TokenIDs)
		return
	}
	target, ok := r.scenes[t.TargetSceneID]
	if !ok || target == r.scene {
		return
	}
	from := r.scene
	cell := target.Grid.Size
	if cell <= 0 {
		cell = 48
	}
	at := landing(target, from.ID, cell)
	moved := 0
	for _, id := range msg.TokenIDs {
		tok, ok := from.Tokens[id]
		if !ok {
			continue
		}
		delete(from.Tokens, id)
		delete(r.teleportArmed, id)
		// Один персонаж — один токен, как и у постановки токена гостю.
		if tok.CharacterID != "" {
			for oid, other := range target.Tokens {
				if other.CharacterID == tok.CharacterID {
					delete(target.Tokens, oid)
				}
			}
		}
		tok.X = at.x + float64(moved%4)*cell
		tok.Y = at.y + float64(moved/4)*cell
		target.Tokens[id] = tok
		moved++
	}
	if moved == 0 {
		return
	}
	r.markDirty(from.ID)
	r.markDirty(target.ID)
	r.switchScene(target.ID)
}

// teleportWithin — перенос к порталу той же сцены: клетка правее него.
func (r *Room) teleportWithin(t *domain.Teleport, ids []string) {
	dest, ok := r.scene.Teleports[t.TargetTeleportID]
	if !ok || dest == t {
		return
	}
	cell := r.scene.Grid.Size
	if cell <= 0 {
		cell = 48
	}
	at := point{dest.X + dest.Radius(cell) + cell/2, dest.Y}
	moved := 0
	for _, id := range ids {
		tok, ok := r.scene.Tokens[id]
		if !ok {
			continue
		}
		delete(r.teleportArmed, id)
		tok.X = at.x + float64(moved%4)*cell
		tok.Y = at.y + float64(moved/4)*cell
		moved++
	}
	if moved == 0 {
		return
	}
	r.markDirty(r.currentSceneID)
}

type point struct{ x, y float64 }

// landing — куда ставить прибывших: клетка правее обратного портала, иначе
// центр карты.
func landing(target *domain.SceneState, fromSceneID string, cell float64) point {
	for _, back := range target.Teleports {
		if back.TargetSceneID == fromSceneID {
			return point{back.X + back.Radius(cell) + cell/2, back.Y}
		}
	}
	return point{target.Width / 2, target.Height / 2}
}
