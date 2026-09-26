package service

import (
	"reflect"
	"sort"
	"strings"

	"beacon-table/internal/domain"
)

// cardlimits.go — общие санитарные пределы карточек библиотеки (существо,
// заклинание, предмет, справочник, состояние) и листа персонажа. Это не
// правила игры, а защита от кривого или злонамеренного клиента: всё, что
// сверх предела, молча обрезается, без ошибки — в нормальной работе клиент в
// эти пределы не упирается.
//
// Пределы общие для всех полей, а не поимённые: clampCard обходит структуру
// целиком, поэтому новое поле карточки ограничено сразу, а поля схемы
// игровой системы, о которых ядро не знает, лежат в Extra и ограничены
// clampExtra. Правила конкретной системы (уровень заклинания 0–9, шесть
// уровней истощения) задаёт её схема, а не эти пределы.
const (
	// maxText — любая строка карточки или листа, в рунах: описание,
	// импортированный HTML, блоки способностей статблока.
	maxText = 20000
	// maxRows — любой список: заклинания и добыча монстра, строки таблиц
	// листа, модификаторы (у них свой предел поменьше, см. modifiers.go).
	maxRows = 200
	// maxTags / maxTagLen — теги карточки: общий ключ ядра у всех видов.
	maxTags   = 30
	maxTagLen = 60
	// maxLevel — санитарный потолок уровня (заклинание, заклинание в
	// статблоке): сколько уровней у заклинаний, решает система.
	maxLevel = 99
	// maxExtraKeys / maxExtraKeyLen / maxExtraValue — незнакомые ядру ключи
	// (domain.Extra): их не разбираем, только ограничиваем объём.
	maxExtraKeys   = 64
	maxExtraKeyLen = 64
	maxExtraValue  = 64 << 10
)

// clampCard обрезает каждую строку до maxText рун и каждый список до
// maxRows элементов во всей структуре *v, включая вложенные структуры,
// массивы и списки структур. Словари не трогает — у них (деньги, владения)
// свои проверки, а Extra — см. clampExtra.
func clampCard(v any) {
	clampValue(reflect.ValueOf(v).Elem())
}

func clampValue(v reflect.Value) {
	switch v.Kind() {
	case reflect.String:
		if v.CanSet() {
			v.SetString(clampRunes(v.String(), maxText))
		}
	case reflect.Struct:
		for i := 0; i < v.NumField(); i++ {
			if f := v.Field(i); f.CanSet() {
				clampValue(f)
			}
		}
	case reflect.Slice:
		if v.Len() > maxRows && v.CanSet() {
			v.Set(v.Slice(0, maxRows))
		}
		fallthrough
	case reflect.Array:
		for i := 0; i < v.Len(); i++ {
			clampValue(v.Index(i))
		}
	case reflect.Pointer:
		if !v.IsNil() {
			clampValue(v.Elem())
		}
	}
}

// sanitizeTags — теги карточки: не больше maxTags, без пробелов по краям,
// каждый не длиннее maxTagLen.
func sanitizeTags(tags []string) []string {
	if len(tags) > maxTags {
		tags = tags[:maxTags]
	}
	for i := range tags {
		tags[i] = clampRunes(strings.TrimSpace(tags[i]), maxTagLen)
	}
	return tags
}

// clampExtra — незнакомые ядру ключи карточки или листа: не больше
// maxExtraKeys (остаются первые по алфавиту, чтобы результат не зависел от
// порядка обхода map), имя не длиннее maxExtraKeyLen, значение не больше
// maxExtraValue байт JSON — слишком большое выбрасывается целиком: обрезанный
// JSON был бы битым.
func clampExtra(e domain.Extra) domain.Extra {
	if len(e) == 0 {
		return e
	}
	keys := make([]string, 0, len(e))
	for k, raw := range e {
		if len([]rune(k)) <= maxExtraKeyLen && len(raw) <= maxExtraValue {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	if len(keys) > maxExtraKeys {
		keys = keys[:maxExtraKeys]
	}
	out := make(domain.Extra, len(keys))
	for _, k := range keys {
		out[k] = e[k]
	}
	return out
}

// clampCount — счётчик или уровень в пределах [0, hi].
func clampCount(v, hi int) int {
	return min(max(v, 0), hi)
}
