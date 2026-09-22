package service

import (
	"context"
	"testing"

	"beacon-table/internal/domain"
)

// noopSceneStore — хранилище сцен, которое ничего не пишет: тестам удаления
// сцены нужен только сам вызов, не диск.
type noopSceneStore struct{}

func (noopSceneStore) Load(context.Context) (*domain.RoomSnapshot, error)          { return nil, nil }
func (noopSceneStore) SaveScene(context.Context, string, *domain.SceneState) error { return nil }
func (noopSceneStore) DeleteScene(context.Context, string) error                   { return nil }
func (noopSceneStore) SaveMeta(context.Context, string, []string) error            { return nil }
func (noopSceneStore) SaveCombat(context.Context, *domain.CombatState) error       { return nil }
func (noopSceneStore) SaveHub(context.Context, *domain.LootHub) error              { return nil }

// TestSceneCardsFollowSwitcherOrder — карточки сцен идут в порядке
// переключателя ДМ, с фоном и отметкой активной.
func TestSceneCardsFollowSwitcherOrder(t *testing.T) {
	r := testRoom()
	second := domain.NewScene("scene-2", "Подвал")
	second.MapURL = "/uploads/cellar.png"
	r.scenes["scene-2"] = second
	r.sceneOrder = []string{"scene-2", "scene-1", "scene-gone"}

	cards := r.sceneCards()
	if len(cards) != 2 {
		t.Fatalf("ожидались две карточки, получено %d", len(cards))
	}
	if cards[0].ID != "scene-2" || cards[0].MapURL != "/uploads/cellar.png" || cards[0].Current {
		t.Errorf("первая карточка: %+v", cards[0])
	}
	if cards[1].ID != "scene-1" || cards[1].Name != "Тест" || !cards[1].Current {
		t.Errorf("вторая карточка: %+v", cards[1])
	}
}

// sceneClient — RoomClient, запоминающий присланное: тесты смотрят, какую
// сцену несёт snapshot и что в scene_list.
type sceneClient struct {
	role     domain.ClientRole
	playerID string
	got      []map[string]any
}

func (c *sceneClient) Send(payload any) {
	if m, ok := payload.(map[string]any); ok {
		c.got = append(c.got, m)
	}
}
func (c *sceneClient) Close()                  {}
func (c *sceneClient) Role() domain.ClientRole { return c.role }
func (c *sceneClient) PlayerID() string        { return c.playerID }
func (c *sceneClient) PlayerName() string      { return c.playerID }

// last — последнее сообщение данного типа.
func (c *sceneClient) last(typ string) map[string]any {
	for i := len(c.got) - 1; i >= 0; i-- {
		if c.got[i]["type"] == typ {
			return c.got[i]
		}
	}
	return nil
}

func snapshotSceneID(m map[string]any) string {
	if m == nil {
		return ""
	}
	return m["scene"].(*domain.PublicScene).ID
}

// viewRoom — две сцены, активная scene-1; ДМ, игрок и трансляция за столом.
func viewRoom() (*Room, *sceneClient, *sceneClient, *sceneClient) {
	r := testRoom()
	r.store = noopSceneStore{}
	second := domain.NewScene("scene-2", "Подвал")
	second.AmbientURL = "/uploads/cellar.mp3"
	r.scenes["scene-2"] = second
	r.sceneOrder = []string{"scene-1", "scene-2"}
	r.scenes["scene-1"].AmbientURL = "/uploads/tavern.mp3"
	dm := &sceneClient{role: domain.RoleDM, playerID: "admin"}
	pl := &sceneClient{role: domain.RolePlayer, playerID: "acc-1"}
	tv := &sceneClient{role: domain.RoleTV}
	for _, c := range []RoomClient{dm, pl, tv} {
		r.clients[c] = true
	}
	return r, dm, pl, tv
}

