package service

import (
	"testing"

	"beacon-table/internal/domain"
)

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
