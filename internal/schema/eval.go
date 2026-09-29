package schema

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"beacon-table/internal/domain"
	"beacon-table/internal/formula"
)

// Формулы схемы (см. internal/formula). Ссылка @name в формуле — по порядку:
//   - id поля схемы — его значение с учётом модификаторов (modifierTarget),
//     у вычисляемого поля — результат его формулы;
//   - stat.<ключ> — свободная характеристика из таблицы со statRows, с
//     модификаторами stat.<ключ>; нет такой строки — 0;
//   - иначе путь в JSON листа или карточки («combat.hpMax», ключ из Extra) —
//     значение как есть, без модификаторов; нет значения — 0.
//
// Зеркало на клиенте — web/src/schema-formula.js: createEvaluator.

// compiled — разобранные формулы полей схемы (один раз на схему), по
// formulaKey.
func (s *Schema) compiled() map[string]compiledFormula {
	s.compileOnce.Do(func() {
		s.formulas = map[string]compiledFormula{}
		for id, f := range s.Fields {
			for _, ff := range formulasOf(f) {
				e, err := formula.Parse(ff.src, ff.dice)
				s.formulas[formulaKey(id, ff.sub)] = compiledFormula{expr: e, err: err}
			}
		}
	})
	return s.formulas
}

type compiledFormula struct {
	expr *formula.Expr
	err  error
}

// fieldFormula — формула поля. sub — какая из формул поля ("" — основная,
// "roll" — бросок по клику, "opt:<значение>" — вариант select); value —
// формула даёт значение поля и потому участвует в поиске циклов.
type fieldFormula struct {
	sub, src    string
	dice, value bool
}

// formulasOf — формулы поля: у вычисляемого — число, у броска — кубы, у
// select — формулы вариантов; у числа и вычисляемого — ещё бросок по клику.
func formulasOf(f *Field) []fieldFormula {
	var out []fieldFormula
	switch f.Type {
	case TypeComputed:
		out = append(out, fieldFormula{src: f.Formula, value: true})
	case TypeRoll:
		return []fieldFormula{{src: f.Roll, dice: true}}
	case TypeSelect:
		for _, o := range f.Options {
			if o.Formula != "" {
				out = append(out, fieldFormula{sub: optionSub(o.Value), src: o.Formula, value: true})
			}
		}
	}
	if f.Roll != "" && (f.Type == TypeNumber || f.Type == TypeComputed) {
		out = append(out, fieldFormula{sub: rollSub, src: f.Roll, dice: true})
	}
	return out
}

const rollSub = "roll"

func optionSub(value string) string { return "opt:" + value }

func formulaKey(id, sub string) string {
	if sub == "" {
		return id
	}
	return id + "#" + sub
}

// hasValueFormula — значение поля считается по формуле: вычисляемое поле или
// select с формулами вариантов.
func hasValueFormula(f *Field) bool {
	for _, ff := range formulasOf(f) {
		if ff.value {
			return true
		}
	}
	return false
}

// checkFormulas — формулы разбираются, ссылки ведут к полю, характеристике
// или пути, который есть у Go-типа root (nil — путь не проверяется), и
// вычисляемые поля не ссылаются друг на друга по кругу. То же для колонок
// таблиц: там @id — сначала колонка той же строки.
func (s *Schema) checkFormulas(root reflect.Type) error {
	graph := map[string][]string{}
	for _, id := range sortedIDs(s.Fields) {
		f := s.Fields[id]
		refs, err := checkFieldFormula(f, root, s.Fields, nil)
		if err != nil {
			return fmt.Errorf("поле %s: %w", id, err)
		}
		if hasValueFormula(f) {
			graph[id] = computedRefs(refs, s.Fields)
		}
		if f.Type != TypeTable {
			continue
		}
		if err := checkTableFormulas(root, id, f, s.Fields); err != nil {
			return err
		}
	}
	return findCycle(graph)
}

