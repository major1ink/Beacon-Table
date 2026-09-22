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

// TestSummonListRespectsFlags — игроку видны только разрешённые: свой флаг
// у карточки, встроенный каталог — общий тумблер стола.
func TestSummonListRespectsFlags(t *testing.T) {
	r, dm, pl := summonRoom()
	r.handleInbound(inboundMsg{from: pl, msg: domain.ClientMsg{Type: "summon_list"}})
	if got := pl.last("summon_list")["monsters"].([]summonable); len(got) != 1 || got[0].ID != "owl" {
		t.Fatalf("список без тумблера: %+v", got)
	}
	yes := true
	r.handleInbound(inboundMsg{from: dm, msg: domain.ClientMsg{Type: "set_summon_builtin", SummonBuiltin: &yes}})
	r.handleInbound(inboundMsg{from: pl, msg: domain.ClientMsg{Type: "summon_list"}})
	if got := pl.last("summon_list")["monsters"].([]summonable); len(got) != 2 {
		t.Errorf("с тумблером ожидались сова и волк: %+v", got)
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
