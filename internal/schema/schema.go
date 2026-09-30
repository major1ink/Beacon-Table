// Package schema — схемы листа персонажа и карточек игровой системы: какие
// поля есть, где они лежат в JSON, как считаются и как разложены на
// странице. Схему несёт системный модуль (schemas/<вид>.json), у «Своей
// системы» — встроенные (см. builtin.go).
//
// Сервер схему проверяет (вместе с формулами — синтаксис, ссылки, циклы) и
// отдаёт клиенту как есть (Raw): рисует лист клиент (web/src/schema-*.js).
// Поэтому здесь разобрано ровно то, что нужно проверке и расчётам сервера
// (формулы — eval.go: инициатива из листа), — всё остальное в поле или
// секции просто уезжает клиенту, и рендерер может расти, не трогая сервер.
package schema

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"regexp"
	"strings"
	"sync"

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
	TypeProf     = "prof"     // владение: флажок или «нет / владение / экспертиза»
	TypeTally    = "tally"    // шкала из делений: 0..max, клик по делению
	TypePool     = "pool"     // счётчик-строка «всего/потрачено» («4/2»)
	TypeTemplate = "template" // текст по шаблону из других полей, не хранится
)

var fieldTypes = map[string]bool{
	TypeNumber: true, TypeText: true, TypeLongText: true, TypeBool: true, TypeSelect: true,
	TypeDice: true, TypeTable: true, TypeResource: true, TypeComputed: true, TypeRoll: true,
	TypeProf: true, TypeTally: true, TypePool: true, TypeTemplate: true,
}

// storedTypes — типы, значение которых лежит в JSON и потому требует path.
var storedTypes = map[string]bool{
	TypeNumber: true, TypeText: true, TypeLongText: true, TypeBool: true, TypeSelect: true,
	TypeDice: true, TypeTable: true, TypeResource: true,
	TypeProf: true, TypeTally: true, TypePool: true,
}

// ToneBad — красные деления шкалы (tally).
const ToneBad = "bad"

// Значения Field.Rollable.
const (
	RollableCheck  = "check"
	RollableInline = "inline"
)

// keyPlaceholder — ключ строки в пути колонки таблицы со строками.
const keyPlaceholder = "{key}"

// coreTargets — общие поля ядра, к которым схема привязывает свои поля
// (раздел core): через них работают трекер боя, токены и модификаторы.
var coreTargets = map[string]bool{
	domain.ModifierTargetHPCurrent: true, domain.ModifierTargetHPMax: true,
	domain.ModifierTargetAC: true, domain.ModifierTargetSpeed: true, domain.ModifierTargetInitiative: true,
}

// storedCore — общие поля, которые сервер не только читает, но и пишет
// (хиты персонажа из трекера боя, см. repository.CharacterRepository:
// UpdateSheetHP): такое поле схемы — хранимое число ровно по этому пути,
// не формула. Остальные общие поля (КД, скорость) могут быть формулой —
// сервер их только читает (Evaluator.Core).
var storedCore = map[string]map[string]string{
	KindSheet: {domain.ModifierTargetHPCurrent: "combat.hpCurrent", domain.ModifierTargetHPMax: "combat.hpMax"},
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
	"spellbook": {KindSheet},
	"xp":        {KindSheet},
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
	maxRows     = 100
	// maxCellFields — полей в плитке секции; maxListItems — плашек, букв и
	// правил каталога; maxRuleTokens — подстрок в правиле.
	maxCellFields = 4
	maxListItems  = 50
	maxRuleTokens = 50
	maxTally      = 20
	maxFormula    = 2000
	maxColumn     = 3
)

var idRe = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

// rowKeyRe — ключ строки таблицы со строками.
var rowKeyRe = regexp.MustCompile(`^[A-Za-z0-9_]+$`)

// Option — вариант поля select: значение в JSON, подпись, цвет и глиф.
type Option struct {
	Value string `json:"value"`
	Label string `json:"label"`
	Color string `json:"color,omitempty"`
	Glyph string `json:"glyph,omitempty"`
	// Formula — число варианта: ссылка @поле на select даёт формулу
	// выбранного варианта.
	Formula string `json:"formula,omitempty"`
}

