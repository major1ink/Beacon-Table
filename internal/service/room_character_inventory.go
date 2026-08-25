package service

// room_character_inventory.go — "у этого персонажа изменился инвентарь",
// адресно владельцу (тот же приём, что у broadcastCharacterHP в
// room_character_hp.go). Полезная нагрузка не несёт сами записи — получатель
// просто перечитывает инвентарь по HTTP (см. web/src/pages/character-sheet.js:
// connectRollSocket), тут только повод сделать это без перезагрузки страницы.
// Нужно потому, что инвентарь пополняется НЕ через открытый бланк персонажа
// (см. internal/service/characters.go): взять лут можно с любой другой
// страницы (хаб ДМа/труп на player.html) — окно с бланком, если оно уже
// открыто, иначе просто не узнало бы о новых вещах до ручной перезагрузки.
func (r *Room) broadcastCharacterInventory(characterID, accountID string) {
	if accountID == "" {
		return
	}
	payload := map[string]any{"type": "character_inventory", "characterId": characterID}
	for c := range r.clients {
		if c.PlayerID() == accountID {
			c.Send(payload)
		}
	}
}
