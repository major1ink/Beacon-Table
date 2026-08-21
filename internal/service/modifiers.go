package service

import (
	"strings"

	"beacon-table/internal/domain"
)

// modifiers.go — санитайзер списка модификаторов (см. domain.Modifier),
// общий для карточки состояния и карточки предмета: оба принимают один и
// тот же список, и оба должны отбрасывать мусор одинаково. Отдельный файл, а
// не функция внутри conditions.go, ровно поэтому — его зовут два разных
// сервиса.

const (
	// maxModifiers — сколько изменений максимум на одной карточке. Не
	// правило, а тот же санитарный предел, что у тегов: у реального
	// состояния или предмета их единицы.
	maxModifiers = 16
	// maxModifierValueLen — «-2», «1к6+2»: формула кубов и так ограничена
	// самим роллером (см. dice.go), тут просто отсекаем вставленный абзац.
	maxModifierValueLen = 40
	maxModifierNoteLen  = 120
)

// sanitizeModifiers выбрасывает записи с незнакомой целью/режимом (см.
// domain.ValidModifierTarget) и приводит остальные к каноничному виду.
// Молча, без ошибки — как и остальные клампы карточек: обычный клиент таких
// записей не присылает, а импорт из чужого формата вполне может принести
// цель, которой у нас нет.
func sanitizeModifiers(mods []domain.Modifier) []domain.Modifier {
	if len(mods) > maxModifiers {
		mods = mods[:maxModifiers]
	}
	out := make([]domain.Modifier, 0, len(mods))
	for _, m := range mods {
		m.Target = strings.TrimSpace(m.Target)
		m.Mode = strings.TrimSpace(m.Mode)
		m.Period = strings.TrimSpace(m.Period)
		if !domain.ValidModifierTarget(m.Target) {
			continue
		}
		if !domain.ValidModifierMode(m.Mode) {
			m.Mode = domain.ModifierAdd // самый безобидный режим по умолчанию
		}
		if !domain.ValidModifierPeriod(m.Period) || !domain.TargetSupportsPeriod(m.Target) {
			// Период у цели, которая его не поддерживает, — не ошибка
			// карточки, а бессмыслица: молча делаем модификатор постоянным.
			m.Period = domain.ModifierPeriodNone
		}
		m.Value = clampRunes(strings.TrimSpace(m.Value), maxModifierValueLen)
		if m.Value == "" {
			continue // нечего применять
		}
		m.Note = clampRunes(strings.TrimSpace(m.Note), maxModifierNoteLen)
		out = append(out, m)
	}
	return out
}

// normalizeDiceFormula — русское «к» в формуле кубов на латинское «d»:
// человек в конструкторе пишет «1к6», а роллер (см. dice.go) понимает
// только «1d6». Отдельная функция, а не правка регулярки роллера: формулы
// туда прилетают и от недоверенного клиента, и менять его грамматику ради
// удобства ввода в одном поле не хочется.
func normalizeDiceFormula(formula string) string {
	return strings.NewReplacer("к", "d", "К", "d").Replace(strings.TrimSpace(formula))
}
