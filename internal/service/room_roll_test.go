package service

import (
	"testing"

	"beacon-table/internal/domain"
)

// rolls — полученные "roll_result".
func (c *chatClient) rolls() []map[string]any {
	var out []map[string]any
	for _, p := range c.got {
		if m, ok := p.(map[string]any); ok && m["type"] == "roll_result" {
			out = append(out, m)
		}
	}
	return out
}

func rollRoom() (*Room, *chatClient, *chatClient, *chatClient) {
	r, dm, p1, _, tv := chatRoom()
	r.dice = cryptoDiceRoller{}
	return r, dm, p1, tv
}

func TestRollResultCarriesRoller(t *testing.T) {
	r, dm, p1, tv := rollRoom()
	r.handleRollDice(p1, domain.ClientMsg{Type: "roll_dice", Formula: "1d20+2"})

	got := tv.rolls()
	if len(got) != 1 || got[0]["fromRole"] != "player" || got[0]["fromId"] != "acc-1" {
		t.Fatalf("трансляция должна получить бросок с автором: %v", got)
	}
	r.handleRollDice(dm, domain.ClientMsg{Type: "roll_dice", Formula: "1d6"})
	if last := p1.rolls()[1]; last["fromRole"] != "dm" || last["fromId"] != nil {
		t.Errorf("бросок ДМ помечается ролью без id: %v", last)
	}
}

func TestHiddenRollOnlyForDM(t *testing.T) {
	r, dm, p1, tv := rollRoom()
	yes := true
	r.handleRollDice(dm, domain.ClientMsg{Type: "roll_dice", Formula: "1d20", Hidden: &yes})

	if len(dm.rolls()) != 1 || dm.rolls()[0]["hidden"] != true {
		t.Errorf("ДМ должен видеть свой скрытый бросок с пометкой: %v", dm.rolls())
	}
	if len(p1.rolls()) != 0 || len(tv.rolls()) != 0 {
		t.Error("скрытый бросок ушёл игроку или на трансляцию")
	}

}

func TestPlayerHiddenRollForSelfAndDM(t *testing.T) {
	r, dm, p1, tv := rollRoom()
	sheet := &chatClient{role: domain.RolePlayer, playerID: "acc-1", name: "Валера"} // сокет листа того же игрока
	p2 := &chatClient{role: domain.RolePlayer, playerID: "acc-2", name: "Гость"}
	r.clients[sheet] = true
	r.clients[p2] = true
	yes := true
	r.handleRollDice(p1, domain.ClientMsg{Type: "roll_dice", Formula: "1d20", Hidden: &yes})

	if len(dm.rolls()) != 1 || len(p1.rolls()) != 1 || len(sheet.rolls()) != 1 {
		t.Error("скрытый бросок игрока должны видеть ДМ и сам игрок во всех своих окнах")
	}
	if len(p2.rolls()) != 0 || len(tv.rolls()) != 0 {
		t.Error("скрытый бросок игрока ушёл другому игроку или на трансляцию")
	}
}

func TestHideBroadcastDiceSkipsTV(t *testing.T) {
	r, _, p1, tv := rollRoom()
	r.combat.HideBroadcastDice = true
	r.handleRollDice(p1, domain.ClientMsg{Type: "roll_dice", Formula: "2d6"})

	if len(tv.rolls()) != 0 {
		t.Error("при выключенном показе трансляция не должна получать броски")
	}
	if len(p1.rolls()) != 1 {
		t.Error("игроки получают броски независимо от тумблера трансляции")
	}
}
