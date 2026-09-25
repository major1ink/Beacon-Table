package domain

import (
	"bytes"
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"sync"
)

// Extra — ключи верхнего уровня JSON карточки или листа, которых структура
// не знает. Ядро не разбирает их и не валидирует, но и не теряет: их
// описывает схема игровой системы из модуля (см. задачу «Схемы листа и
// карточек»), а импорт, модуль или клиент новой версии могут прислать поле,
// о котором эта версия сервера ещё не слышала. Без Extra такое поле молча
// выпадало бы при первом же сохранении.
//
// Сохраняется только верхний уровень: незнакомый ключ ВНУТРИ известного
// вложенного объекта (скажем, combat.shield у листа) по-прежнему теряется —
// схемы кладут свои поля на верхний уровень.
type Extra map[string]json.RawMessage

// knownKeys — имена JSON-полей структуры в нижнем регистре: encoding/json
// сопоставляет ключи без учёта регистра, и "Name" уже разобран в поле
// name — хранить его ещё и в Extra значило бы получить дубль при записи.
var knownKeysCache sync.Map // reflect.Type → map[string]bool

func knownKeys(t reflect.Type) map[string]bool {
	if v, ok := knownKeysCache.Load(t); ok {
		return v.(map[string]bool)
	}
	keys := map[string]bool{}
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		if !f.IsExported() {
			continue
		}
		name := f.Name
		if tag, ok := f.Tag.Lookup("json"); ok {
			tagName, _, _ := strings.Cut(tag, ",")
			if tagName == "-" {
				continue
			}
			if tagName != "" {
				name = tagName
			}
		}
		keys[strings.ToLower(name)] = true
	}
	knownKeysCache.Store(t, keys)
	return keys
}

// unmarshalWithExtra разбирает data в known (указатель на структуру без
// своих методов JSON — обычно локальный тип-двойник, чтобы не уйти в
// рекурсию) и складывает незнакомые ключи в extra. Разбор идёт ПОВЕРХ уже
// заполненных полей known — как у обычного json.Unmarshal (на этом
// держится лист по умолчанию, см. sqlite.decodeSheet).
func unmarshalWithExtra(data []byte, known any, extra *Extra) error {
	if err := json.Unmarshal(data, known); err != nil {
		return err
	}
	var all map[string]json.RawMessage
	if err := json.Unmarshal(data, &all); err != nil {
		*extra = nil
		return nil //nolint:nilerr // не объект (null) — известные поля уже разобраны, лишнего нет
	}
	keys := knownKeys(reflect.TypeOf(known).Elem())
	for k := range all {
		if keys[strings.ToLower(k)] {
			delete(all, k)
		}
	}
	if len(all) == 0 {
		*extra = nil
		return nil
	}
	*extra = all
	return nil
}

// marshalWithExtra — JSON известных полей (в их обычном порядке) и следом
// незнакомые ключи по алфавиту. Ключ из Extra, совпавший с известным
// полем, не пишется: известное поле главнее.
func marshalWithExtra(known any, extra Extra) ([]byte, error) {
	data, err := json.Marshal(known)
	if err != nil || len(extra) == 0 {
		return data, err
	}
	keys := knownKeys(reflect.TypeOf(known))
	names := make([]string, 0, len(extra))
	for k := range extra {
		if !keys[strings.ToLower(k)] {
			names = append(names, k)
		}
	}
	if len(names) == 0 {
		return data, nil
	}
	sort.Strings(names)
	var buf bytes.Buffer
	buf.Write(data[:len(data)-1]) // без закрывающей }
	for i, k := range names {
		if i > 0 || len(data) > 2 {
			buf.WriteByte(',')
		}
		name, _ := json.Marshal(k)
		buf.Write(name)
		buf.WriteByte(':')
		value := extra[k]
		if !json.Valid(value) {
			value = json.RawMessage("null")
		}
		buf.Write(value)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// Методы JSON у карточек и листа — сохраняют Extra. Локальный тип plain —
// та же структура без этих методов, иначе json.Marshal ушёл бы в рекурсию.

func (m *Monster) UnmarshalJSON(data []byte) error {
	type plain Monster
	return unmarshalWithExtra(data, (*plain)(m), &m.Extra)
}

func (m Monster) MarshalJSON() ([]byte, error) {
	type plain Monster
	return marshalWithExtra(plain(m), m.Extra)
}

func (s *Spell) UnmarshalJSON(data []byte) error {
	type plain Spell
	return unmarshalWithExtra(data, (*plain)(s), &s.Extra)
}

func (s Spell) MarshalJSON() ([]byte, error) {
	type plain Spell
	return marshalWithExtra(plain(s), s.Extra)
}

func (it *Item) UnmarshalJSON(data []byte) error {
	type plain Item
	return unmarshalWithExtra(data, (*plain)(it), &it.Extra)
}

func (it Item) MarshalJSON() ([]byte, error) {
	type plain Item
	return marshalWithExtra(plain(it), it.Extra)
}

func (r *Reference) UnmarshalJSON(data []byte) error {
	type plain Reference
	return unmarshalWithExtra(data, (*plain)(r), &r.Extra)
}

func (r Reference) MarshalJSON() ([]byte, error) {
	type plain Reference
	return marshalWithExtra(plain(r), r.Extra)
}

func (c *Condition) UnmarshalJSON(data []byte) error {
	type plain Condition
	return unmarshalWithExtra(data, (*plain)(c), &c.Extra)
}

func (c Condition) MarshalJSON() ([]byte, error) {
	type plain Condition
	return marshalWithExtra(plain(c), c.Extra)
}

func (s *CharacterSheet) UnmarshalJSON(data []byte) error {
	type plain CharacterSheet
	return unmarshalWithExtra(data, (*plain)(s), &s.Extra)
}

func (s CharacterSheet) MarshalJSON() ([]byte, error) {
	type plain CharacterSheet
	return marshalWithExtra(plain(s), s.Extra)
}
