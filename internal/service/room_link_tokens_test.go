package service

import (
	"testing"

	"beacon-table/internal/domain"
)

// TestRoomLinkTokensToMonsters — настоящая реализация связывания в комнате
// (в отличие от TestFoundryLinkSceneTokens, который проверяет сервис поверх
// фейка). Главное здесь — что проход идёт по ВСЕМ сценам, а не только по
// открытой: пак с актёрами импортируют один раз, а сцен у приключения много.
func TestRoomLinkTokensToMonsters(t *testing.T) {
	r := testRoom()

	// Активная сцена (scene-1) — гоблин с якорем и уже привязанный руками вожак.
	active := r.scenes["scene-1"]
	active.Tokens["tok-goblin"] = &domain.Token{ID: "tok-goblin", Label: "Гоблин-воитель", FoundryActorID: "actor-goblin"}
	active.Tokens["tok-manual"] = &domain.Token{ID: "tok-manual", Label: "Вожак", FoundryActorID: "actor-goblin", MonsterID: "my-own"}

	// Вторая сцена того же приключения — она сейчас закрыта, но статблоки
	// должны появиться и на ней.
	other := domain.NewScene("scene-2", "Пещера")
	other.Tokens["tok-orc"] = &domain.Token{ID: "tok-orc", Label: "Орк", FoundryActorID: "actor-orc"}
	other.Tokens["tok-lamp"] = &domain.Token{ID: "tok-lamp", LightOnly: true} // якоря нет — связывать нечего
	r.scenes["scene-2"] = other
	r.sceneOrder = append(r.sceneOrder, "scene-2")

	linked := r.linkTokensToMonsters(map[string]string{
		"actor-goblin": "mon-goblin",
		"actor-orc":    "mon-orc",
		"actor-unused": "mon-unused", // карточка есть, а токена такого на картах нет
	})

	if linked != 2 {
		t.Fatalf("связали %d токенов, ожидали 2", linked)
	}
	if got := active.Tokens["tok-goblin"].MonsterID; got != "mon-goblin" {
		t.Fatalf("гоблин на активной сцене: %q", got)
	}
	if got := other.Tokens["tok-orc"].MonsterID; got != "mon-orc" {
		t.Fatalf("орк на закрытой сцене не связан: %q", got)
	}
	if got := active.Tokens["tok-manual"].MonsterID; got != "my-own" {
		t.Fatalf("ручная привязка перебита: %q", got)
	}
	if got := other.Tokens["tok-lamp"].MonsterID; got != "" {
		t.Fatalf("токен света получил статблок: %q", got)
	}
	// Обе сцены должны уехать в автосейв — иначе связь не переживёт рестарт.
	if !r.dirtyScenes["scene-1"] || !r.dirtyScenes["scene-2"] {
		t.Fatalf("не все правленые сцены помечены грязными: %v", r.dirtyScenes)
	}

	// Повтор ничего не меняет — шаг идемпотентен (клиент зовёт его на каждом
	// импорте, в том числе когда связывать давно нечего).
	if again := r.linkTokensToMonsters(map[string]string{"actor-goblin": "mon-goblin"}); again != 0 {
		t.Fatalf("повторный проход связал %d токенов, ожидали 0", again)
	}
}
