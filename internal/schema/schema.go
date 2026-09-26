// Package schema — схемы листа персонажа и карточек игровой системы: какие
// поля есть, где они лежат в JSON, как считаются и как разложены на
// странице. Схему несёт системный модуль (schemas/<вид>.json), у «Своей
// системы» — встроенные (см. builtin.go).
//
// Сервер схему только проверяет и отдаёт клиенту как есть (Raw): рисует и
// считает формулы клиент (web/src/schema-*.js). Поэтому здесь разобрано ровно
// то, что нужно проверке, — всё остальное в поле или секции просто уезжает
// клиенту, и рендерер может расти, не трогая сервер.
package schema

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"regexp"
	"strings"

	"beacon-table/internal/domain"
)

// Format — версия формата схемы.
const Format = "beacon-schema/v1"

// Виды схем: лист персонажа и четыре вида карточек библиотеки.
const (
	KindSheet     = "sheet"
	KindMonster   = "monster"
	KindSpell     = "spell"
	KindItem      = "item"
	KindReference = "reference"
)

// Kinds — все виды схем.
var Kinds = []string{KindSheet, KindMonster, KindSpell, KindItem, KindReference}

// rootTypes — Go-тип JSON, который описывает схема каждого вида: по нему
// проверяются пути полей (domain.ResolveJSONPath).
var rootTypes = map[string]reflect.Type{
	KindSheet:     reflect.TypeOf(domain.CharacterSheet{}),
	KindMonster:   reflect.TypeOf(domain.Monster{}),
	KindSpell:     reflect.TypeOf(domain.Spell{}),
	KindItem:      reflect.TypeOf(domain.Item{}),
	KindReference: reflect.TypeOf(domain.Reference{}),
}

// Типы полей.
const (
	TypeNumber   = "number"   // число
	TypeText     = "text"     // строка
	TypeLongText = "longtext" // многострочный текст
	TypeBool     = "bool"     // флажок
	TypeSelect   = "select"   // выбор из вариантов (с цветом и глифом)
	TypeDice     = "dice"     // формула кубов, которую правит человек («1d20+2»)
	TypeTable    = "table"    // таблица строк, колонки — поля
	TypeResource = "resource" // счётчик «сейчас / максимум»
	TypeComputed = "computed" // число по формуле, не хранится
	TypeRoll     = "roll"     // бросок по формуле, не хранится
)

var fieldTypes = map[string]bool{
	TypeNumber: true, TypeText: true, TypeLongText: true, TypeBool: true, TypeSelect: true,
	TypeDice: true, TypeTable: true, TypeResource: true, TypeComputed: true, TypeRoll: true,
}

// storedTypes — типы, значение которых лежит в JSON и потому требует path.
var storedTypes = map[string]bool{
	TypeNumber: true, TypeText: true, TypeLongText: true, TypeBool: true, TypeSelect: true,
	TypeDice: true, TypeTable: true, TypeResource: true,
}

// coreTargets — общие поля ядра, к которым схема привязывает свои поля
// (раздел core): через них работают трекер боя, токены и модификаторы.
var coreTargets = map[string]bool{
	domain.ModifierTargetHPCurrent: true, domain.ModifierTargetHPMax: true,
	domain.ModifierTargetAC: true, domain.ModifierTargetSpeed: true, domain.ModifierTargetInitiative: true,
}

// widgets — готовые блоки страницы для сложных общих вещей и виды, где они
// есть.
var widgets = map[string][]string{
	"hp":        {KindSheet},
	"statuses":  {KindSheet},
	"resources": {KindSheet},
	"inventory": {KindSheet, KindMonster},
	"money":     {KindSheet},
	"spells":    {KindMonster},
	"applies":   {KindSpell},
	"modifiers": {KindItem},
}

// Пределы: схема — описание формы, а не данные.
const (
	MaxFileSize = 256 << 10
	maxFields   = 500
	maxColumns  = 50
	maxOptions  = 200
	maxSections = 100
	maxLabelLen = 120
	maxFormula  = 2000
	maxColumn   = 3
)

var idRe = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

// Option — вариант поля select: значение в JSON, подпись, цвет и глиф.
type Option struct {
	Value string `json:"value"`
	Label string `json:"label"`
	Color string `json:"color,omitempty"`
	Glyph string `json:"glyph,omitempty"`
}

// Field — поле схемы (или колонка таблицы).
type Field struct {
	ID      string `json:"id,omitempty"` // только у колонок таблицы
	Type    string `json:"type"`
	Path    string `json:"path,omitempty"`
	Label   string `json:"label"`
	Short   string `json:"short,omitempty"`
	Formula string `json:"formula,omitempty"`
	Roll    string `json:"roll,omitempty"`
	// ModifierTarget — цель модификатора, которая меняет значение поля.
	ModifierTarget string   `json:"modifierTarget,omitempty"`
	Options        []Option `json:"options,omitempty"`
	Columns        []*Field `json:"columns,omitempty"`
	// StatRows — строки таблицы — свободные характеристики: колонка
	// названия и колонка значения; значение меняют модификаторы
	// stat.<ключ названия>.
	StatRows *StatRows `json:"statRows,omitempty"`
}