// TestViewSceneOpensOnlyForSender — view_scene открывает сцену у ДМ, игрок и
// трансляция остаются на активной; scene_list различает активную и открытую.
func TestViewSceneOpensOnlyForSender(t *testing.T) {
	r, dm, pl, tv := viewRoom()
	r.handleInbound(inboundMsg{from: dm, msg: domain.ClientMsg{Type: "view_scene", SceneID: "scene-2"}})

	if got := snapshotSceneID(dm.last("snapshot")); got != "scene-2" {
		t.Errorf("ДМ видит %q, ожидалась scene-2", got)
	}
	if r.currentSceneID != "scene-1" {
		t.Errorf("активная сцена сменилась на %q", r.currentSceneID)
	}
	for name, c := range map[string]RoomClient{"игрок": pl, "трансляция": tv} {
		if got := r.sceneFor(c).ID; got != "scene-1" {
			t.Errorf("%s видит %q, ожидалась активная scene-1", name, got)
		}
	}
	list := dm.last("scene_list")
	if list["currentSceneId"] != "scene-1" || list["viewSceneId"] != "scene-2" {
		t.Errorf("scene_list: current=%v view=%v", list["currentSceneId"], list["viewSceneId"])
	}
	if entries := list["scenes"].([]domain.SceneListEntry); entries[0].ViewerCount != 2 || entries[1].ViewerCount != 0 {
		t.Errorf("зрители считаются не по факту: %+v", entries)
	}
	// Ответ ушёл только ДМ — игроку и трансляции слать нечего.
	if pl.last("snapshot") != nil || tv.last("snapshot") != nil {
		t.Error("view_scene не должен рассылать снапшоты остальным")
	}
}

// TestDMMutationLandsInViewedScene — правка ДМ ложится в открытую у него
// сцену, а не в активную; после обработки комната снова на активной.
func TestDMMutationLandsInViewedScene(t *testing.T) {
	r, dm, pl, _ := viewRoom()
	r.handleInbound(inboundMsg{from: dm, msg: domain.ClientMsg{Type: "view_scene", SceneID: "scene-2"}})
	r.handleInbound(inboundMsg{from: dm, msg: domain.ClientMsg{Type: "add_token", Token: &domain.Token{ID: "tok-new", Label: "Крыса"}}})

	if _, ok := r.scenes["scene-2"].Tokens["tok-new"]; !ok {
		t.Fatal("токен не попал в открытую у ДМ сцену")
	}
	if _, ok := r.scenes["scene-1"].Tokens["tok-new"]; ok {
		t.Error("токен попал в активную сцену")
	}
	if !r.dirtyScenes["scene-2"] || r.dirtyScenes["scene-1"] {
		t.Errorf("грязные сцены: %v", r.dirtyScenes)
	}
	if r.scene != r.scenes["scene-1"] {
		t.Error("между сообщениями r.scene должна быть активной сценой")
	}
	if got := snapshotSceneID(pl.last("snapshot")); got != "scene-1" {
		t.Errorf("игроку после правки ушла сцена %q", got)
	}
}

// TestSwitchSceneBringsEveryoneAlong — «показать игрокам» переключает
// активную и возвращает всех на неё, включая ДМ, смотревшего другую.
func TestSwitchSceneBringsEveryoneAlong(t *testing.T) {
	r, dm, pl, tv := viewRoom()
	r.handleInbound(inboundMsg{from: dm, msg: domain.ClientMsg{Type: "view_scene", SceneID: "scene-2"}})
	r.handleInbound(inboundMsg{from: dm, msg: domain.ClientMsg{Type: "switch_scene", SceneID: "scene-2"}})

	if r.currentSceneID != "scene-2" {
		t.Fatalf("активная %q", r.currentSceneID)
	}
	if len(r.viewing) != 0 {
		t.Errorf("viewing не сброшен: %v", r.viewing)
	}
	for name, c := range map[string]*sceneClient{"ДМ": dm, "игрок": pl, "трансляция": tv} {
		if got := snapshotSceneID(c.last("snapshot")); got != "scene-2" {
			t.Errorf("%s видит %q", name, got)
		}
	}
}

// TestSnapshotAmbientFollowsActiveScene — музыка в снапшоте от активной
// сцены, даже когда ДМ открыл у себя другую.
func TestSnapshotAmbientFollowsActiveScene(t *testing.T) {
	r, dm, _, _ := viewRoom()
	r.handleInbound(inboundMsg{from: dm, msg: domain.ClientMsg{Type: "view_scene", SceneID: "scene-2"}})
	snap := dm.last("snapshot")
	if snap["ambientUrl"] != "/uploads/tavern.mp3" {
		t.Errorf("ambientUrl = %v, ожидался трек активной сцены", snap["ambientUrl"])
	}
}

