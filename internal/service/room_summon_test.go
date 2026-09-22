package service

import (
	"context"
	"testing"

	"beacon-table/internal/domain"
)

// fakeMonsters — бестиарий в памяти: тестам призыва нужны только List/Get.
type fakeMonsters struct{ list []*domain.Monster }

func (f *fakeMonsters) List(context.Context) ([]*domain.Monster, error) { return f.list, nil }
func (f *fakeMonsters) Get(_ context.Context, id string) (*domain.Monster, error) {
	for _, m := range f.list {
		if m.ID == id {
			return m, nil
		}
	}
	return nil, domain.ErrNotFound
}
func (f *fakeMonsters) Create(context.Context, string, *domain.Monster) error { return nil }
func (f *fakeMonsters) Update(context.Context, string, *domain.Monster) (bool, error) {
	return true, nil
}
func (f *fakeMonsters) Delete(context.Context, string) error { return nil }

func summonRoom() (*Room, *sceneClient, *sceneClient) {
	r, dm, pl, _ := viewRoom()
	r.monsters = &fakeMonsters{list: []*domain.Monster{
		{ID: "owl", Name: "Сова", Summonable: true, ImageURL: "/uploads/tokens/owl.png"},
		{ID: "dragon", Name: "Дракон"},
		{ID: "wolf", Name: "Волк", System: true},
	}}
	r.scenes["scene-1"].Tokens["me"] = &domain.Token{ID: "me", OwnerID: "acc-1", X: 240, Y: 240}
	return r, dm, pl
}

func statusOf(c *sceneClient) map[string]any { return c.last("summon_status") }

// TestSummonListRespectsFlags — игроку видны только разрешённые: флаг у
// карточки, либо вся библиотека по тумблеру стола.
func TestSummonListRespectsFlags(t *testing.T) {
	r, dm, pl := summonRoom()
	r.handleInbound(inboundMsg{from: pl, msg: domain.ClientMsg{Type: "summon_list"}})
	if got := pl.last("summon_list")["monsters"].([]summonable); len(got) != 1 || got[0].ID != "owl" {
		t.Fatalf("список без тумблера: %+v", got)
	}
	yes := true
	r.handleInbound(inboundMsg{from: dm, msg: domain.ClientMsg{Type: "set_summon_all", SummonAll: &yes}})
	r.handleInbound(inboundMsg{from: pl, msg: domain.ClientMsg{Type: "summon_list"}})
	if got := pl.last("summon_list")["monsters"].([]summonable); len(got) != 3 {
		t.Errorf("с тумблером ожидалась вся библиотека: %+v", got)
	}
}

// TestSummonFlowApproved — запрос → ДМ → подтверждение: токены рядом с
// фишкой игрока, владелец — игрок, количество — сколько разрешил ДМ.
func TestSummonFlowApproved(t *testing.T) {
	r, dm, pl := summonRoom()
	r.handleInbound(inboundMsg{from: pl, msg: domain.ClientMsg{Type: "summon_request", MonsterID: "owl", Count: 3}})
	if st := statusOf(pl); st["status"] != "pending" {
		t.Fatalf("статус игроку: %+v", st)
	}
	req := dm.last("summon_request")
	if req == nil || req["monsterName"] != "Сова" || req["count"] != 3 || req["playerName"] != "acc-1" {
		t.Fatalf("запрос ДМ: %+v", req)
	}
	r.handleInbound(inboundMsg{from: dm, msg: domain.ClientMsg{Type: "summon_resolve", RequestID: req["requestId"].(string), Count: 2}})
	owls := 0
	for _, tok := range r.scenes["scene-1"].Tokens {
		if tok.MonsterID != "owl" {
			continue
		}
		owls++
		if tok.OwnerID != "acc-1" || tok.X == 240 && tok.Y == 240 {
			t.Errorf("сова не у игрока или на его месте: %+v", tok)
		}
	}
	if owls != 2 {
		t.Errorf("сов на карте %d, ДМ разрешил 2", owls)
	}
	if st := statusOf(pl); st["status"] != "approved" || st["count"] != 2 {
		t.Errorf("итог игроку: %+v", st)
	}
	if got := snapshotSceneID(pl.last("snapshot")); got != "scene-1" {
		t.Error("игрок не получил снапшот с совами")
	}
}

