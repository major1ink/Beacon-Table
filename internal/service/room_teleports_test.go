package service

import (
	"testing"

	"beacon-table/internal/domain"
)

// recordingDM — RoomClient ДМ, запоминающий запросы телепорта: тесты
// смотрят, сколько раз его спросили.
type recordingDM struct {
	drawClient
	got []map[string]any
}

func (c *recordingDM) Send(payload any) {
	if m, ok := payload.(map[string]any); ok && m["type"] == "teleport_request" {
		c.got = append(c.got, m)
	}
}

// teleportRoom — две сцены с порталами друг на друга и токен игрока на первой.
func teleportRoom() (*Room, *recordingDM) {
	r := drawingsRoom()
	cellar := domain.NewScene("scene-2", "Подвал")
	cellar.Teleports["tp-back"] = &domain.Teleport{ID: "tp-back", X: 100, Y: 100, TargetSceneID: "scene-1"}
	r.scenes["scene-2"] = cellar
	r.sceneOrder = append(r.sceneOrder, "scene-2")
	r.scene.Teleports["tp-1"] = &domain.Teleport{ID: "tp-1", X: 300, Y: 300, TargetSceneID: "scene-2", Label: "Подвал"}
	r.scene.Tokens["tok-p"] = &domain.Token{ID: "tok-p", Label: "Ари", OwnerID: "p1", CharacterID: "char-1", X: 10, Y: 10}
	dm := &recordingDM{drawClient: drawClient{role: domain.RoleDM}}
	r.clients[dm] = true
	return r, dm
}

func TestTeleportAsksDMOnce(t *testing.T) {
	r, dm := teleportRoom()
	player := &drawClient{role: domain.RolePlayer, playerID: "p1", name: "Вася"}
	move := func(x, y float64) {
		r.applyOwnTokenMove(player, domain.ClientMsg{Token: &domain.Token{ID: "tok-p", X: x, Y: y}})
	}
	move(290, 300) // встал
	move(295, 300) // ёрзает на портале
	if len(dm.got) != 1 {
		t.Fatalf("ДМ спрошен %d раз, ожидался один", len(dm.got))
	}
	if dm.got[0]["type"] != "teleport_request" || dm.got[0]["targetSceneName"] != "Подвал" || dm.got[0]["playerName"] != "Вася" {
		t.Errorf("запрос: %+v", dm.got[0])
	}
	move(10, 10)   // сошёл
	move(300, 300) // снова встал — спрашиваем заново
	if len(dm.got) != 2 {
		t.Fatalf("после повторного захода ДМ спрошен %d раз", len(dm.got))
	}
}

func TestTeleportNoticesDMMove(t *testing.T) {
	r, dm := teleportRoom()
	r.applyMutation(domain.ClientMsg{Type: "move_token", Token: &domain.Token{ID: "tok-p", Label: "Ари", OwnerID: "p1", X: 300, Y: 300}})
	r.noticeTeleport("ДМ", r.scene.Tokens["tok-p"])
	if len(dm.got) != 1 || dm.got[0]["playerName"] != "ДМ" {
		t.Fatalf("запросы после хода ДМ: %+v", dm.got)
	}
}

func TestTeleportTokensMovesAndSwitches(t *testing.T) {
	r, _ := teleportRoom()
	r.scenes["scene-2"].Tokens["tok-old"] = &domain.Token{ID: "tok-old", CharacterID: "char-1"}
	r.applyMutation(domain.ClientMsg{Type: "teleport_tokens", ID: "tp-1", TokenIDs: []string{"tok-p", "tok-none"}})

	if r.currentSceneID != "scene-2" {
		t.Fatalf("стол не переключился: %q", r.currentSceneID)
	}
	if _, still := r.scenes["scene-1"].Tokens["tok-p"]; still {
		t.Error("токен остался на исходной сцене")
	}
	tok := r.scenes["scene-2"].Tokens["tok-p"]
	if tok == nil {
		t.Fatal("токен не приехал")
	}
	// Клетка правее обратного портала (радиус 24 + полклетки 24).
	if tok.X != 148 || tok.Y != 100 {
		t.Errorf("приземлился в (%v, %v)", tok.X, tok.Y)
	}
	if _, dup := r.scenes["scene-2"].Tokens["tok-old"]; dup {
		t.Error("старый токен того же персонажа не убран")
	}
	if !r.dirtyScenes["scene-1"] || !r.dirtyScenes["scene-2"] {
		t.Error("обе сцены должны быть помечены грязными")
	}
}

