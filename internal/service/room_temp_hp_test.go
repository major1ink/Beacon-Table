package service

import (
	"context"
	"testing"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository/memory"
)

// Временные хиты (domain.Combatant.HPTemp): урон дельтой съедает их первыми,
// лечение в них не идёт и не поднимает выше максимума, а абсолютная правка
// поля по-прежнему ставит ровно то, что прислали (это решение ДМ, см.
// комментарий у handleSetCombatantHP).

func ptr(v int) *int { return &v }

func TestDamageEatsTempHPFirst(t *testing.T) {
	r := testRoom()
	r.combat.Combatants["c1"] = &domain.Combatant{ID: "c1", Name: "Гоблин", HPCurrent: 10, HPMax: 10, HPTemp: 4, CharacterID: "char-1"}

	r.handleSetCombatantHP("c1", nil, nil, nil, ptr(-3))
	cmb := r.combat.Combatants["c1"]
	if cmb.HPTemp != 1 || cmb.HPCurrent != 10 {
		t.Fatalf("после -3: врем. %d, текущие %d; ожидалось 1 и 10", cmb.HPTemp, cmb.HPCurrent)
	}

	// Остаток урона переливается в текущие хиты.
	r.handleSetCombatantHP("c1", nil, nil, nil, ptr(-5))
	if cmb.HPTemp != 0 || cmb.HPCurrent != 6 {
		t.Fatalf("после -5: врем. %d, текущие %d; ожидалось 0 и 6", cmb.HPTemp, cmb.HPCurrent)
	}
}

func TestHealDeltaSkipsTempAndStopsAtMax(t *testing.T) {
	r := testRoom()
	r.combat.Combatants["c1"] = &domain.Combatant{ID: "c1", Name: "Кайра", HPCurrent: 6, HPMax: 10, HPTemp: 2, CharacterID: "char-1"}

	r.handleSetCombatantHP("c1", nil, nil, nil, ptr(9))
	cmb := r.combat.Combatants["c1"]
	if cmb.HPCurrent != 10 {
		t.Errorf("текущие = %d, ожидалось 10 (потолок HPMax)", cmb.HPCurrent)
	}
	if cmb.HPTemp != 2 {
		t.Errorf("врем. = %d, ожидалось 2 — лечение временные хиты не трогает", cmb.HPTemp)
	}
}

func TestAbsoluteHPIsNotClamped(t *testing.T) {
	r := testRoom()
	r.combat.Combatants["c1"] = &domain.Combatant{ID: "c1", Name: "Кайра", HPCurrent: 6, HPMax: 10, CharacterID: "char-1"}

	// Овербафф поверх максимума — осознанная правка ДМ, сервер не спорит.
	r.handleSetCombatantHP("c1", ptr(14), nil, nil, nil)
	if got := r.combat.Combatants["c1"].HPCurrent; got != 14 {
		t.Errorf("текущие = %d, ожидалось 14", got)
	}
	// Отрицательные временные хиты бессмысленны — их сервер поджимает.
	r.handleSetCombatantHP("c1", nil, nil, ptr(-5), nil)
	if got := r.combat.Combatants["c1"].HPTemp; got != 0 {
		t.Errorf("врем. = %d, ожидалось 0", got)
	}
}

func TestTempHPDoesNotSaveMonsterFromDeath(t *testing.T) {
	r := testRoom()
	// Временные хиты кончились этим же ударом, остаток добил монстра —
	// он выбывает из инициативы сразу (спасбросков от смерти у него нет).
	r.combat.Combatants["c1"] = &domain.Combatant{ID: "c1", Name: "Гоблин", HPCurrent: 3, HPMax: 7, HPTemp: 2}

	r.handleSetCombatantHP("c1", nil, nil, nil, ptr(-9))
	if _, alive := r.combat.Combatants["c1"]; alive {
		t.Error("монстр остался в инициативе, хотя ушёл в ноль")
	}
}

// ---- хиты персонажа: трекер и лист держат одно число ----
// (см. room_character_hp.go — почему связь двусторонняя и «толчком»)

// hpClient — минимальный RoomClient: только запоминает, что ему прислали.
// Роль и id аккаунта задаются полями, чтобы проверить адресность рассылки
// "character_hp" (ДМ и владелец — да, посторонний игрок — нет).
type hpClient struct {
	role     domain.ClientRole
	playerID string
	got      []map[string]any
}

func (c *hpClient) Send(payload any) {
	if m, ok := payload.(map[string]any); ok {
		c.got = append(c.got, m)
	}
}
func (c *hpClient) Close()                  {}
func (c *hpClient) Role() domain.ClientRole { return c.role }
func (c *hpClient) PlayerID() string        { return c.playerID }
func (c *hpClient) PlayerName() string      { return "" }