// TestSummonRejections — запрещённое существо, нет фишки, нет ДМ, отказ ДМ.
func TestSummonRejections(t *testing.T) {
	r, dm, pl := summonRoom()
	r.handleInbound(inboundMsg{from: pl, msg: domain.ClientMsg{Type: "summon_request", MonsterID: "dragon", Count: 1}})
	if st := statusOf(pl); st["status"] != "rejected" {
		t.Errorf("дракон без флага должен быть отклонён: %+v", st)
	}
	r.handleInbound(inboundMsg{from: pl, msg: domain.ClientMsg{Type: "summon_request", MonsterID: "owl", Count: 1}})
	req := dm.last("summon_request")
	r.handleInbound(inboundMsg{from: dm, msg: domain.ClientMsg{Type: "summon_resolve", RequestID: req["requestId"].(string), Count: 0}})
	if st := statusOf(pl); st["status"] != "rejected" {
		t.Errorf("отказ ДМ не дошёл: %+v", st)
	}
	if len(r.summons) != 0 {
		t.Error("решённый запрос должен быть забыт")
	}

	delete(r.scenes["scene-1"].Tokens, "me")
	r.handleInbound(inboundMsg{from: pl, msg: domain.ClientMsg{Type: "summon_request", MonsterID: "owl", Count: 1}})
	if st := statusOf(pl); st["status"] != "rejected" || st["reason"] == "" {
		t.Errorf("без фишки нужен отказ с причиной: %+v", st)
	}

	delete(r.clients, dm)
	r.scenes["scene-1"].Tokens["me"] = &domain.Token{ID: "me", OwnerID: "acc-1"}
	r.handleInbound(inboundMsg{from: pl, msg: domain.ClientMsg{Type: "summon_request", MonsterID: "owl", Count: 1}})
	if st := statusOf(pl); st["status"] != "rejected" {
		t.Errorf("без ДМ нужен отказ: %+v", st)
	}
}

// TestPlayerEditsOnlyOwnToken — форма/зрение/свет, метки и удаление —
// только на своём токене; чужой не трогается, фишку персонажа не убрать.
func TestPlayerEditsOnlyOwnToken(t *testing.T) {
	r, _, pl := summonRoom()
	sc := r.scenes["scene-1"]
	sc.Tokens["me"].MonsterID = "owl"
	sc.Tokens["pc"] = &domain.Token{ID: "pc", OwnerID: "acc-1", CharacterID: "char-1"}
	sc.Tokens["foe"] = &domain.Token{ID: "foe", Label: "Гоблин"}

	r.handleInbound(inboundMsg{from: pl, msg: domain.ClientMsg{Type: "update_own_token", Token: &domain.Token{ID: "me", Shape: "square", Vision: &domain.TokenVision{Mode: "dark", Range: 60}, Light: &domain.TokenLight{Enabled: true, Bright: 20, Dim: 40}, Hidden: true, X: 999}}})
	me := sc.Tokens["me"]
	if me.Shape != "square" || me.Vision == nil || me.Vision.Range != 60 || me.Light == nil || !me.Light.Enabled {
		t.Errorf("правка своего токена не прошла: %+v", me)
	}
	if me.Hidden || me.X == 999 {
		t.Errorf("игрок не должен менять скрытость и позицию через update_own_token: %+v", me)
	}
	r.handleInbound(inboundMsg{from: pl, msg: domain.ClientMsg{Type: "update_own_token", Token: &domain.Token{ID: "foe", Shape: "square"}}})
	if sc.Tokens["foe"].Shape != "" {
		t.Error("чужой токен изменён")
	}
	r.handleInbound(inboundMsg{from: pl, msg: domain.ClientMsg{Type: "apply_status", TokenID: "foe", StatusSlug: "prone"}})
	if len(sc.Tokens["foe"].Statuses) != 0 {
		t.Error("метка легла на чужой токен")
	}
	r.handleInbound(inboundMsg{from: pl, msg: domain.ClientMsg{Type: "apply_status", TokenID: "me", StatusSlug: "prone"}})
	if len(sc.Tokens["me"].Statuses) != 1 {
		t.Error("метка на свой токен не легла")
	}
	r.handleInbound(inboundMsg{from: pl, msg: domain.ClientMsg{Type: "remove_own_token", ID: "pc"}})
	r.handleInbound(inboundMsg{from: pl, msg: domain.ClientMsg{Type: "remove_own_token", ID: "foe"}})
	r.handleInbound(inboundMsg{from: pl, msg: domain.ClientMsg{Type: "remove_own_token", ID: "me"}})
	if _, ok := sc.Tokens["pc"]; !ok {
		t.Error("фишку персонажа игрок убирать не должен")
	}
	if _, ok := sc.Tokens["foe"]; !ok {
		t.Error("чужой токен убран")
	}
	if _, ok := sc.Tokens["me"]; ok {
		t.Error("свой призванный токен не убран")
	}
}
