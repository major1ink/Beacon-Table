package service

import (
	"testing"

	"beacon-table/internal/domain"
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