// Field — поле схемы (или колонка таблицы).
type Field struct {
	ID    string `json:"id,omitempty"` // только у колонок таблицы
	Type  string `json:"type"`
	Path  string `json:"path,omitempty"`
	Label string `json:"label"`
	Short string `json:"short,omitempty"`
	// Signed — число со знаком («+3»).
	Signed  bool   `json:"signed,omitempty"`
	Formula string `json:"formula,omitempty"`
	// Roll — у броска (roll) его формула, у числа и вычисляемого поля —
	// бросок по клику на значение.
	Roll string `json:"roll,omitempty"`
	// Rollable — колонка текста, значение которой бросается: "check" —
	// бонус «+5» кубом проверки, "inline" — формулы внутри текста.
	Rollable string `json:"rollable,omitempty"`
	// ModifierTarget — цель модификатора, которая меняет значение поля.
	ModifierTarget string   `json:"modifierTarget,omitempty"`
	Options        []Option `json:"options,omitempty"`
	Columns        []*Field `json:"columns,omitempty"`
	// StatRows — строки таблицы — свободные характеристики: колонка
	// названия и колонка значения; значение меняют модификаторы
	// stat.<ключ названия>.
	StatRows *StatRows `json:"statRows,omitempty"`
	// Numeric — значения вариантов select хранятся числами.
	Numeric bool `json:"numeric,omitempty"`
	// Levels — состояний у владения (prof): 2 — флажок, 3 — число 0..2.
	Levels int `json:"levels,omitempty"`
	// Max — делений у шкалы (tally), Tone — её цвет.
	Max  int    `json:"max,omitempty"`
	Tone string `json:"tone,omitempty"`
	// Template — текст поля template: «{ac}[ ({ac_note})]», см. FormatSubtitle.
	Template string `json:"template,omitempty"`
	// Facet — как значение текстового поля попадает в фильтр каталога.
	Facet string `json:"facet,omitempty"`
	// Suggest — подсказки текстового поля из карточек справочника.
	Suggest *Suggest `json:"suggest,omitempty"`
	// Rows — заранее известные строки таблицы. path таблицы ведёт к объекту
	// или списку, «{key}» в пути колонки — ключ строки (skillProf.{key}).
	Rows []Row `json:"rows,omitempty"`
}

// Значения Field.Facet: до скобки («зверь (динозавр)» → «зверь») и список
// через запятую, точку с запятой или косую черту (несколько значений).
const (
	FacetBeforeParen = "beforeParen"
	FacetList        = "list"
)

// Suggest — подсказки: названия записей справочника вида Reference; у
// записей с ParentName (архетип класса) — только с родителем из поля
// ParentField.
type Suggest struct {
	Reference   string `json:"reference"`
	ParentField string `json:"parentField,omitempty"`
}

// Row — строка таблицы со строками; Formulas (id колонки → формула)
// заменяют формулы вычисляемых колонок.
type Row struct {
	Key      string            `json:"key"`
	Label    string            `json:"label"`
	Formulas map[string]string `json:"formulas,omitempty"`
}

// StatRows — см. Field.StatRows.
type StatRows struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// Section — секция раскладки: заголовок, поля или виджет, колонка (1–3),
// вкладка режима правки и режим, в котором секция видна ("" — в обоих,
// "view" — только в чтении, "edit" — только в правке: хиты в чтении —
// виджет, в правке — поля). Вкладки листа: "sheet" (по умолчанию),
// "inventory" — инвентарь страницы, любая другая — своя вкладка с подписью
// TabTitle (берётся у первой секции вкладки, где она задана).
type Section struct {
	Title    string   `json:"title,omitempty"`
	Fields   []string `json:"fields,omitempty"`
	Widget   string   `json:"widget,omitempty"`
	Column   int      `json:"column,omitempty"`
	Tab      string   `json:"tab,omitempty"`
	TabTitle string   `json:"tabTitle,omitempty"`
	Mode     string   `json:"mode,omitempty"`
	// Cells — секция из плиток: в каждой несколько полей друг под другом
	// («Сил» — 17 и +3).
	Cells [][]string `json:"cells,omitempty"`
	// Open — раскрыта ли секция из текстов в чтении (по умолчанию да).
	Open *bool `json:"open,omitempty"`
	// Bind — роль виджета → id поля схемы, см. widgetBinds.
	Bind map[string]string `json:"bind,omitempty"`
}

