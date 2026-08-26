package service

import (
	"testing"

	"beacon-table/internal/domain"
)

// В бою двигать можно только токен, чей сейчас ход — и игроку, и ДМ (см.
// room_statuses.go: turnAllowsTokenMove). Тесты собирают *Room напрямую, тем
// же приёмом, что и room_statuses_test.go: broadcast* при пустом r.clients
// ничего не делает, actor-горутина run() не нужна.

func TestApplyOwnTokenMoveBlockedOutOfTurn(t *testing.T) {
	r := testRoom()
	r.scene.Tokens["tok-1"].OwnerID = "player-1"
	r.combat.Active = true
	r.combat.CurrentID = "c2"
	r.combat.Combatants["c1"] = &domain.Combatant{ID: "c1", TokenID: "tok-1"}
	r.combat.Combatants["c2"] = &domain.Combatant{ID: "c2"}

	c := &hpClient{playerID: "player-1"}
	r.applyOwnTokenMove(c, domain.ClientMsg{Type: "move_own_token", Token: &domain.Token{ID: "tok-1", X: 100, Y: 100}})

	tok := r.scene.Tokens["tok-1"]
	if tok.X != 0 || tok.Y != 0 {
		t.Fatalf("токен подвинулся не в свой ход: x=%v y=%v", tok.X, tok.Y)
	}

	// Ход перешёл к c1 — то же перемещение теперь проходит.
	r.combat.CurrentID = "c1"
	r.applyOwnTokenMove(c, domain.ClientMsg{Type: "move_own_token", Token: &domain.Token{ID: "tok-1", X: 100, Y: 100}})
	tok = r.scene.Tokens["tok-1"]
	if tok.X != 100 || tok.Y != 100 {
		t.Fatalf("токен не подвинулся в свой ход: x=%v y=%v", tok.X, tok.Y)
	}
}

func TestApplyOwnTokenMoveFreeOutsideCombat(t *testing.T) {
	r := testRoom()
	r.scene.Tokens["tok-1"].OwnerID = "player-1"
	r.combat.Combatants["c1"] = &domain.Combatant{ID: "c1", TokenID: "tok-1"}
	// combat.Active остаётся false — бой не начат.

	c := &hpClient{playerID: "player-1"}
	r.applyOwnTokenMove(c, domain.ClientMsg{Type: "move_own_token", Token: &domain.Token{ID: "tok-1", X: 50, Y: 50}})

	tok := r.scene.Tokens["tok-1"]
	if tok.X != 50 || tok.Y != 50 {
		t.Fatalf("вне боя движение должно быть свободным: x=%v y=%v", tok.X, tok.Y)
	}
}

func TestApplyMutationMoveTokenBlockedOutOfTurnForDM(t *testing.T) {
	r := testRoom()
	r.combat.Active = true
	r.combat.CurrentID = "c2"
	r.combat.Combatants["c1"] = &domain.Combatant{ID: "c1", TokenID: "tok-1"}
	r.combat.Combatants["c2"] = &domain.Combatant{ID: "c2"}

	// Позиция не должна поменяться — сейчас не ход c1.
	r.applyMutation(domain.ClientMsg{Type: "move_token", Token: &domain.Token{ID: "tok-1", X: 200, Y: 200, Hidden: true}})
	tok := r.scene.Tokens["tok-1"]
	if tok.X != 0 || tok.Y != 0 {
		t.Fatalf("ДМ подвинул токен не в его ход: x=%v y=%v", tok.X, tok.Y)
	}
	// Отбрасывается всё сообщение целиком — hidden тоже не применился.
	if tok.Hidden {
		t.Fatalf("сообщение вне хода должно быть отброшено целиком, а не частично")
	}

	// Свойство, не меняющее позицию (та же X/Y), проходит и вне хода этого бойца.
	r.applyMutation(domain.ClientMsg{Type: "move_token", Token: &domain.Token{ID: "tok-1", X: 0, Y: 0, Hidden: true}})
	tok = r.scene.Tokens["tok-1"]
	if !tok.Hidden {
		t.Fatalf("правка без изменения позиции должна проходить в любой ход")
	}

	// Ход перешёл к c1 — теперь можно и подвинуть.
	r.combat.CurrentID = "c1"
	r.applyMutation(domain.ClientMsg{Type: "move_token", Token: &domain.Token{ID: "tok-1", X: 200, Y: 200, Hidden: true}})
	tok = r.scene.Tokens["tok-1"]
	if tok.X != 200 || tok.Y != 200 {
		t.Fatalf("ДМ должен мочь двигать токен в его ход: x=%v y=%v", tok.X, tok.Y)
	}
}

func TestApplyMutationMoveTokenFreeWhenNotInCombat(t *testing.T) {
	r := testRoom()
	r.combat.Active = true
	r.combat.CurrentID = "c2"
	r.combat.Combatants["c2"] = &domain.Combatant{ID: "c2"}
	// tok-1 не привязан ни к одному бойцу — декорация, не участвует в инициативе.

	r.applyMutation(domain.ClientMsg{Type: "move_token", Token: &domain.Token{ID: "tok-1", X: 300, Y: 300}})
	tok := r.scene.Tokens["tok-1"]
	if tok.X != 300 || tok.Y != 300 {
		t.Fatalf("токен вне инициативы должен двигаться свободно даже в бою: x=%v y=%v", tok.X, tok.Y)
	}
}