// TestDeleteViewedSceneFallsBackToActive — удалили сцену, открытую у ДМ —
// он возвращается на активную.
func TestDeleteViewedSceneFallsBackToActive(t *testing.T) {
	r, dm, _, _ := viewRoom()
	r.handleInbound(inboundMsg{from: dm, msg: domain.ClientMsg{Type: "view_scene", SceneID: "scene-2"}})
	r.handleInbound(inboundMsg{from: dm, msg: domain.ClientMsg{Type: "delete_scene", SceneID: "scene-2"}})
	if _, ok := r.viewing[dm]; ok {
		t.Error("viewing всё ещё ссылается на удалённую сцену")
	}
	if got := snapshotSceneID(dm.last("snapshot")); got != "scene-1" {
		t.Errorf("ДМ видит %q после удаления", got)
	}
}

// TestPlayerWalksOnlyAllowedScenes — игрок открывает сцену сам только с
// доступом; его список — доступные плюс активная.
func TestPlayerWalksOnlyAllowedScenes(t *testing.T) {
	r, dm, pl, _ := viewRoom()
	r.handleInbound(inboundMsg{from: pl, msg: domain.ClientMsg{Type: "view_scene", SceneID: "scene-2"}})
	if got := r.sceneFor(pl).ID; got != "scene-1" {
		t.Fatalf("игрок открыл закрытую сцену %q", got)
	}
	r.handleInbound(inboundMsg{from: pl, msg: domain.ClientMsg{Type: "chat_send", Text: "привет"}}) // любое сообщение — scene_list не шлётся
	r.broadcastSceneList()
	if entries := pl.last("scene_list")["scenes"].([]domain.SceneListEntry); len(entries) != 1 || entries[0].ID != "scene-1" {
		t.Errorf("список игрока до доступа: %+v", entries)
	}

	yes := true
	r.handleInbound(inboundMsg{from: dm, msg: domain.ClientMsg{Type: "set_scene_access", SceneID: "scene-2", PlayerAccess: &yes}})
	if entries := pl.last("scene_list")["scenes"].([]domain.SceneListEntry); len(entries) != 2 || !entries[1].PlayerAccess {
		t.Errorf("список игрока после доступа: %+v", entries)
	}
	r.handleInbound(inboundMsg{from: pl, msg: domain.ClientMsg{Type: "view_scene", SceneID: "scene-2"}})
	if got := snapshotSceneID(pl.last("snapshot")); got != "scene-2" {
		t.Errorf("игрок видит %q, ожидалась scene-2", got)
	}
	if r.currentSceneID != "scene-1" {
		t.Error("выбор игрока не должен менять активную сцену")
	}
	// Свой токен игрок двигает там, где стоит сам.
	r.scenes["scene-2"].Tokens["me"] = &domain.Token{ID: "me", OwnerID: "acc-1"}
	r.handleInbound(inboundMsg{from: pl, msg: domain.ClientMsg{Type: "move_own_token", Token: &domain.Token{ID: "me", X: 96, Y: 48}}})
	if tok := r.scenes["scene-2"].Tokens["me"]; tok.X != 96 {
		t.Errorf("токен не сдвинулся на открытой игроком сцене: %+v", tok)
	}

	// Доступ сняли — игрок возвращается на активную.
	no := false
	r.handleInbound(inboundMsg{from: dm, msg: domain.ClientMsg{Type: "set_scene_access", SceneID: "scene-2", PlayerAccess: &no}})
	if got := snapshotSceneID(pl.last("snapshot")); got != "scene-1" {
		t.Errorf("после снятия доступа игрок видит %q", got)
	}
}