// checkTableFormulas — ссылки и циклы формул колонок; у таблицы со строками
// каждая строка проверяется отдельно.
func checkTableFormulas(root reflect.Type, id string, f *Field, fields map[string]*Field) error {
	var row reflect.Type
	if root != nil && len(f.Rows) == 0 {
		if t, err := domain.ResolveJSONPath(root, f.Path); err == nil && t != nil && (t.Kind() == reflect.Slice || t.Kind() == reflect.Array) {
			row = t.Elem()
		}
	}
	if len(f.Rows) > 0 {
		row = root
	}
	cols := map[string]*Field{}
	for _, c := range f.Columns {
		cols[c.ID] = c
	}
	for _, r := range rowsOrOne(f.Rows) {
		colGraph := map[string][]string{}
		for _, c := range f.Columns {
			if src, ok := r.Formulas[c.ID]; ok {
				cc := *c
				cc.Formula = src
				c = &cc
			}
			refs, err := checkFieldFormula(c, row, fields, cols)
			if err != nil {
				return fmt.Errorf("поле %s, колонка %s%s: %w", id, c.ID, rowSuffix(r), err)
			}
			if c.Type == TypeComputed {
				colGraph[c.ID] = computedRefs(refs, cols)
			}
		}
		if err := findCycle(colGraph); err != nil {
			return fmt.Errorf("поле %s%s: %w", id, rowSuffix(r), err)
		}
	}
	return nil
}

// rowSuffix — «, строка <ключ>» для текста ошибки.
func rowSuffix(r Row) string {
	if r.Key == "" {
		return ""
	}
	return ", строка " + r.Key
}

// rowsOrOne — строки таблицы, у таблицы без строк — одна пустая.
func rowsOrOne(rows []Row) []Row {
	if len(rows) == 0 {
		return []Row{{}}
	}
	return rows
}

// checkFieldFormula — разбор формул поля и проверка их ссылок. cols —
// колонки той же строки (у колонки таблицы), root — Go-тип, от которого
// считаются пути (у колонки — тип строки). Возвращает ссылки формул,
// дающих значение поля.
func checkFieldFormula(f *Field, root reflect.Type, fields, cols map[string]*Field) ([]string, error) {
	var out []string
	for _, ff := range formulasOf(f) {
		e, err := formula.Parse(ff.src, ff.dice)
		if err != nil {
			return nil, err
		}
		for _, ref := range e.Refs() {
			if cols[ref] != nil || fields[ref] != nil || strings.HasPrefix(ref, "stat.") {
				continue
			}
			if root != nil {
				if _, err := domain.ResolveJSONPath(root, ref); err != nil {
					return nil, &formula.Error{Code: formula.CodeUnknownRef, Detail: ref}
				}
			}
		}
		if ff.value {
			out = append(out, e.Refs()...)
		}
	}
	return out, nil
}

// computedRefs — ссылки на поля с формулой значения из fields: только из них
// и складывается цикл.
func computedRefs(refs []string, fields map[string]*Field) []string {
	var out []string
	for _, r := range refs {
		if f := fields[r]; f != nil && hasValueFormula(f) {
			out = append(out, r)
		}
	}
	return out
}

// findCycle — первый цикл графа «поле → поля, на которые оно ссылается».
func findCycle(graph map[string][]string) error {
	const (
		fresh = iota
		busy
		done
	)
	state := map[string]int{}
	var stack []string
	var visit func(id string) error
	visit = func(id string) error {
		switch state[id] {
		case busy:
			return &formula.Error{Code: formula.CodeCycle, Detail: cycleChain(stack, id)}
		case done:
			return nil
		}
		state[id] = busy
		stack = append(stack, id)
		for _, next := range graph[id] {
			if err := visit(next); err != nil {
				return err
			}
		}
		stack = stack[:len(stack)-1]
		state[id] = done
		return nil
	}
	for _, id := range sortedIDs(graph) {
		if err := visit(id); err != nil {
			return err
		}
	}
	return nil
}

// cycleChain — «a → b → a»: часть стека от id и снова id.
func cycleChain(stack []string, id string) string {
	i := len(stack) - 1
	for i > 0 && stack[i] != id {
		i--
	}
	return strings.Join(append(append([]string(nil), stack[i:]...), id), " → ")
}