func (c *hpClient) lastHP() map[string]any {
	for i := len(c.got) - 1; i >= 0; i-- {
		if c.got[i]["type"] == "character_hp" {
			return c.got[i]
		}
	}
	return nil
}

func roomWithCharacter(t *testing.T, sheetHP domain.CombatStats) (*Room, *memory.CharacterStore) {
	t.Helper()
	store := memory.NewCharacterStore()
	ch := &domain.Character{ID: "char-1", AccountID: "acc-1", Name: "Кайра"}
	ch.Sheet.Combat = sheetHP
	if err := store.Create(context.Background(), ch); err != nil {
		t.Fatalf("Create: %v", err)
	}
	r := testRoom()
	r.characters = store
	return r, store
}

func sheetHP(t *testing.T, store *memory.CharacterStore) domain.CombatStats {
	t.Helper()
	ch, err := store.ByID(context.Background(), "char-1")
	if err != nil {
		t.Fatalf("ByID: %v", err)
	}
	return ch.Sheet.Combat
}

func TestTrackerHPWritesIntoCharacterSheet(t *testing.T) {
	r, store := roomWithCharacter(t, domain.CombatStats{HPCurrent: 20, HPMax: 24, HPTemp: 5})
	r.combat.Combatants["c1"] = &domain.Combatant{
		ID: "c1", Name: "Кайра", CharacterID: "char-1", OwnerID: "acc-1",
		HPCurrent: 20, HPMax: 24, HPTemp: 5,
	}
	owner := &hpClient{role: domain.RolePlayer, playerID: "acc-1"}
	other := &hpClient{role: domain.RolePlayer, playerID: "acc-2"}
	dm := &hpClient{role: domain.RoleDM}
	r.clients[owner] = true
	r.clients[other] = true
	r.clients[dm] = true

	r.handleSetCombatantHP("c1", nil, nil, nil, ptr(-8)) // 5 временных + 3 текущих

	if got := sheetHP(t, store); got.HPCurrent != 17 || got.HPTemp != 0 {
		t.Errorf("в листе %d/%d врем. %d; ожидалось 17 и 0", got.HPCurrent, got.HPMax, got.HPTemp)
	}
	if got := owner.lastHP(); got == nil || got["hpCurrent"] != 17 || got["characterId"] != "char-1" {
		t.Errorf("владельцу не пришли новые хиты: %v", got)
	}
	if dm.lastHP() == nil {
		t.Error("ДМ не получил character_hp — у него бланк открыт рядом с трекером")
	}
	if other.lastHP() != nil {
		t.Error("посторонний игрок получил чужие хиты отдельным сообщением")
	}
}

func TestSheetSaveUpdatesTracker(t *testing.T) {
	r, store := roomWithCharacter(t, domain.CombatStats{HPCurrent: 20, HPMax: 24})
	r.combat.Combatants["c1"] = &domain.Combatant{
		ID: "c1", Name: "Кайра", CharacterID: "char-1", OwnerID: "acc-1", HPCurrent: 20, HPMax: 24,
	}
	// Игрок сам отметил урон на своём бланке — сохранение по HTTP будит
	// комнату (см. NotifyCharacterSheetChanged).
	if _, err := store.UpdateSheetHP(context.Background(), "char-1", 11, 3, 24); err != nil {
		t.Fatalf("UpdateSheetHP: %v", err)
	}
	r.applyCharacterSheetHP("char-1")

	cmb := r.combat.Combatants["c1"]
	if cmb.HPCurrent != 11 || cmb.HPTemp != 3 {
		t.Errorf("в трекере %d врем. %d; ожидалось 11 и 3", cmb.HPCurrent, cmb.HPTemp)
	}
}

func TestMonsterHPNeverTouchesCharacterSheet(t *testing.T) {
	r, store := roomWithCharacter(t, domain.CombatStats{HPCurrent: 20, HPMax: 24})
	// Монстр без CharacterID: его хиты живут только в трекере, лист чужого
	// персонажа они трогать не должны ни при каких обстоятельствах.
	r.combat.Combatants["c1"] = &domain.Combatant{ID: "c1", Name: "Гоблин", MonsterID: "m1", HPCurrent: 7, HPMax: 7}

	r.handleSetCombatantHP("c1", nil, nil, nil, ptr(-2))

	if got := sheetHP(t, store); got.HPCurrent != 20 {
		t.Errorf("лист персонажа поехал от урона по монстру: %d", got.HPCurrent)
	}
}