// StatRows — см. Field.StatRows.
type StatRows struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// Section — секция раскладки: заголовок, поля или виджет, колонка режима
// чтения (1–3), вкладка режима правки и режим, в котором секция видна
// ("" — в обоих, "view" — только в чтении, "edit" — только в правке:
// хиты в чтении — виджет, в правке — поля).
type Section struct {
	Title  string   `json:"title,omitempty"`
	Fields []string `json:"fields,omitempty"`
	Widget string   `json:"widget,omitempty"`
	Column int      `json:"column,omitempty"`
	Tab    string   `json:"tab,omitempty"`
	Mode   string   `json:"mode,omitempty"`
}

// List — как карточка выглядит в каталоге: подпись-шаблон («{level} круг ·
// {school}»), ключи сортировки, фильтры и поля поиска.
type List struct {
	Subtitle string   `json:"subtitle,omitempty"`
	Sort     []string `json:"sort,omitempty"`
	Filters  []string `json:"filters,omitempty"`
	Search   []string `json:"search,omitempty"`
}

// Schema — схема листа или карточки. Raw — файл как есть: его и получает
// клиент.
type Schema struct {
	Format string            `json:"format"`
	Kind   string            `json:"kind"`
	Core   map[string]string `json:"core,omitempty"`
	Fields map[string]*Field `json:"fields"`
	Layout []Section         `json:"layout"`
	List   *List             `json:"list,omitempty"`

	Raw json.RawMessage `json:"-"`
}

// Parse разбирает и проверяет схему.
func Parse(data []byte) (*Schema, error) {
	if len(data) > MaxFileSize {
		return nil, fmt.Errorf("схема больше %d КБ", MaxFileSize>>10)
	}
	var s Schema
	dec := json.NewDecoder(bytes.NewReader(data))
	if err := dec.Decode(&s); err != nil {
		return nil, fmt.Errorf("схема не разбирается: %w", err)
	}
	if err := s.Validate(); err != nil {
		return nil, err
	}
	s.Raw = append(json.RawMessage(nil), data...)
	return &s, nil
}

// Validate — всё, что сервер может проверить без формул.
func (s *Schema) Validate() error {
	if s.Format != Format {
		return fmt.Errorf("формат схемы %q не поддерживается (нужен %q)", s.Format, Format)
	}
	root, ok := rootTypes[s.Kind]
	if !ok {
		return fmt.Errorf("вид схемы %q: нужен один из %s", s.Kind, strings.Join(Kinds, ", "))
	}
	if len(s.Fields) == 0 {
		return fmt.Errorf("в схеме %s нет полей", s.Kind)
	}
	if len(s.Fields) > maxFields {
		return fmt.Errorf("в схеме %s больше %d полей", s.Kind, maxFields)
	}
	for id, f := range s.Fields {
		if !idRe.MatchString(id) {
			return fmt.Errorf("схема %s: id поля %q — латиница в нижнем регистре, цифры и _", s.Kind, id)
		}
		if err := checkField(root, f, false); err != nil {
			return fmt.Errorf("схема %s, поле %s: %w", s.Kind, id, err)
		}
	}
	for target, id := range s.Core {
		if !coreTargets[target] {
			return fmt.Errorf("схема %s: core.%s — такого общего поля в ядре нет", s.Kind, target)
		}
		if _, ok := s.Fields[id]; !ok {
			return fmt.Errorf("схема %s: core.%s ссылается на неизвестное поле %q", s.Kind, target, id)
		}
	}
	if len(s.Layout) == 0 {
		return fmt.Errorf("в схеме %s нет раскладки (layout)", s.Kind)
	}
	if len(s.Layout) > maxSections {
		return fmt.Errorf("в схеме %s больше %d секций", s.Kind, maxSections)
	}
	for i, sec := range s.Layout {
		if err := s.checkSection(sec); err != nil {
			return fmt.Errorf("схема %s, секция %d: %w", s.Kind, i+1, err)
		}
	}
	if s.List != nil {
		if s.Kind == KindSheet {
			return fmt.Errorf("раздел list — только у карточек, не у листа")
		}
		if err := s.checkList(); err != nil {
			return fmt.Errorf("схема %s, list: %w", s.Kind, err)
		}
	}
	return nil
}

