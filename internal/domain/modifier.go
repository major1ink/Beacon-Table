package domain

import (
	"strconv"
	"strings"
)

// Modifier — ОДНО изменение числа: «−2 к КД», «скорость 0», «1к6 огнём в
// начале хода», «+2 к КД от щита». Общий тип для трёх мест, где такие
// изменения задаются:
//
//   - Condition.Modifiers — что делает состояние (см. condition.go);
//   - AppliedStatus.Modifiers — снимок этого списка на висящей метке;
//   - Item.Modifiers — что даёт НАДЕТЫЙ предмет (см. item.go,
//     InventoryEntry.Equipped).
//
// ГРАНИЦА, КОТОРУЮ ЭТО НЕ ПЕРЕХОДИТ. Это механизм применения изменений, а
// не движок правил D&D: приложение не знает, что кольчуга — это «14 + Лов
// не выше 2», что ослепление даёт помеху и что истощение 3-го уровня режет
// спасброски. Оно умеет ровно одно — взять базовое число, сложить с ним
// то, что перечислили в модификаторах, и показать результат. ЧТО именно
// перечислить, решает человек в конструкторе состояния/предмета (или
// импорт из Foundry, см. web/src/condition-import.js) — ровно так же, как
// он сам вводит КД монстра и урон оружия в остальных «умных бланках» (см.
// monster.go/spell.go/character_sheet.go).
//
// Отличие от ActiveEffect.changes в Foundry — не в идее (она та же), а в
// объёме: там ключом может быть ЛЮБОЕ поле модели актёра, потому что модель
// принадлежит системе правил; у нас ключи — закрытый список ModifierTargets
// ниже, ровно те числа, которые приложение реально показывает. Незнакомая
// цель молча игнорируется, а не роняет карточку.
type Modifier struct {
	// Target — что меняем, значение из ModifierTargets. Незнакомое —
	// игнорируется при применении (карточка при этом остаётся валидной:
	// каталог мог быть собран новой версией приложения).
	Target string `json:"target"`
	// Mode — как меняем: ModifierAdd/Set/Min/Max. Порядок применения внутри
	// одной цели фиксированный и не зависит от порядка записей: сначала
	// set (перебивает базу), потом сумма всех add, потом min, потом max.
	// Так «скорость 0» от опутанности и «+10 скорости» от зелья дают 0, а
	// не гонку за то, кто записан последним.
	Mode string `json:"mode"`
	// Value — число ("2", "-2") либо формула кубов ("1к6", "-1d6") для
	// периодических (Period != ""). У постоянного модификатора формула
	// кубов бессмысленна — такое значение просто не применится (см.
	// ApplyModifiers), но карточку не ломает.
	Value string `json:"value"`
	// Period — когда применяется: "" — постоянно, пока висит метка/надет
	// предмет; ModifierPeriodTurnStart/TurnEnd — разово, в начале/конце
	// хода того, на ком метка (см. service.Room.applyPeriodicModifiers).
	// Периодические имеют смысл только для Target == ModifierTargetHPCurrent
	// — «горит», «регенерация», «яд»; для остальных целей период
	// игнорируется.
	Period string `json:"period,omitempty"`
	// Note — подпись для лога и подсказки («огонь», «от кольчуги»). На
	// расчёт не влияет.
	Note string `json:"note,omitempty"`
}

// Цели модификаторов — закрытый список: ровно те числа, которые приложение
// умеет показать изменёнными. Расширять его — значит дописать применение в
// конкретном месте UI, поэтому список короткий и осознанный.
const (
	// ModifierTargetHPCurrent — текущие хиты. Единственная цель, у которой
	// осмыслен Period: «1к6 огнём в начале хода». Постоянный модификатор на
	// текущие хиты применять некуда (это не производное число, а счётчик,
	// который правят руками), поэтому он игнорируется.
	ModifierTargetHPCurrent = "hp.current"
	ModifierTargetHPMax     = "hp.max"
	ModifierTargetAC        = "ac"
	ModifierTargetSpeed     = "speed"
	// ModifierTargetInitiative — бонус к броску инициативы. Применяется
	// только там, где инициатива реально бросается (service.Room:
	// handleAddCombatant) — задним числом уже брошенную инициативу не
	// пересчитывает.
	ModifierTargetInitiative = "initiative"
	// Характеристики — правят и сам счёт, и всё, что фронт считает от него
	// (модификатор, спасброски, навыки), потому что считает он это по
	// формулам PHB на месте (см. web/src/pages/character-sheet.js).
	ModifierTargetStr = "abilities.str"
	ModifierTargetDex = "abilities.dex"
	ModifierTargetCon = "abilities.con"
	ModifierTargetInt = "abilities.int"
	ModifierTargetWis = "abilities.wis"
	ModifierTargetCha = "abilities.cha"
)

// Режимы (см. Modifier.Mode).
const (
	ModifierAdd = "add" // прибавить (значение может быть отрицательным)
	ModifierSet = "set" // заменить базу («скорость 0», «КД 13» от доспеха)
	ModifierMin = "min" // не ниже значения
	ModifierMax = "max" // не выше значения
)