// TestViewZoneClampsPlayerAndNormalizes — зона показа приводится к карте,
// «вся карта» схлопывается в nil, а токен игрока за зону не выходит.
func TestViewZoneClampsPlayerAndNormalizes(t *testing.T) {
	r, dm, pl, _ := viewRoom()
	r.scenes["scene-1"].Tokens["me"] = &domain.Token{ID: "me", OwnerID: "acc-1", X: 100, Y: 100}

	// Перевёрнутый прямоугольник, вылезающий за карту — нормализуется.
	r.handleInbound(inboundMsg{from: dm, msg: domain.ClientMsg{Type: "set_view_zone", SceneID: "scene-1", ViewZone: &domain.ViewZone{X: 500, Y: 400, W: -400, H: -1000}}})
	z := r.scenes["scene-1"].ViewZone
	if z == nil || z.X != 100 || z.Y != 0 || z.W != 400 || z.H != 400 {
		t.Fatalf("зона после нормализации: %+v", z)
	}
	if got := r.sceneFor(pl).ViewZone; got == nil || got.W != 400 {
		t.Errorf("зона не дошла до игрока: %+v", got)
	}

	r.handleInbound(inboundMsg{from: pl, msg: domain.ClientMsg{Type: "move_own_token", Token: &domain.Token{ID: "me", X: 900, Y: 50}}})
	if tok := r.scenes["scene-1"].Tokens["me"]; tok.X != 500 || tok.Y != 50 {
		t.Errorf("ход игрока не вжат в зону: %+v", tok)
	}

	// Вся карта — nil.
	r.handleInbound(inboundMsg{from: dm, msg: domain.ClientMsg{Type: "set_view_zone", SceneID: "scene-1", ViewZone: &domain.ViewZone{X: 0, Y: 0, W: 1280, H: 720}}})
	if r.scenes["scene-1"].ViewZone != nil {
		t.Error("зона во всю карту должна схлопнуться в nil")
	}
	// Снять явно.
	r.handleInbound(inboundMsg{from: dm, msg: domain.ClientMsg{Type: "set_view_zone", SceneID: "scene-1", ViewZone: &domain.ViewZone{X: 0, Y: 0, W: 300, H: 300}}})
	r.handleInbound(inboundMsg{from: dm, msg: domain.ClientMsg{Type: "set_view_zone", SceneID: "scene-1"}})
	if r.scenes["scene-1"].ViewZone != nil {
		t.Error("set_view_zone без зоны должен снимать её")
	}
}

// floorsRoom — башня из двух этажей (scene-1 земля, scene-2 верх), активна
// земля; у игрока токен на земле.
func floorsRoom() (*Room, *sceneClient, *sceneClient, *sceneClient) {
	r, dm, pl, tv := viewRoom()
	r.scenes["scene-1"].Building, r.scenes["scene-1"].Floor = "Башня", 0
	r.scenes["scene-2"].Building, r.scenes["scene-2"].Floor = "Башня", 1
	r.scenes["scene-2"].AmbientURL = "" // наследует трек земли
	r.scenes["scene-1"].Tokens["me"] = &domain.Token{ID: "me", OwnerID: "acc-1", X: 200, Y: 200}
	return r, dm, pl, tv
}

// TestFloorsPlayerFollowsOwnToken — ДМ перенёс токен игрока на верхний
// этаж: игрок видит верх, стол и трансляция остаются на земле, музыка не
// перезапускается, ДМ переехал взглядом сам.
func TestFloorsPlayerFollowsOwnToken(t *testing.T) {
	r, dm, pl, tv := floorsRoom()
	r.handleInbound(inboundMsg{from: dm, msg: domain.ClientMsg{Type: "move_tokens_to_scene", SceneID: "scene-2", TokenIDs: []string{"me"}}})

	if tok := r.scenes["scene-2"].Tokens["me"]; tok == nil || tok.X != 200 {
		t.Fatalf("токен не переехал на этаж с теми же координатами: %+v", tok)
	}
	if got := snapshotSceneID(pl.last("snapshot")); got != "scene-2" {
		t.Errorf("игрок видит %q, ожидался этаж своего токена", got)
	}
	if got := snapshotSceneID(tv.last("snapshot")); got != "scene-1" || r.currentSceneID != "scene-1" {
		t.Errorf("трансляция/активная ушли с земли: %q / %q", got, r.currentSceneID)
	}
	if snap := pl.last("snapshot"); snap["ambientUrl"] != "/uploads/tavern.mp3" {
		t.Errorf("амбиент верхнего этажа должен наследоваться от земли: %v", snap["ambientUrl"])
	}
	// Игрок сам двигает токен на своём этаже.
	r.handleInbound(inboundMsg{from: pl, msg: domain.ClientMsg{Type: "move_own_token", Token: &domain.Token{ID: "me", X: 300, Y: 300}}})
	if tok := r.scenes["scene-2"].Tokens["me"]; tok.X != 300 {
		t.Errorf("ход на своём этаже не прошёл: %+v", tok)
	}
	// «Показать игрокам» верхний этаж — трек тот же, старт не дёргаем.
	before := r.ambientStartedAtMs
	r.handleInbound(inboundMsg{from: dm, msg: domain.ClientMsg{Type: "switch_scene", SceneID: "scene-2"}})
	if r.ambientStartedAtMs != before {
		t.Error("переход по этажам под один трек не должен перезапускать амбиент")
	}
}