// bindRule — роль привязки виджета и какое поле к ней подходит.
type bindRule struct {
	Role     string
	Required bool
	Accept   func(f *Field) bool
}

// widgetBinds — роли привязки по виджетам.
var widgetBinds = map[string][]bindRule{
	"spellbook": {
		{"spells", true, func(f *Field) bool { return f.Type == TypeTable && hasColumns(f, "name", "level") }},
		{"slots", false, func(f *Field) bool { return f.Type == TypeTable && len(f.Rows) > 0 && hasPoolColumn(f) }},
		{"attack", false, isNumeric},
		{"dc", false, isNumeric},
		{"modifier", false, isNumeric},
		{"level", false, isNumeric},
		{"ability", false, func(f *Field) bool { return f.Type == TypeSelect }},
	},
	"xp": {
		{"xp", true, func(f *Field) bool { return f.Type == TypeNumber }},
	},
}

func isNumeric(f *Field) bool { return f.Type == TypeNumber || f.Type == TypeComputed }

func hasColumns(f *Field, ids ...string) bool {
	for _, id := range ids {
		found := false
		for _, c := range f.Columns {
			found = found || c.ID == id
		}
		if !found {
			return false
		}
	}
	return true
}

func hasPoolColumn(f *Field) bool {
	for _, c := range f.Columns {
		if c.Type == TypePool {
			return true
		}
	}
	return false
}

// List — как карточка выглядит в каталоге: подпись-шаблон («{level} круг ·
// {school}», см. Subtitle), поле групп с заголовками, ключи сортировки,
// фильтры и поля поиска. У листа персонажа — только подпись (готовые
// персонажи в списках).
type List struct {
	Subtitle string   `json:"subtitle,omitempty"`
	Group    string   `json:"group,omitempty"`
	Sort     []string `json:"sort,omitempty"`
	Filters  []string `json:"filters,omitempty"`
	Search   []string `json:"search,omitempty"`
	// Badges — поля, чей текст стоит плашкой перед источником (цвет — у
	// варианта select), Pills — плашки в шапке карточки, Flags — буквы у
	// строки каталога.
	Badges []string `json:"badges,omitempty"`
	Pills  []string `json:"pills,omitempty"`
	Flags  []Flag   `json:"flags,omitempty"`
	// Medallion — откуда берётся глиф и цвет карточки, Categories — дерево
	// «Компендиума».
	Medallion  *Medallion  `json:"medallion,omitempty"`
	Categories *Categories `json:"categories,omitempty"`
}

// Flag — буква Mark у карточки, у которой булево поле Field включено.
type Flag struct {
	Field string `json:"field"`
	Mark  string `json:"mark"`
	Title string `json:"title,omitempty"`
}

// Rule — правило по тексту поля: значение содержит одну из подстрок
// (Contains) или равно одному из значений (Equals), без учёта регистра.
type Rule struct {
	Label    string   `json:"label,omitempty"`
	Contains []string `json:"contains,omitempty"`
	Equals   []string `json:"equals,omitempty"`
	Glyph    string   `json:"glyph,omitempty"`
	Color    string   `json:"color,omitempty"`
}

// Medallion — глиф и цвет карточки: у поля select — из варианта, у текста —
// из первого подошедшего правила; Glyph и Color — на случай без совпадения.
type Medallion struct {
	Field string `json:"field"`
	Rules []Rule `json:"rules,omitempty"`
	Glyph string `json:"glyph,omitempty"`
	Color string `json:"color,omitempty"`
	// ColorField — поле select, чей вариант красит медальон вместо правил.
	ColorField string `json:"colorField,omitempty"`
}

