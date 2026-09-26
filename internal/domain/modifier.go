package domain

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
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
// принадлежит системе правил; у нас цели трёх видов (см. CoreModifierTargets):
// числа ядра, свободные характеристики листа (stat.<ключ>) и цели, которые
// объявляет системный модуль. Незнакомая цель молча игнорируется при
// расчёте, а не роняет и не теряется из карточки.
type Modifier struct {
	// Target — что меняем: цель ядра, stat.<ключ> или цель системы (см.
	// CoreModifierTargets). Незнакомая — игнорируется при применении, но
	// хранится: карточку могли клонировать из мира на другой системе или
	// собрать новой версией приложения.
	Target string `json:"target"`
	// Mode — как меняем: ModifierAdd/Set/Div/Min/Max. Порядок применения
	// внутри одной цели фиксированный и не зависит от порядка записей:
	// сначала set (перебивает базу), потом сумма всех add, потом div
	// (делители перемножаются), потом min, потом max.
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
	// PerLevel — значение умножается на уровень метки (AppliedStatus.Level):
	// истощение даёт «−5 скорости за уровень». Только для числовых значений;
	// у формулы кубов и у меток без уровней множитель 1 (см. ScaleModifiers).
	PerLevel bool `json:"perLevel,omitempty"`
}

// ScaleModifiers — модификаторы метки с учётом её уровня: у PerLevel число
// умножается на level (не меньше 1), остальные копируются как есть. Так и
// сервер (Room.effectiveStat), и лист персонажа (web/src/modifiers.js:
// collectModifiers) считают одно и то же. Снимок в метке остаётся
// неумноженным — уровень ДМ меняет после наложения.
func ScaleModifiers(mods []Modifier, level int) []Modifier {
	if level < 1 {
		level = 1
	}
	out := make([]Modifier, 0, len(mods))
	for _, m := range mods {
		if m.PerLevel && level > 1 {
			if v, ok := ParseModifierValue(m.Value); ok {
				m.Value = strconv.Itoa(v * level)
			}
		}
		out = append(out, m)
	}
	return out
}

// Цели модификаторов ядра — числа, которые есть у бойца и листа в любой
// системе. Кроме них модификатор может менять свободную характеристику листа
// (StatTargetPrefix + ключ, см. StatKey) и цели, которые объявляет системный
// модуль (раздел modifierTargets в module.json — у D&D это шесть
// характеристик abilities.*).
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
)

// StatTargetPrefix — префикс цели свободной характеристики листа:
// "stat.сила", "stat.удача". Ключ — StatKey от названия характеристики.
const StatTargetPrefix = "stat."

// ModifierTargetInfo — цель с человекочитаемой подписью для конструктора.
type ModifierTargetInfo struct {
	Target string `json:"target"`
	Label  string `json:"label"`
	// Periodic — можно ли у этой цели задать период (см. Modifier.Period).
	Periodic bool `json:"periodic,omitempty"`
	// System — цель объявлена системным модулем, а не ядром.
	System bool `json:"system,omitempty"`
}

// CoreModifierTargets — цели ядра с подписями. Держим их здесь, а не на
// клиенте, чтобы список и подписи не разъезжались: клиент получает его
// вместе с целями системы мира (см. GET /api/modifier-targets в
// internal/api/http/condition_handlers.go).
var CoreModifierTargets = []ModifierTargetInfo{
	{Target: ModifierTargetHPCurrent, Label: "Текущие хиты", Periodic: true},
	{Target: ModifierTargetHPMax, Label: "Максимум хитов"},
	{Target: ModifierTargetAC, Label: "КД"},
	{Target: ModifierTargetSpeed, Label: "Скорость"},
	{Target: ModifierTargetInitiative, Label: "Инициатива"},
}

// Режимы (см. Modifier.Mode).
const (
	ModifierAdd = "add" // прибавить (значение может быть отрицательным)
	ModifierSet = "set" // заменить базу («скорость 0», «КД 13» от доспеха)
	ModifierMin = "min" // не ниже значения
	ModifierMax = "max" // не выше значения
	// ModifierDiv — разделить на значение с округлением вниз: «скорость
	// вдвое» у лежащего (value "2"). Делитель меньше 1 игнорируется.
	ModifierDiv = "div"
)