// TestFloorsTeleportStaysInBuilding — телепорт между этажами одного здания
// не переключает стол: владелец видит этаж по токену, ДМ открыл этаж у себя.
func TestFloorsTeleportStaysInBuilding(t *testing.T) {
	r, dm, pl, _ := floorsRoom()
	r.store = noopSceneStore{}
	r.scenes["scene-1"].Teleports["up"] = &domain.Teleport{ID: "up", X: 500, Y: 500, TargetSceneID: "scene-2"}
	r.handleInbound(inboundMsg{from: dm, msg: domain.ClientMsg{Type: "teleport_tokens", SceneID: "scene-1", ID: "up", TokenIDs: []string{"me"}}})
	if r.currentSceneID != "scene-1" {
		t.Fatalf("стол переключился на %q", r.currentSceneID)
	}
	if got := snapshotSceneID(pl.last("snapshot")); got != "scene-2" {
		t.Errorf("игрок видит %q", got)
	}
	if got := snapshotSceneID(dm.last("snapshot")); got != "scene-2" {
		t.Errorf("ДМ видит %q", got)
	}
	// Вернулся в список ДМ: этажи с именем здания.
	entries := dm.last("scene_list")["scenes"].([]domain.SceneListEntry)
	if entries[1].Building != "Башня" || entries[1].Floor != 1 {
		t.Errorf("scene_list без этажей: %+v", entries)
	}
}

// TestRenameBuildingTouchesAllFloors — здание — общее имя: переименование
// проходит по всем этажам.
func TestRenameBuildingTouchesAllFloors(t *testing.T) {
	r, dm, _, _ := floorsRoom()
	r.handleInbound(inboundMsg{from: dm, msg: domain.ClientMsg{Type: "rename_building", BuildingName: "Башня", SceneName: "Маяк"}})
	for _, id := range []string{"scene-1", "scene-2"} {
		if r.scenes[id].Building != "Маяк" {
			t.Errorf("%s: здание %q", id, r.scenes[id].Building)
		}
	}
	floor := 3
	r.handleInbound(inboundMsg{from: dm, msg: domain.ClientMsg{Type: "set_scene_building", SceneID: "scene-2", BuildingName: "", Floor: &floor}})
	if s := r.scenes["scene-2"]; s.Building != "" || s.Floor != 0 {
		t.Errorf("вывод из здания: %+v", s)
	}
}

// TestShowToPlayersOverridesOwnFloor — «Показать игрокам» сильнее этажа
// своего токена: у игрока токен на земле, ДМ показал подвал — игрок видит
// подвал. А вошедший заново игрок с токеном на другом этаже — свой этаж.
func TestShowToPlayersOverridesOwnFloor(t *testing.T) {
	r, dm, pl, _ := floorsRoom()
	r.handleInbound(inboundMsg{from: dm, msg: domain.ClientMsg{Type: "switch_scene", SceneID: "scene-2"}})
	if got := snapshotSceneID(pl.last("snapshot")); got != "scene-2" {
		t.Fatalf("после «Показать игрокам» игрок видит %q", got)
	}
	// Тот же игрок вошёл вторым окном — токен на земле, стол в подвале.
	pl2 := &sceneClient{role: domain.RolePlayer, playerID: "acc-1"}
	r.clients[pl2] = true
	if floor := r.floorOfPlayer(r.scenes[r.currentSceneID], pl2.PlayerID()); floor != nil {
		r.setViewing(pl2, floor.ID)
	}
	if got := r.sceneFor(pl2).ID; got != "scene-1" {
		t.Errorf("вошедший игрок должен увидеть этаж своего токена, а видит %q", got)
	}
}
