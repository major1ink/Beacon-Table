package service

import (
	"context"
	"sort"
	"strconv"

	"beacon-table/internal/domain"
)

// ---- призыв существ игроком ----
//
// Игрок выбирает существо из разрешённых (Monster.Summonable либо вся
// библиотека при CombatState.SummonAll) и просит его на карту;
// ДМ видит запрос, правит количество и подтверждает или отклоняет — тем же
// потоком, что телепорт (teleport_request → решение ДМ). Токены встают
// рядом с фишкой игрока на его сцене (см. sceneOf), владелец — игрок:
// фамильяра он водит сам. Статблок — по MonsterID, как у любого монстра.

// maxSummonCount — потолок на один запрос, защита от опечатки вроде «150»:
// решает всё равно ДМ.
const maxSummonCount = 20

// summonRequest — запрос игрока, пока ДМ не решил.
type summonRequest struct {
	id        string
	playerID  string
	sceneID   string
	monsterID string
	count     int
}

// summonable — существо, доступное игроку для призыва: только то, что
// нужно выбрать, без статблока.
type summonable struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	ImageURL string `json:"imageUrl,omitempty"`
	Size     string `json:"size,omitempty"`
	CR       string `json:"cr,omitempty"`
}

// summonableMonsters — что игроку можно призвать сейчас.
func (r *Room) summonableMonsters() []summonable {
	if r.monsters == nil {
		return nil
	}
	list, err := r.monsters.List(context.Background())
	if err != nil {
		return nil
	}
	out := make([]summonable, 0)
	for _, m := range list {
		if !r.canSummon(m) {
			continue
		}
		out = append(out, summonable{ID: m.ID, Name: m.Name, ImageURL: m.ImageURL, Size: m.Size, CR: m.CR})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// canSummon — доступно игроку: по тумблеру стола либо по флагу карточки.
// Встроенный каталог при этом подчиняется своему тумблеру
// (CombatState.ShowBuiltinCards): скрыт у ДМ — скрыт и в призыве, иначе у
// игрока было бы больше карточек, чем у ведущего.
func (r *Room) canSummon(m *domain.Monster) bool {
	if m.System && !r.combat.ShowBuiltinCards {
		return false
	}
	return r.combat.SummonAll || m.Summonable
}

// handleSummonList — «что можно призвать»: ответ только запросившему.
func (r *Room) handleSummonList(c RoomClient) {
	c.Send(map[string]any{"type": "summon_list", "monsters": r.summonableMonsters()})
}

// handleSummonRequest — игрок просит существо. Проверки: существо есть и
// разрешено, у игрока есть фишка на его сцене (рядом с ней и ставить), за
// столом есть ДМ, кому решать. Ответ игроку — summon_status, ДМ —
// summon_request.
func (r *Room) handleSummonRequest(c RoomClient, msg domain.ClientMsg) {
	reject := func(reason string) {
		c.Send(map[string]any{"type": "summon_status", "status": "rejected", "reason": reason})
	}
	if r.monsters == nil {
		reject("бестиарий недоступен")
		return
	}
	m, err := r.monsters.Get(context.Background(), msg.MonsterID)
	if err != nil || !r.canSummon(m) {
		reject("это существо призывать нельзя")
		return
	}
	count := msg.Count
	if count < 1 {
		count = 1
	}
	if count > maxSummonCount {
		count = maxSummonCount
	}
	if !ownsTokenOn(r.scene, c.PlayerID()) {
		reject("у тебя нет фишки на карте — рядом с кем ставить?")
		return
	}
	dms := 0
	for cl := range r.clients {
		if cl.Role() == domain.RoleDM {
			dms++
		}
	}
	if dms == 0 {
		reject("ДМ не за столом — некому подтвердить")
		return
	}
	req := &summonRequest{id: "sum-" + newID(), playerID: c.PlayerID(), sceneID: r.scene.ID, monsterID: m.ID, count: count}
	if r.summons == nil {
		r.summons = make(map[string]*summonRequest)
	}
	r.summons[req.id] = req
	c.Send(map[string]any{"type": "summon_status", "status": "pending", "requestId": req.id, "monsterName": m.Name, "count": count})
	payload := map[string]any{
		"type":        "summon_request",
		"requestId":   req.id,
		"playerId":    c.PlayerID(),
		"playerName":  c.PlayerName(),
		"monsterId":   m.ID,
		"monsterName": m.Name,
		"count":       count,
	}
	for cl := range r.clients {
		if cl.Role() == domain.RoleDM {
			cl.Send(payload)
		}
	}
}

// handleSummonResolve — решение ДМ: Count > 0 — столько и поставить, 0 —
// отказ. Токены — рядом с фишкой игрока на сцене запроса, по спирали
// свободных клеток (см. freeSpotsAround).
func (r *Room) handleSummonResolve(msg domain.ClientMsg) {
	req, ok := r.summons[msg.RequestID]
	if !ok {
		return
	}
	delete(r.summons, req.id)
	notify := func(payload map[string]any) {
		payload["type"] = "summon_status"
		payload["requestId"] = req.id
		for cl := range r.clients {
			if cl.Role() == domain.RolePlayer && cl.PlayerID() == req.playerID {
				cl.Send(payload)
			}
		}
	}
	count := msg.Count
	if count > maxSummonCount {
		count = maxSummonCount
	}
	scene, ok := r.scenes[req.sceneID]
	if count <= 0 || !ok {
		notify(map[string]any{"status": "rejected", "reason": "ДМ отклонил призыв"})
		return
	}
	m, err := r.monsters.Get(context.Background(), req.monsterID)
	if err != nil {
		notify(map[string]any{"status": "rejected", "reason": "существа больше нет в бестиарии"})
		return
	}
	var anchor *domain.Token
	for _, t := range scene.Tokens {
		if t.OwnerID == req.playerID && !t.LightOnly {
			anchor = t
			break
		}
	}
	if anchor == nil {
		notify(map[string]any{"status": "rejected", "reason": "фишки игрока на карте уже нет"})
		return
	}
	cell := scene.Grid.Size
	if cell <= 0 {
		cell = 48
	}
	spots := freeSpotsAround(scene, anchor.X, anchor.Y, cell, count)
	for i, p := range spots {
		tok := tokenFromMonster(m, p.x, p.y, cell)
		tok.OwnerID = req.playerID
		if count > 1 {
			tok.Label = m.Name + " " + strconv.Itoa(i+1)
		}
		scene.Tokens[tok.ID] = tok
	}
	r.markDirty(scene.ID)
	notify(map[string]any{"status": "approved", "count": len(spots), "monsterName": m.Name})
	r.broadcastAll()
}

// tokenFromMonster — фишка по карточке бестиария: арт, имя, размер в
// клетку; статблок открывается по MonsterID.
func tokenFromMonster(m *domain.Monster, x, y, cell float64) *domain.Token {
	return &domain.Token{
		ID: "tok-" + newID(), X: x, Y: y, Size: cell / 2,
		Label: m.Name, Image: m.ImageURL, Color: "#888888",
		MonsterID: m.ID,
	}
}

// freeSpotsAround — до n свободных клеток по спирали вокруг точки, в
// пределах карты и зоны показа; карта забита — остаток ставится на якорь.
func freeSpotsAround(s *domain.SceneState, ax, ay, cell float64, n int) []point {
	taken := func(x, y float64) bool {
		for _, t := range s.Tokens {
			if !t.LightOnly && absf(t.X-x) < cell/2 && absf(t.Y-y) < cell/2 {
				return true
			}
		}
		return false
	}
	// Соседи по клеткам, не по кругу (ringOffsets нормирует диагонали —
	// фишки легли бы друг на друга): восемь клеток вокруг, дальше — кольцо
	// радиуса 2 и т.д.
	cells := [8][2]float64{{1, 0}, {1, 1}, {0, 1}, {-1, 1}, {-1, 0}, {-1, -1}, {0, -1}, {1, -1}}
	out := make([]point, 0, n)
	for radius := 1; radius <= 6 && len(out) < n; radius++ {
		for _, d := range cells {
			if len(out) >= n {
				break
			}
			x := ax + d[0]*float64(radius)*cell
			y := ay + d[1]*float64(radius)*cell
			if x < cell/2 || y < cell/2 || x > s.Width-cell/2 || y > s.Height-cell/2 {
				continue
			}
			if zx, zy := s.ViewZone.Clamp(x, y); zx != x || zy != y {
				continue
			}
			if taken(x, y) {
				continue
			}
			out = append(out, point{x, y})
		}
	}
	for len(out) < n {
		out = append(out, point{ax, ay})
	}
	return out
}

func absf(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}