// Периоды (см. Modifier.Period).
const (
	ModifierPeriodNone      = ""
	ModifierPeriodTurnStart = "turn-start"
	ModifierPeriodTurnEnd   = "turn-end"
)

// maxTargetLen / maxStatKeyLen — санитарные пределы длины цели и ключа
// свободной характеристики.
const (
	maxTargetLen  = 64
	maxStatKeyLen = 32
)

// targetRe — синтаксис цели: сегменты из букв любого алфавита, цифр, _ и -,
// через точку.
var targetRe = regexp.MustCompile(`^[\p{L}\p{N}_-]+(\.[\p{L}\p{N}_-]+)*$`)

// ValidModifierTarget — годится ли строка в цель модификатора. Проверяется
// только синтаксис: цель, которую эта версия или система мира не знает,
// хранится и просто не применяется.
func ValidModifierTarget(target string) bool {
	return target != "" && utf8.RuneCountInString(target) <= maxTargetLen && targetRe.MatchString(target)
}

// IsCoreModifierTarget — цель ядра (не свободная характеристика и не цель
// системы).
func IsCoreModifierTarget(target string) bool {
	for _, t := range CoreModifierTargets {
		if t.Target == target {
			return true
		}
	}
	return false
}

// TargetSupportsPeriod — осмыслен ли период у этой цели (см.
// Modifier.Period): сейчас только у текущих хитов.
func TargetSupportsPeriod(target string) bool {
	for _, t := range CoreModifierTargets {
		if t.Target == target {
			return t.Periodic
		}
	}
	return false
}

// StatKey — ключ свободной характеристики по её названию: нижний регистр,
// пробелы → "_", остаются буквы любого алфавита, цифры, "_" и "-", не
// длиннее maxStatKeyLen. Так «Отравлен: Сила −2» из карточки состояния
// попадает в характеристику «сила» любого листа без ручного ввода ключей.
// Пустая строка — из названия ключа не получилось. Зеркало на клиенте —
// web/src/modifiers.js: statKey.
func StatKey(name string) string {
	var b strings.Builder
	n := 0
	pendingSep := false
	for _, r := range strings.ToLower(strings.TrimSpace(name)) {
		if n >= maxStatKeyLen {
			break
		}
		switch {
		case unicode.IsSpace(r):
			pendingSep = true
			continue
		case unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' || r == '-':
		default:
			continue
		}
		if pendingSep && n > 0 && n < maxStatKeyLen-1 {
			b.WriteRune('_')
			n++
		}
		pendingSep = false
		b.WriteRune(r)
		n++
	}
	return b.String()
}

// StatTarget — цель модификатора для свободной характеристики с таким
// названием; "" — если ключа из названия не получилось.
func StatTarget(name string) string {
	key := StatKey(name)
	if key == "" {
		return ""
	}
	return StatTargetPrefix + key
}

// ValidModifierMode — известен ли режим.
func ValidModifierMode(mode string) bool {
	switch mode {
	case ModifierAdd, ModifierSet, ModifierMin, ModifierMax, ModifierDiv:
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
// div → min → max (см. Modifier.Mode). Несколько set подряд — побеждает
// НАИМЕНЬШИЙ: два доспеха одновременно не надевают, а если такое вышло,
// пусть лучше персонаж окажется слабее, чем сильнее, чем задумано.
func ApplyModifiers(base int, target string, mods []Modifier) int {
	result := base
	setDone := false
	add := 0
	minVal, hasMin := 0, false
	maxVal, hasMax := 0, false
	div := 1

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
		case ModifierDiv:
			if v > 1 {
				div *= v
			}
		}
	}

	result += add
	if div > 1 {
		// Округление вниз и для отрицательных — floor, а не усечение к нулю.
		result = int(math.Floor(float64(result) / float64(div)))
	}
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