// Периоды (см. Modifier.Period).
const (
	ModifierPeriodNone      = ""
	ModifierPeriodTurnStart = "turn-start"
	ModifierPeriodTurnEnd   = "turn-end"
)

// ModifierTargetLabels — человекочитаемые подписи целей для выпадашки
// конструктора. Держим их здесь, а не на клиенте, чтобы список целей и его
// подписи не разъезжались: клиент получает его как есть (см.
// GET /api/modifier-targets в internal/api/http/condition_handlers.go).
var ModifierTargetLabels = []struct {
	Target string `json:"target"`
	Label  string `json:"label"`
	// Periodic — можно ли у этой цели задать период (см. Modifier.Period).
	Periodic bool `json:"periodic,omitempty"`
}{
	{ModifierTargetHPCurrent, "Текущие хиты", true},
	{ModifierTargetHPMax, "Максимум хитов", false},
	{ModifierTargetAC, "КД", false},
	{ModifierTargetSpeed, "Скорость", false},
	{ModifierTargetInitiative, "Инициатива", false},
	{ModifierTargetStr, "Сила", false},
	{ModifierTargetDex, "Ловкость", false},
	{ModifierTargetCon, "Телосложение", false},
	{ModifierTargetInt, "Интеллект", false},
	{ModifierTargetWis, "Мудрость", false},
	{ModifierTargetCha, "Харизма", false},
}

// ValidModifierTarget — есть ли такая цель в закрытом списке.
func ValidModifierTarget(target string) bool {
	for _, t := range ModifierTargetLabels {
		if t.Target == target {
			return true
		}
	}
	return false
}

// TargetSupportsPeriod — осмыслен ли период у этой цели (см.
// Modifier.Period): сейчас только у текущих хитов.
func TargetSupportsPeriod(target string) bool {
	for _, t := range ModifierTargetLabels {
		if t.Target == target {
			return t.Periodic
		}
	}
	return false
}

// ValidModifierMode — известен ли режим.
func ValidModifierMode(mode string) bool {
	switch mode {
	case ModifierAdd, ModifierSet, ModifierMin, ModifierMax:
		return true
	}
	return false
}

// ValidModifierPeriod — известен ли период.
func ValidModifierPeriod(period string) bool {
	switch period {
	case ModifierPeriodNone, ModifierPeriodTurnStart, ModifierPeriodTurnEnd:
		return true
	}
	return false
}

// ParseModifierValue — Value как целое число. ok=false у формулы кубов и у
// мусора: постоянный модификатор с таким значением просто не применяется
// (см. ApplyModifiers), а периодический уходит в бросок как формула (см.
// service.Room.applyPeriodicModifiers). Русское "к" (1к6) приводим к "d"
// там, где формула действительно нужна, — здесь достаточно того, что такое
// значение НЕ число.
func ParseModifierValue(value string) (int, bool) {
	v, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil {
		return 0, false
	}
	return v, true
}

// ApplyModifiers — базовое число плюс все ПОСТОЯННЫЕ (Period == "")
// модификаторы указанной цели. Чистая функция: ничего не читает, кроме
// аргументов, и используется одинаково и на сервере (эффективный КД бойца в
// трекере), и — своей зеркальной копией — на клиенте (лист персонажа, см.
// web/src/modifiers.js, там же объяснение, почему копия, а не один код).
//
// Порядок фиксирован и не зависит от порядка записей в списке: set → add →
// min → max (см. Modifier.Mode). Несколько set подряд — побеждает
// НАИМЕНЬШИЙ: два доспеха одновременно не надевают, а если такое вышло,
// пусть лучше персонаж окажется слабее, чем сильнее, чем задумано.
func ApplyModifiers(base int, target string, mods []Modifier) int {
	result := base
	setDone := false
	add := 0
	minVal, hasMin := 0, false
	maxVal, hasMax := 0, false

	for _, m := range mods {
		if m.Target != target || m.Period != ModifierPeriodNone {
			continue
		}
		v, ok := ParseModifierValue(m.Value)
		if !ok {
			continue // формула кубов у постоянного модификатора — не число, пропускаем
		}
		switch m.Mode {
		case ModifierAdd:
			add += v
		case ModifierSet:
			if !setDone || v < result {
				result = v
				setDone = true
			}
		case ModifierMin:
			if !hasMin || v > minVal {
				minVal, hasMin = v, true
			}
		case ModifierMax:
			if !hasMax || v < maxVal {
				maxVal, hasMax = v, true
			}
		}
	}

	result += add
	if hasMin && result < minVal {
		result = minVal
	}
	if hasMax && result > maxVal {
		result = maxVal
	}
	return result
}

// HasModifiersFor — есть ли у списка хоть один постоянный модификатор этой
// цели. Нужен UI, чтобы не рисовать «КД 15 (без изменений)» там, где
// изменять нечего.
func HasModifiersFor(target string, mods []Modifier) bool {
	for _, m := range mods {
		if m.Target == target && m.Period == ModifierPeriodNone {
			if _, ok := ParseModifierValue(m.Value); ok {
				return true
			}
		}
	}
	return false
}