// Categories — разбиение карточек по тексту поля: первое подошедшее правило,
// иначе Other.
type Categories struct {
	Field string `json:"field"`
	Rules []Rule `json:"rules"`
	Other string `json:"other,omitempty"`
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

	compileOnce sync.Once
	formulas    map[string]compiledFormula
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

// Validate — структура схемы и её формулы.
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
		f, ok := s.Fields[id]
		if !ok {
			return fmt.Errorf("схема %s: core.%s ссылается на неизвестное поле %q", s.Kind, target, id)
		}
		if want, ok := storedCore[s.Kind][target]; ok && (f.Type != TypeNumber || f.Path != want) {
			return fmt.Errorf("схема %s: core.%s — число по пути %s (его пишет трекер боя), а не %s %q", s.Kind, target, want, f.Type, f.Path)
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
	if err := s.checkFormulas(root); err != nil {
		return fmt.Errorf("схема %s, %w", s.Kind, err)
	}
	if err := s.checkTemplates(); err != nil {
		return fmt.Errorf("схема %s, %w", s.Kind, err)
	}
	if s.List != nil {
		l := s.List
		if s.Kind == KindSheet && (l.Group != "" || len(l.Sort) > 0 || len(l.Filters) > 0 || len(l.Search) > 0 || len(l.Badges) > 0 || len(l.Pills) > 0 || len(l.Flags) > 0 || l.Medallion != nil || l.Categories != nil) {
			return fmt.Errorf("у листа в разделе list — только subtitle (подпись готового персонажа)")
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
	if len(f.Formula) > maxFormula || len(f.Roll) > maxFormula || len(f.Template) > maxFormula {
		return fmt.Errorf("формула или шаблон длиннее %d символов", maxFormula)
	}
	if (f.Template != "") != (f.Type == TypeTemplate) || (f.Type == TypeTemplate && column) {
		return fmt.Errorf("template — обязательный шаблон поля типа template, колонкой оно не бывает")
	}
	if f.Numeric && f.Type != TypeSelect {
		return fmt.Errorf("numeric — только у выбора")
	}
	if f.Facet != "" && (f.Type != TypeText || (f.Facet != FacetBeforeParen && f.Facet != FacetList)) {
		return fmt.Errorf("facet — у текста, значение %s или %s", FacetBeforeParen, FacetList)
	}
	if f.Suggest != nil && (f.Type != TypeText || f.Suggest.Reference == "" || len(f.Suggest.Reference) > maxLabelLen) {
		return fmt.Errorf("suggest — у текста, с видом записей справочника (reference)")
	}
	if f.Roll != "" && f.Type != TypeRoll && f.Type != TypeNumber && f.Type != TypeComputed {
		return fmt.Errorf("roll — только у броска, числа и вычисляемого поля")
	}
	if f.Rollable != "" && (!column || f.Type != TypeText || (f.Rollable != RollableCheck && f.Rollable != RollableInline)) {
		return fmt.Errorf("rollable — только у колонки текста, значения %s или %s", RollableCheck, RollableInline)
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
		if f.Numeric {
			if at != nil && !isIntKind(at.Kind()) && at.Kind() != reflect.Float64 {
				return fmt.Errorf("числовой выбор хранится числом, а по пути %q лежит %s", f.Path, at.Kind())
			}
			for _, o := range f.Options {
				if !numberRe.MatchString(o.Value) {
					return fmt.Errorf("вариант %q числового выбора — не число", o.Value)
				}
			}
		}
		seen := map[string]bool{}
		for _, o := range f.Options {
			if seen[o.Value] {
				return fmt.Errorf("вариант %q повторяется", o.Value)
			}
			if len(o.Formula) > maxFormula {
				return fmt.Errorf("формула варианта %q длиннее %d символов", o.Value, maxFormula)
			}
			seen[o.Value] = true
		}
	case TypeTable:
		if len(f.Columns) == 0 || len(f.Columns) > maxColumns {
			return fmt.Errorf("у таблицы нужно от 1 до %d колонок", maxColumns)
		}
		if err := checkTable(at, f); err != nil {
			return err
		}
	case TypeProf:
		if f.Levels != 2 && f.Levels != 3 {
			return fmt.Errorf("у владения levels — 2 (флажок) или 3 (нет / владение / экспертиза)")
		}
		switch {
		case at == nil:
		case f.Levels == 3 && !isIntKind(at.Kind()):
			return fmt.Errorf("владение из трёх состояний — целое число, а по пути %q лежит %s", f.Path, at.Kind())
		case f.Levels == 2 && at.Kind() != reflect.Bool:
			return fmt.Errorf("владение-флажок хранится как bool, а по пути %q лежит %s", f.Path, at.Kind())
		}
	case TypeTally:
		if f.Max < 1 || f.Max > maxTally {
			return fmt.Errorf("у шкалы max — от 1 до %d", maxTally)
		}
		if f.Tone != "" && f.Tone != ToneBad {
			return fmt.Errorf("тон шкалы %q: нужен %s или пусто", f.Tone, ToneBad)
		}
		if at != nil && !isIntKind(at.Kind()) {
			return fmt.Errorf("шкала — целое число, а по пути %q лежит %s", f.Path, at.Kind())
		}
	case TypePool:
		if at != nil && at.Kind() != reflect.String {
			return fmt.Errorf("счётчик-строка хранится строкой, а по пути %q лежит %s", f.Path, at.Kind())
		}
	}
	if f.StatRows != nil && f.Type != TypeTable {
		return fmt.Errorf("statRows — только у таблицы")
	}
	if len(f.Columns) > 0 && f.Type != TypeTable {
		return fmt.Errorf("колонки (columns) — только у таблицы")
	}
	if len(f.Rows) > 0 && f.Type != TypeTable {
		return fmt.Errorf("строки (rows) — только у таблицы")
	}
	if f.Signed && f.Type != TypeNumber && f.Type != TypeComputed {
		return fmt.Errorf("signed — только у числа и вычисляемого поля")
	}
	if (f.Levels != 0 && f.Type != TypeProf) || ((f.Max != 0 || f.Tone != "") && f.Type != TypeTally) {
		return fmt.Errorf("levels — только у владения, max и tone — только у шкалы")
	}
	if f.ModifierTarget != "" && !domain.ValidModifierTarget(f.ModifierTarget) {
		return fmt.Errorf("неверная цель модификатора %q", f.ModifierTarget)
	}
	return nil
}

func isIntKind(k reflect.Kind) bool {
	return k >= reflect.Int && k <= reflect.Int64
}

// checkTable — колонки таблицы; at — Go-тип по path (nil — незнакомый ключ).
func checkTable(at reflect.Type, f *Field) error {
	keyed := len(f.Rows) > 0
	if keyed && f.StatRows != nil {
		return fmt.Errorf("таблица со строками (rows) не бывает таблицей характеристик (statRows)")
	}
	var row reflect.Type
	if at != nil {
		switch {
		case keyed && at.Kind() != reflect.Map && at.Kind() != reflect.Slice && at.Kind() != reflect.Array:
			return fmt.Errorf("path %q таблицы со строками ведёт не к объекту и не к списку", f.Path)
		case !keyed && at.Kind() != reflect.Slice && at.Kind() != reflect.Array:
			return fmt.Errorf("path %q ведёт не к списку", f.Path)
		case keyed:
			row = at
		default:
			row = at.Elem()
		}
	}
	ids := map[string]*Field{}
	for _, c := range f.Columns {
		if c == nil || !idRe.MatchString(c.ID) || ids[c.ID] != nil {
			return fmt.Errorf("у колонки нет id, он кривой или повторяется")
		}
		ids[c.ID] = c
		if !keyed {
			if err := checkField(row, c, true); err != nil {
				return fmt.Errorf("колонка %s: %w", c.ID, err)
			}
			continue
		}
		if storedTypes[c.Type] && !strings.Contains(c.Path, keyPlaceholder) {
			return fmt.Errorf("колонка %s: в таблице со строками путь колонки содержит %s", c.ID, keyPlaceholder)
		}
		for _, r := range f.Rows {
			cc := *c
			cc.Path = strings.ReplaceAll(c.Path, keyPlaceholder, r.Key)
			if err := checkField(row, &cc, true); err != nil {
				return fmt.Errorf("колонка %s, строка %s: %w", c.ID, r.Key, err)
			}
		}
	}
	if f.StatRows != nil && (ids[f.StatRows.Name] == nil || ids[f.StatRows.Value] == nil) {
		return fmt.Errorf("statRows ссылается на неизвестные колонки")
	}
	return checkRows(f, ids)
}

// checkRows — ключи, подписи и колонки формул строк таблицы.
func checkRows(f *Field, cols map[string]*Field) error {
	if len(f.Rows) > maxRows {
		return fmt.Errorf("в таблице больше %d строк", maxRows)
	}
	seen := map[string]bool{}
	for _, r := range f.Rows {
		if !rowKeyRe.MatchString(r.Key) || seen[r.Key] {
			return fmt.Errorf("ключ строки %q кривой или повторяется — латиница, цифры и _", r.Key)
		}
		seen[r.Key] = true
		if strings.TrimSpace(r.Label) == "" || len([]rune(r.Label)) > maxLabelLen {
			return fmt.Errorf("у строки %s нет подписи или она длиннее %d символов", r.Key, maxLabelLen)
		}
		for id, src := range r.Formulas {
			if c := cols[id]; c == nil || c.Type != TypeComputed {
				return fmt.Errorf("строка %s: формула для %q — нужна вычисляемая колонка", r.Key, id)
			}
			if len(src) > maxFormula {
				return fmt.Errorf("строка %s: формула длиннее %d символов", r.Key, maxFormula)
			}
		}
	}
	return nil
}

func (s *Schema) checkSection(sec Section) error {
	kinds := 0
	for _, has := range []bool{sec.Widget != "", len(sec.Fields) > 0, len(sec.Cells) > 0} {
		if has {
			kinds++
		}
	}
	if kinds != 1 {
		return fmt.Errorf("в секции должно быть одно из: поля (fields), плитки (cells) или виджет (widget)")
	}
	if len(sec.Cells) > 0 {
		if err := s.checkCells(sec); err != nil {
			return err
		}
	}
	if sec.Widget != "" {
		widgetKinds, ok := widgets[sec.Widget]
		if !ok {
			return fmt.Errorf("неизвестный виджет %q", sec.Widget)
		}
		allowed := false
		for _, k := range widgetKinds {
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
	if err := s.checkBind(sec); err != nil {
		return err
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
	if len([]rune(sec.Title)) > maxLabelLen || len([]rune(sec.TabTitle)) > maxLabelLen {
		return fmt.Errorf("заголовок секции или вкладки длиннее %d символов", maxLabelLen)
	}
	return nil
}

// checkBind — роли и поля привязки виджета.
func (s *Schema) checkBind(sec Section) error {
	rules := widgetBinds[sec.Widget]
	if len(rules) == 0 {
		if len(sec.Bind) > 0 {
			return fmt.Errorf("у виджета %q не бывает привязки (bind)", sec.Widget)
		}
		return nil
	}
	known := map[string]bool{}
	for _, r := range rules {
		known[r.Role] = true
		id, ok := sec.Bind[r.Role]
		if !ok {
			if r.Required {
				return fmt.Errorf("у виджета %q в привязке (bind) нужна роль %q", sec.Widget, r.Role)
			}
			continue
		}
		f := s.Fields[id]
		if f == nil {
			return fmt.Errorf("bind.%s ссылается на неизвестное поле %q", r.Role, id)
		}
		if !r.Accept(f) {
			return fmt.Errorf("bind.%s: поле %q (%s) виджету %q не подходит", r.Role, id, f.Type, sec.Widget)
		}
	}
	for role := range sec.Bind {
		if !known[role] {
			return fmt.Errorf("у виджета %q нет роли %q в привязке (bind)", sec.Widget, role)
		}
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
	if err := s.checkListExtras(); err != nil {
		return err
	}
	if g := s.List.Group; g != "" {
		f := s.Fields[g]
		if f == nil {
			return fmt.Errorf("группы по неизвестному полю %q", g)
		}
		switch f.Type {
		case TypeNumber, TypeComputed, TypeText, TypeSelect, TypeBool:
		default:
			return fmt.Errorf("группы по полю %q типа %s — нужно число, текст, выбор или флажок", g, f.Type)
		}
	}
	return nil
}

// checkCells — плитки секции: у каждой от одного до четырёх полей-значений.
func (s *Schema) checkCells(sec Section) error {
	for _, cell := range sec.Cells {
		if len(cell) == 0 || len(cell) > maxCellFields {
			return fmt.Errorf("в плитке (cells) от 1 до %d полей", maxCellFields)
		}
		for _, id := range cell {
			f := s.Fields[id]
			if f == nil {
				return fmt.Errorf("плитка ссылается на неизвестное поле %q", id)
			}
			if f.Type == TypeTable || f.Type == TypeLongText || f.Type == TypeResource {
				return fmt.Errorf("поле %q (%s) не бывает в плитке", id, f.Type)
			}
		}
	}
	return nil
}

// checkTemplates — подстановки шаблонов ведут к полям схемы или ключам
// карточки, но не к другим шаблонам; подсказки — к текстовому полю.
func (s *Schema) checkTemplates() error {
	for _, id := range sortedIDs(s.Fields) {
		f := s.Fields[id]
		if f.Type == TypeTemplate {
			for _, m := range placeholderRe.FindAllStringSubmatch(f.Template, -1) {
				ref := s.Fields[m[1]]
				if !s.listRef(m[1]) || (ref != nil && ref.Type == TypeTemplate) {
					return fmt.Errorf("поле %s: шаблон ссылается на %q — нужно поле схемы, но не шаблон", id, m[1])
				}
			}
		}
		if f.Suggest != nil && f.Suggest.ParentField != "" {
			if p := s.Fields[f.Suggest.ParentField]; p == nil || p.Type != TypeText {
				return fmt.Errorf("поле %s: suggest.parentField — текстовое поле схемы", id)
			}
		}
	}
	return nil
}

// checkListExtras — плашки, буквы, медальон и категории каталога.
func (s *Schema) checkListExtras() error {
	l := s.List
	for _, id := range append(append([]string(nil), l.Badges...), l.Pills...) {
		if f := s.Fields[id]; f == nil || f.Type == TypeTable || f.Type == TypeLongText {
			return fmt.Errorf("плашка ссылается на %q — нужно скалярное поле схемы", id)
		}
	}
	if len(l.Badges) > maxListItems || len(l.Pills) > maxListItems || len(l.Flags) > maxListItems {
		return fmt.Errorf("плашек и букв — не больше %d", maxListItems)
	}
	for _, fl := range l.Flags {
		f := s.Fields[fl.Field]
		if f == nil || f.Type != TypeBool || fl.Mark == "" || len([]rune(fl.Mark)) > 3 {
			return fmt.Errorf("буква каталога: булево поле %q и буква до 3 символов", fl.Field)
		}
	}
	if m := l.Medallion; m != nil {
		f := s.Fields[m.Field]
		switch {
		case f == nil:
			return fmt.Errorf("медальон по неизвестному полю %q", m.Field)
		case f.Type == TypeSelect && len(m.Rules) == 0:
		case f.Type == TypeText && len(m.Rules) > 0:
		default:
			return fmt.Errorf("медальон: выбор без правил или текст с правилами, поле %q — %s", m.Field, f.Type)
		}
		if cf := s.Fields[m.ColorField]; m.ColorField != "" && (cf == nil || cf.Type != TypeSelect) {
			return fmt.Errorf("медальон: colorField — поле выбора схемы")
		}
		if err := checkRules(m.Rules, false); err != nil {
			return fmt.Errorf("медальон: %w", err)
		}
	}
	if c := l.Categories; c != nil {
		if f := s.Fields[c.Field]; f == nil || (f.Type != TypeText && f.Type != TypeSelect) {
			return fmt.Errorf("категории по полю %q — нужен текст или выбор", c.Field)
		}
		if len(c.Rules) == 0 {
			return fmt.Errorf("у категорий нет правил")
		}
		if err := checkRules(c.Rules, true); err != nil {
			return fmt.Errorf("категории: %w", err)
		}
	}
	return nil
}

// checkRules — правила по тексту: у каждого есть что сравнивать, у
// категорий — ещё и подпись.
func checkRules(rules []Rule, needLabel bool) error {
	if len(rules) > maxListItems {
		return fmt.Errorf("правил — не больше %d", maxListItems)
	}
	for i, r := range rules {
		tokens := append(append([]string(nil), r.Contains...), r.Equals...)
		if len(tokens) == 0 || len(tokens) > maxRuleTokens {
			return fmt.Errorf("правило %d: от 1 до %d подстрок (contains) или значений (equals)", i+1, maxRuleTokens)
		}
		for _, t := range tokens {
			if strings.TrimSpace(t) == "" || len([]rune(t)) > maxLabelLen {
				return fmt.Errorf("правило %d: пустая или слишком длинная подстрока", i+1)
			}
		}
		if needLabel && strings.TrimSpace(r.Label) == "" {
			return fmt.Errorf("правило %d: нужна подпись (label)", i+1)
		}
	}
	return nil
}
