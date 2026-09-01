package service

import (
	"math"
	"testing"

	"beacon-table/internal/domain"
)

func spawnReq(owner, char string) spawnTokenReq {
	return spawnTokenReq{ownerID: owner, characterID: char, label: "Гость", reply: make(chan bool, 1)}
}

// findToken — токен гостя на сцене (у него один на всю сцену владелец).
func findToken(t *testing.T, r *Room, ownerID string) *domain.Token {
	t.Helper()
	for _, tok := range r.scene.Tokens {
		if tok.OwnerID == ownerID {
			return tok
		}
	}
	t.Fatalf("токен владельца %q на сцене не найден", ownerID)
	return nil
}

// TestSpawnPlayerTokenGivesTorchInTheDark — главное, ради чего роль игрока в
// демо и заводится: на тёмной карте гость должен что-то видеть. Без факела
// обзор игрока пересекается с пустым слоем света, и экран остаётся чёрным
// (см. web/src/vtt/vision-plan.js).
func TestSpawnPlayerTokenGivesTorchInTheDark(t *testing.T) {
	r := testRoom()

	if placed := r.spawnPlayerToken(spawnReq("guest-1", "char-1")); !placed {
		t.Fatal("токен не поставлен")
	}
	tok := findToken(t, r, "guest-1")
	if tok.CharacterID != "char-1" {
		t.Errorf("токен не связан с персонажем: %q", tok.CharacterID)
	}
	if tok.Light == nil || !tok.Light.Enabled || tok.Light.Dim <= 0 {
		t.Fatalf("на тёмной карте гость без света: %+v", tok.Light)
	}
	if !r.dirtyScenes["scene-1"] {
		t.Error("сцена не помечена грязной — токен не переживёт рестарт")
	}

	// Освещённой целиком карте факел не нужен — там и так всё видно.
	r2 := testRoom()
	r2.scene.GlobalLight = "bright"
	r2.spawnPlayerToken(spawnReq("guest-2", ""))
	if tok := findToken(t, r2, "guest-2"); tok.Light != nil {
		t.Errorf("факел выдан на залитой светом карте: %+v", tok.Light)
	}
}

// TestSpawnPlayerTokenPrefersLitAnchor — гостя ставим у источника света, а не
// у первого попавшегося токена: он должен сразу увидеть, как свет работает.
func TestSpawnPlayerTokenPrefersLitAnchor(t *testing.T) {
	r := testRoom()
	r.scene.Tokens["tok-1"].X, r.scene.Tokens["tok-1"].Y = 100, 100
	r.scene.Tokens["tok-lamp"] = &domain.Token{
		ID: "tok-lamp", X: 600, Y: 400, LightOnly: true,
		Light: &domain.TokenLight{Enabled: true, Bright: 20, Dim: 40},
	}

	r.spawnPlayerToken(spawnReq("guest-1", ""))
	tok := findToken(t, r, "guest-1")
	if math.Hypot(tok.X-600, tok.Y-400) > 2*r.scene.Grid.Size {
		t.Fatalf("гость поставлен вдали от лампы: (%.0f, %.0f)", tok.X, tok.Y)
	}
}

// TestSpawnPlayerTokenKeepsGuestsApart — гости заходят один за другим, и
// слипшиеся в одну фишку токены не двигаются мышью по отдельности.
func TestSpawnPlayerTokenKeepsGuestsApart(t *testing.T) {
	r := testRoom()
	cell := r.scene.Grid.Size

	for _, id := range []string{"guest-1", "guest-2", "guest-3", "guest-4"} {
		if placed := r.spawnPlayerToken(spawnReq(id, "")); !placed {
			t.Fatalf("%s: токен не поставлен", id)
		}
	}
	for _, a := range r.scene.Tokens {
		for _, b := range r.scene.Tokens {
			if a.ID == b.ID {
				continue
			}
			if math.Hypot(a.X-b.X, a.Y-b.Y) < cell {
				t.Fatalf("токены %q и %q стоят вплотную", a.ID, b.ID)
			}
		}
		if a.X < 0 || a.Y < 0 || a.X > r.scene.Width || a.Y > r.scene.Height {
			t.Fatalf("токен %q за краем карты: (%.0f, %.0f)", a.ID, a.X, a.Y)
		}
	}
}

// TestSpawnPlayerTokenReplacesOwnToken — повторный вход тем же персонажем
// переносит его единственный токен, а не плодит копии (тот же инвариант,
// что и у драга персонажа ДМ-ом, см. dropDuplicateCharacterTokens).
func TestSpawnPlayerTokenReplacesOwnToken(t *testing.T) {
	r := testRoom()
	r.spawnPlayerToken(spawnReq("guest-1", "char-1"))
	r.spawnPlayerToken(spawnReq("guest-1", "char-1"))

	mine := 0
	for _, tok := range r.scene.Tokens {
		if tok.CharacterID == "char-1" {
			mine++
		}
	}
	if mine != 1 {
		t.Fatalf("у персонажа %d токенов, ожидали 1", mine)
	}
}