// checkField — поле или колонка таблицы. root — Go-тип, от которого идёт
// path (у колонки — тип строки таблицы; nil — путь внутри незнакомого ядру
// ключа, там годится любой).
func checkField(root reflect.Type, f *Field, column bool) error {
	if f == nil {
		return fmt.Errorf("пустое поле")
	}
	if !fieldTypes[f.Type] {
		return fmt.Errorf("неизвестный тип %q", f.Type)
	}
	if strings.TrimSpace(f.Label) == "" || len([]rune(f.Label)) > maxLabelLen {
		return fmt.Errorf("нет подписи (label) или она длиннее %d символов", maxLabelLen)
	}
	if len(f.Formula) > maxFormula || len(f.Roll) > maxFormula {
		return fmt.Errorf("формула длиннее %d символов", maxFormula)
	}
	if column && (f.Type == TypeTable || f.Type == TypeResource) {
		return fmt.Errorf("колонка таблицы не может быть таблицей или ресурсом")
	}
	var at reflect.Type
	if storedTypes[f.Type] {
		if f.Path == "" {
			return fmt.Errorf("у поля типа %s нужен path", f.Type)
		}
		if root != nil {
			t, err := domain.ResolveJSONPath(root, f.Path)
			if err != nil {
				return err
			}
			at = t
		}
	} else if f.Path != "" {
		return fmt.Errorf("у поля типа %s не бывает path — оно не хранится", f.Type)
	}
	switch f.Type {
	case TypeComputed:
		if strings.TrimSpace(f.Formula) == "" {
			return fmt.Errorf("у вычисляемого поля нет формулы (formula)")
		}
	case TypeRoll:
		if strings.TrimSpace(f.Roll) == "" {
			return fmt.Errorf("у броска нет формулы (roll)")
		}
	case TypeSelect:
		if len(f.Options) == 0 || len(f.Options) > maxOptions {
			return fmt.Errorf("у выбора нужно от 1 до %d вариантов", maxOptions)
		}
		seen := map[string]bool{}
		for _, o := range f.Options {
			if seen[o.Value] {
				return fmt.Errorf("вариант %q повторяется", o.Value)
			}
			seen[o.Value] = true
		}
	case TypeTable:
		if len(f.Columns) == 0 || len(f.Columns) > maxColumns {
			return fmt.Errorf("у таблицы нужно от 1 до %d колонок", maxColumns)
		}
		var row reflect.Type
		if at != nil {
			if at.Kind() != reflect.Slice && at.Kind() != reflect.Array {
				return fmt.Errorf("path %q ведёт не к списку", f.Path)
			}
			row = at.Elem()
		}
		ids := map[string]bool{}
		for _, c := range f.Columns {
			if c == nil || !idRe.MatchString(c.ID) || ids[c.ID] {
				return fmt.Errorf("у колонки нет id, он кривой или повторяется")
			}
			ids[c.ID] = true
			if err := checkField(row, c, true); err != nil {
				return fmt.Errorf("колонка %s: %w", c.ID, err)
			}
		}
		if f.StatRows != nil && (!ids[f.StatRows.Name] || !ids[f.StatRows.Value]) {
			return fmt.Errorf("statRows ссылается на неизвестные колонки")
		}
	}
	if f.StatRows != nil && f.Type != TypeTable {
		return fmt.Errorf("statRows — только у таблицы")
	}
	if len(f.Columns) > 0 && f.Type != TypeTable {
		return fmt.Errorf("колонки (columns) — только у таблицы")
	}
	if f.ModifierTarget != "" && !domain.ValidModifierTarget(f.ModifierTarget) {
		return fmt.Errorf("неверная цель модификатора %q", f.ModifierTarget)
	}
	return nil
}

func (s *Schema) checkSection(sec Section) error {
	if (sec.Widget == "") == (len(sec.Fields) == 0) {
		return fmt.Errorf("в секции должно быть либо поля (fields), либо виджет (widget)")
	}
	if sec.Widget != "" {
		kinds, ok := widgets[sec.Widget]
		if !ok {
			return fmt.Errorf("неизвестный виджет %q", sec.Widget)
		}
		allowed := false
		for _, k := range kinds {
			allowed = allowed || k == s.Kind
		}
		if !allowed {
			return fmt.Errorf("виджет %q не бывает у вида %s", sec.Widget, s.Kind)
		}
	}
	for _, id := range sec.Fields {
		if _, ok := s.Fields[id]; !ok {
			return fmt.Errorf("неизвестное поле %q", id)
		}
	}
	if sec.Column < 0 || sec.Column > maxColumn {
		return fmt.Errorf("колонка секции — от 1 до %d", maxColumn)
	}
	if sec.Mode != "" && sec.Mode != "view" && sec.Mode != "edit" {
		return fmt.Errorf("режим секции %q: нужен view, edit или пусто", sec.Mode)
	}
	if sec.Tab != "" && !idRe.MatchString(sec.Tab) {
		return fmt.Errorf("id вкладки %q — латиница в нижнем регистре, цифры и _", sec.Tab)
	}
	return nil
}

var placeholderRe = regexp.MustCompile(`\{([^{}]*)\}`)

// listRef — поле, на которое может ссылаться list: поле схемы или общие
// ключи страницы карточки (name, tags, source).
func (s *Schema) listRef(id string) bool {
	if id == "name" || id == "tags" || id == "source" {
		return true
	}
	_, ok := s.Fields[id]
	return ok
}

func (s *Schema) checkList() error {
	for _, m := range placeholderRe.FindAllStringSubmatch(s.List.Subtitle, -1) {
		if !s.listRef(m[1]) {
			return fmt.Errorf("подпись ссылается на неизвестное поле %q", m[1])
		}
	}
	for _, group := range [][]string{s.List.Sort, s.List.Filters, s.List.Search} {
		for _, id := range group {
			if !s.listRef(id) {
				return fmt.Errorf("неизвестное поле %q", id)
			}
		}
	}
	return nil
}
