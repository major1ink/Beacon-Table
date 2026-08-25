package service

import (
	"context"
	"log"

	"beacon-table/internal/domain"
)

// room_character_hp.go — хиты игрового персонажа в двух местах сразу.
//
// Боец в трекере инициативы (domain.Combatant) держит СВОИ HPCurrent/HPTemp/
// HPMax, а не ссылку на лист персонажа: у монстра и голого NPC-токена листа
// нет вообще, а рассылка combat_state идёт из горутины комнаты, которой
// нельзя ходить в репозиторий на каждый кадр. Из-за этого до появления этого
// файла числа расходились: ДМ правил хиты в трекере, игрок смотрел на свой
// бланк и видел старые.
//
// Связь двусторонняя и обе стороны — «толчок», а не «опрос»:
//
//	трекер → лист   syncCharacterHP: после любой правки хитов бойца с
//	                CharacterID пишем их в лист точечным UpdateSheetHP (не
//	                перезаписью листа целиком — см. комментарий в
//	                repository.CharacterRepository) и шлём открытым бланкам
//	                "character_hp", чтобы цифра на экране игрока поменялась
//	                сразу, а не после перезагрузки страницы;
//	лист → трекер   applyCharacterSheetHP: бланк сохраняется по HTTP (см.
//	                NotifyCharacterSheetChanged из хендлеров), комната
//	                перечитывает лист и подтягивает хиты в бойца.
//
// Гонка «игрок правит что-то на бланке, пока ДМ бьёт его в трекере» закрыта
// не блокировкой, а тем, что бланк получает "character_hp" в свою же копию
// листа (см. web/src/pages/character-sheet.js): его следующий автосейв
// увезёт на сервер уже новые хиты, а не те, что были на экране до удара.

// syncCharacterHP — трекер → лист. Тихо ничего не делает для бойца без
// персонажа за спиной (монстр/NPC): их хиты живут только в трекере.
func (r *Room) syncCharacterHP(cmb *domain.Combatant) {
	if cmb == nil || cmb.CharacterID == "" || r.characters == nil {
		return
	}
	if _, err := r.characters.UpdateSheetHP(context.Background(), cmb.CharacterID, cmb.HPCurrent, cmb.HPTemp, cmb.HPMax); err != nil {
		// Не роняем ход боя из-за недоступной базы: трекер продолжает
		// работать на своих числах, разъедется только бланк — и об этом
		// должно быть видно в логе сервера, а не только по жалобе за столом.
		log.Printf("не удалось записать хиты в лист персонажа %s: %v", cmb.CharacterID, err)
		return
	}
	r.broadcastCharacterHP(cmb)
}

// broadcastCharacterHP — «в листе этого персонажа теперь такие хиты».
// Адресно: ДМ (у него бланк открыт в боковой колонке рядом с трекером) и
// владелец персонажа. Остальным игрокам чужие хиты через этот канал не
// нужны — то, что им положено видеть в бою, они и так получают в
// combat_state (см. combatPayload и domain.CombatState.ShowHP).
func (r *Room) broadcastCharacterHP(cmb *domain.Combatant) {
	payload := map[string]any{
		"type":        "character_hp",
		"characterId": cmb.CharacterID,
		"hpCurrent":   cmb.HPCurrent,
		"hpTemp":      cmb.HPTemp,
		"hpMax":       cmb.HPMax,
	}
	for c := range r.clients {
		if c.Role() == domain.RoleDM || (cmb.OwnerID != "" && c.PlayerID() == cmb.OwnerID) {
			c.Send(payload)
		}
	}
}

// NotifyCharacterSheetChanged — см. RoomService. Неблокирующая отправка по
// той же причине, что и у NotifyJournalChanged: сохранение листа не должно
// ждать занятую (или уже остановленную) горутину комнаты, а потеря события —
// это в худшем случае «трекер отстал до следующего сохранения», не порча
// данных.
func (r *Room) NotifyCharacterSheetChanged(characterID string) {
	select {
	case r.characterSheetChanged <- characterID:
	default:
	}
}

// applyCharacterSheetHP — лист → трекер, уже внутри горутины run().
// Никаких боевых последствий тут нет намеренно: персонаж, ушедший в ноль на
// своём бланке, в трекере просто показывает ноль и ждёт спасбросков от
// смерти — ровно как если бы ДМ вбил тот же ноль руками (см.
// handleSetCombatantHP), а отмечает их всё равно ДМ.
func (r *Room) applyCharacterSheetHP(characterID string) {
	if characterID == "" || r.characters == nil {
		return
	}
	ch, err := r.characters.ByID(context.Background(), characterID)
	if err != nil || ch == nil {
		return
	}
	changed := false
	for _, cmb := range r.combat.Combatants {
		if cmb.CharacterID != characterID {
			continue
		}
		hp := ch.Sheet.Combat
		if cmb.HPCurrent == hp.HPCurrent && cmb.HPTemp == hp.HPTemp && cmb.HPMax == hp.HPMax {
			continue
		}
		cmb.HPCurrent, cmb.HPTemp, cmb.HPMax = hp.HPCurrent, hp.HPTemp, hp.HPMax
		changed = true
	}
	if !changed {
		return
	}
	r.markCombatDirty()
	r.broadcastCombat()
}