func sortedIDs[T any](m map[string]T) []string {
	out := make([]string, 0, len(m))
	for id := range m {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// Evaluator — значения полей схемы для одного листа или карточки и сведение
// бросков к формуле сервера. Схема может быть nil (система со старым
// бланком): тогда ссылки — только пути в JSON. Один Evaluator — на один
// расчёт: значения запоминаются.
type Evaluator struct {
	s       *Schema
	data    any
	mods    []domain.Modifier
	memo    map[string]evalResult
	busy    map[string]bool
	stack   []string
	inCycle map[string]bool
}

type evalResult struct {
	v   float64
	err error
}

// NewEvaluator — расчёт по листу или карточке src (любая структура,
// которая пишется в JSON) с модификаторами mods (надетые предметы и
// состояния).
func NewEvaluator(s *Schema, src any, mods []domain.Modifier) *Evaluator {
	return &Evaluator{
		s: s, data: jsonTree(src), mods: mods,
		memo: map[string]evalResult{}, busy: map[string]bool{}, inCycle: map[string]bool{},
	}
}

func jsonTree(src any) any {
	if src == nil {
		return nil
	}
	data, err := json.Marshal(src)
	if err != nil {
		return nil
	}
	var out any
	if json.Unmarshal(data, &out) != nil {
		return nil
	}
	return out
}

// Value — значение поля id.
func (e *Evaluator) Value(id string) (float64, error) {
	if r, ok := e.memo[id]; ok {
		return r.v, r.err
	}
	var f *Field
	if e.s != nil {
		f = e.s.Fields[id]
	}
	if f == nil {
		return 0, &formula.Error{Code: formula.CodeUnknownRef, Detail: id}
	}
	if e.busy[id] {
		chain := cycleChain(e.stack, id)
		i := len(e.stack) - 1
		for i > 0 && e.stack[i] != id {
			i--
		}
		for _, m := range e.stack[i:] {
			e.inCycle[m] = true
		}
		return 0, &formula.Error{Code: formula.CodeCycle, Detail: chain}
	}
	e.busy[id] = true
	e.stack = append(e.stack, id)
	v, err := e.compute(id, f)
	e.stack = e.stack[:len(e.stack)-1]
	delete(e.busy, id)
	e.memo[id] = evalResult{v, err}
	return v, err
}

func (e *Evaluator) compute(id string, f *Field) (float64, error) {
	var v float64
	switch f.Type {
	case TypeComputed:
		c := e.s.compiled()[id]
		if c.err != nil {
			return 0, c.err
		}
		var err error
		if v, err = c.expr.Eval(e.resolver(id)); err != nil {
			return 0, err
		}
	case TypeSelect:
		if !hasValueFormula(f) {
			return 0, &formula.Error{Code: formula.CodeNotNumber, Detail: id}
		}
		return e.optionValue(id, f)
	case TypeRoll, TypeTable, TypeResource:
		return 0, &formula.Error{Code: formula.CodeNotNumber, Detail: id}
	default:
		n, ok := toNumber(lookupPath(e.data, f.Path))
		if !ok {
			return 0, &formula.Error{Code: formula.CodeNotNumber, Detail: id}
		}
		v = n
	}
	return e.modify(v, f.ModifierTarget), nil
}

// optionValue — значение select с формулами вариантов: формула выбранного
// варианта, у пустого выбора — 0.
func (e *Evaluator) optionValue(id string, f *Field) (float64, error) {
	chosen, _ := lookupPath(e.data, f.Path).(string)
	if chosen == "" {
		return 0, nil
	}
	c, ok := e.s.compiled()[formulaKey(id, optionSub(chosen))]
	if !ok {
		return 0, &formula.Error{Code: formula.CodeNotNumber, Detail: id}
	}
	if c.err != nil {
		return 0, c.err
	}
	return c.expr.Eval(e.resolver(id))
}

// modify — модификаторы цели target поверх v. Модификаторы целые: основа
// округляется вниз, только если есть что применять.
func (e *Evaluator) modify(v float64, target string) float64 {
	if target == "" || !domain.HasModifiersFor(target, e.mods) {
		return v
	}
	return float64(domain.ApplyModifiers(int(math.Floor(v)), target, e.mods))
}

// resolver — ссылки формулы поля self ("" — формула не поля, а броска).
// Ошибка вычисляемого поля, на которое ссылаются, становится «ошибкой в
// @поле»; только у участников цикла она остаётся циклом.
func (e *Evaluator) resolver(self string) formula.Resolver {
	return func(name string) (float64, error) {
		if e.s != nil {
			if f := e.s.Fields[name]; f != nil {
				v, err := e.Value(name)
				if err == nil || !hasValueFormula(f) {
					return v, err
				}
				var fe *formula.Error
				if errors.As(err, &fe) && fe.Code == formula.CodeCycle && self != "" && e.inCycle[self] {
					return 0, err
				}
				return 0, &formula.Error{Code: formula.CodeRefError, Detail: name}
			}
		}
		if key, ok := strings.CutPrefix(name, "stat."); ok {
			return e.stat(key), nil
		}
		n, ok := toNumber(lookupPath(e.data, name))
		if !ok {
			return 0, &formula.Error{Code: formula.CodeNotNumber, Detail: name}
		}
		return n, nil
	}
}

// stat — свободная характеристика с ключом key: первая строка таблиц со
// statRows (таблицы — по id), чьё название даёт этот ключ.
func (e *Evaluator) stat(key string) float64 {
	if e.s == nil {
		return 0
	}
	for _, id := range sortedIDs(e.s.Fields) {
		f := e.s.Fields[id]
		if f.Type != TypeTable || f.StatRows == nil {
			continue
		}
		var namePath, valuePath string
		for _, c := range f.Columns {
			switch c.ID {
			case f.StatRows.Name:
				namePath = c.Path
			case f.StatRows.Value:
				valuePath = c.Path
			}
		}
		rows, _ := lookupPath(e.data, f.Path).([]any)
		for _, row := range rows {
			name, _ := lookupPath(row, namePath).(string)
			if domain.StatKey(name) != key {
				continue
			}
			v, ok := toNumber(lookupPath(row, valuePath))
			if !ok {
				v = 0
			}
			return e.modify(v, domain.StatTarget(name))
		}
	}
	return 0
}

// Core — значение общего поля ядра target (domain.ModifierTargetAC, …) по
// разделу core схемы; false — схемы нет, поле не привязано или не
// считается. Модификаторы — те, с которыми создан Evaluator: трекер боя
// берёт основу (без модификаторов) и накладывает состояния сам.
func (e *Evaluator) Core(target string) (float64, bool) {
	if e.s == nil || e.s.Core[target] == "" {
		return 0, false
	}
	v, err := e.Value(e.s.Core[target])
	return v, err == nil
}

// Dice сводит формулу броска src к формуле сервера по этому листу или
// карточке.
func (e *Evaluator) Dice(src string) (formula.Roll, error) {
	expr, err := formula.Parse(src, true)
	if err != nil {
		return formula.Roll{}, err
	}
	return expr.Dice(e.resolver(""))
}

// lookupPath — значение по пути «a.b.0» в дереве JSON; nil — его нет.
func lookupPath(data any, path string) any {
	cur := data
	for _, part := range strings.Split(path, ".") {
		switch x := cur.(type) {
		case map[string]any:
			cur = x[part]
		case []any:
			i, err := strconv.Atoi(part)
			if err != nil || i < 0 || i >= len(x) {
				return nil
			}
			cur = x[i]
		default:
			return nil
		}
	}
	return cur
}

var numberRe = regexp.MustCompile(`^[+-]?\d+(\.\d+)?$`)

// toNumber — значение JSON как число: пусто — 0, флажок — 1/0, строка —
// если это число.
func toNumber(v any) (float64, bool) {
	switch x := v.(type) {
	case nil:
		return 0, true
	case float64:
		return x, true
	case bool:
		if x {
			return 1, true
		}
		return 0, true
	case string:
		s := strings.TrimSpace(x)
		if s == "" {
			return 0, true
		}
		if !numberRe.MatchString(s) {
			return 0, false
		}
		n, err := strconv.ParseFloat(s, 64)
		return n, err == nil
	}
	return 0, false
}
