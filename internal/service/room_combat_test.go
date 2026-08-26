package service

import (
	"testing"

	"beacon-table/internal/domain"
)

// TestAddCombatantSkipsTokenAlreadyInCombat — регрессия на баг: монстра
// добавляли через поиск (боец без токена), вытаскивали его карточку из
// трекера на карту (handlePlaceCombatantToken проставляет TokenID), а затем
// ПКМ по этому же токену ещё раз слали "Добавить в инициативу". Раньше это
// заводило ВТОРОГО Combatant с тем же TokenID: у него нет своего токена на
// карте (единственный уже занят первым бойцом), а строка в трекере не
// draggable (combat-panel.js: draggable = !cmb.tokenId, а тут tokenId уже
// есть) — дубль было некуда пристроить. handleAddCombatant должен молча
// пропускать токен, для которого боец уже существует.
func TestAddCombatantSkipsTokenAlreadyInCombat(t *testing.T) {
	r := testRoom()
	r.dice = &fixedRoller{total: 15}

	r.handleAddCombatant(domain.ClientMsg{TokenID: "tok-1"})
	if len(r.combat.Combatants) != 1 {
		t.Fatalf("после первого добавления бойцов = %d, ожидался 1", len(r.combat.Combatants))
	}

	r.handleAddCombatant(domain.ClientMsg{TokenID: "tok-1"})
	if len(r.combat.Combatants) != 1 {
		t.Fatalf("после повторного добавления бойцов = %d, ожидался 1 (дубль не должен завестись)", len(r.combat.Combatants))
	}
}