func TestTeleportTokensIgnoresBrokenTarget(t *testing.T) {
	r, _ := teleportRoom()
	r.scene.Teleports["tp-1"].TargetSceneID = "scene-gone"
	r.applyMutation(domain.ClientMsg{Type: "teleport_tokens", ID: "tp-1", TokenIDs: []string{"tok-p"}})
	if r.currentSceneID != "scene-1" || r.scene.Tokens["tok-p"] == nil {
		t.Error("портал в удалённую сцену не должен ничего делать")
	}
}

// localTeleportRoom — пара порталов в пределах одной сцены и токен игрока.
func localTeleportRoom() (*Room, *recordingDM) {
	r := drawingsRoom()
	r.scene.Teleports["tp-a"] = &domain.Teleport{ID: "tp-a", X: 300, Y: 300, Label: "Портал 1", TargetTeleportID: "tp-b"}
	r.scene.Teleports["tp-b"] = &domain.Teleport{ID: "tp-b", X: 900, Y: 500, Label: "Портал 1", TargetTeleportID: "tp-a"}
	r.scene.Tokens["tok-p"] = &domain.Token{ID: "tok-p", Label: "Ари", OwnerID: "p1", CharacterID: "char-1", X: 10, Y: 10}
	dm := &recordingDM{drawClient: drawClient{role: domain.RoleDM}}
	r.clients[dm] = true
	return r, dm
}

func TestLocalTeleportAsksDMWithTargetPortal(t *testing.T) {
	r, dm := localTeleportRoom()
	player := &drawClient{role: domain.RolePlayer, playerID: "p1", name: "Вася"}
	r.applyOwnTokenMove(player, domain.ClientMsg{Token: &domain.Token{ID: "tok-p", X: 300, Y: 300}})
	if len(dm.got) != 1 {
		t.Fatalf("ДМ спрошен %d раз, ожидался один", len(dm.got))
	}
	if dm.got[0]["targetTeleportId"] != "tp-b" || dm.got[0]["targetLabel"] != "Портал 1" || dm.got[0]["targetSceneId"] != nil {
		t.Errorf("запрос: %+v", dm.got[0])
	}
}

func TestLocalTeleportMovesWithinScene(t *testing.T) {
	r, _ := localTeleportRoom()
	r.applyMutation(domain.ClientMsg{Type: "teleport_tokens", ID: "tp-a", TokenIDs: []string{"tok-p", "tok-none"}})
	if r.currentSceneID != "scene-1" {
		t.Fatalf("стол переключился: %q", r.currentSceneID)
	}
	tok := r.scene.Tokens["tok-p"]
	if tok == nil {
		t.Fatal("токен пропал со сцены")
	}
	// Клетка правее второго портала (радиус 24 + полклетки 24).
	if tok.X != 948 || tok.Y != 500 {
		t.Errorf("приземлился в (%v, %v)", tok.X, tok.Y)
	}
	if !r.dirtyScenes["scene-1"] {
		t.Error("сцена должна быть помечена грязной")
	}
}

func TestRemoveTeleportUnlinksPair(t *testing.T) {
	r, dm := localTeleportRoom()
	r.applyMutation(domain.ClientMsg{Type: "remove_teleport", ID: "tp-b"})
	if r.scene.Teleports["tp-a"].TargetTeleportID != "" {
		t.Error("у второго конца пары осталась ссылка на удалённый портал")
	}
	r.noticeTeleport("ДМ", &domain.Token{ID: "tok-p", X: 300, Y: 300})
	if len(dm.got) != 0 {
		t.Errorf("портал без цели не должен спрашивать ДМ: %+v", dm.got)
	}
}
