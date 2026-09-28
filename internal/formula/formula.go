// Package formula — мини-язык формул схем листа и карточек (задача «Схемы
// листа и карточек»): числа, + - * /, скобки, сравнения, and/or/not,
// функции floor ceil round min max abs if и ссылки @поле. В бросках к ним
// добавляются кубы: «1d20 + @str_mod» сводится к строке, которую бросает
// сервер («1d20+3», см. service/dice.go).
//
// Это не JS и не eval: формула разбирается один раз в дерево и считается
// обходом дерева, ссылки отдаются вызывающему (Resolver).
//
// Зеркало на клиенте — web/src/schema-formula.js. Обе реализации гоняют одни
// и те же случаи из testdata/cases.json, поэтому любое изменение языка
// делается в обеих сразу, вместе с новыми случаями.
package formula

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"unicode"
)

// MaxLen — предел длины формулы в символах.
const MaxLen = 2000

// Пределы броска — те же, что у сервера (service/dice.go), чтобы ошибка
// была видна на поле, а не отказом при броске.
const (
	maxDepth     = 64
	maxDiceCount = 100
	maxDiceSides = 1000
	maxDiceTerms = 20
	maxConst     = 99999
)

// Коды ошибок — те же в web/src/schema-formula.js: по ним сверяются общие
// случаи (тексты сообщений у реализаций свои, но одинаковые по смыслу).
const (
	CodeSyntax      = "syntax"
	CodeTooLong     = "too_long"
	CodeTooDeep     = "too_deep"
	CodeUnknownFunc = "unknown_func"
	CodeArity       = "arity"
	CodeDivZero     = "div_zero"
	CodeTooBig      = "too_big"
	CodeDiceHere    = "dice_here"
	CodeDiceCount   = "dice_count"
	CodeDiceSides   = "dice_sides"
	CodeDiceLimit   = "dice_limit"
	CodeNotNumber   = "not_number"
	CodeRefError    = "ref_error"
	CodeCycle       = "cycle"
	CodeUnknownRef  = "unknown_ref"
)

// Error — ошибка формулы: код, место (номер символа с 1; 0 — без места) и
// подробность (имя функции, ссылки, текст синтаксической ошибки).
type Error struct {
	Code   string
	Pos    int
	Detail string
}

func (e *Error) Error() string {
	var msg string
	switch e.Code {
	case CodeSyntax, CodeArity:
		msg = e.Detail
	case CodeTooLong:
		msg = fmt.Sprintf("формула длиннее %d символов", MaxLen)
	case CodeTooDeep:
		msg = "формула вложена слишком глубоко"
	case CodeUnknownFunc:
		msg = fmt.Sprintf("неизвестная функция «%s»", e.Detail)
	case CodeDivZero:
		msg = "деление на ноль"
	case CodeTooBig:
		msg = "слишком большое число"
	case CodeDiceHere:
		msg = "кубы можно только прибавлять и вычитать в броске"
	case CodeDiceCount:
		msg = "число кубов не может быть отрицательным"
	case CodeDiceSides:
		msg = fmt.Sprintf("у куба от 2 до %d граней", maxDiceSides)
	case CodeDiceLimit:
		msg = fmt.Sprintf("в броске больше %d кубов или %d слагаемых", maxDiceCount, maxDiceTerms)
	case CodeNotNumber:
		msg = fmt.Sprintf("@%s — не число", e.Detail)
	case CodeRefError:
		msg = fmt.Sprintf("ошибка в @%s", e.Detail)
	case CodeCycle:
		msg = "цикл: " + e.Detail
	case CodeUnknownRef:
		msg = fmt.Sprintf("неизвестная ссылка @%s", e.Detail)
	default:
		msg = e.Code
	}
	if e.Pos > 0 {
		msg += fmt.Sprintf(" (символ %d)", e.Pos)
	}
	return msg
}

func syntaxErr(pos int, format string, args ...any) *Error {
	return &Error{Code: CodeSyntax, Pos: pos, Detail: fmt.Sprintf(format, args...)}
}

// ---------- разбор на слова ----------

type tokKind int

const (
	tEOF tokKind = iota
	tNum
	tRef
	tIdent
	tOp
)

type token struct {
	kind tokKind
	text string
	num  float64
	pos  int
}

func isDigit(c rune) bool { return c >= '0' && c <= '9' }

func isRefChar(c rune) bool {
	return unicode.IsLetter(c) || isDigit(c) || c == '_' || c == '.'
}

func lex(src []rune) []token {
	var out []token
	n := len(src)
	for i := 0; i < n; {
		c := src[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case isDigit(c):
			j := i
			for j < n && isDigit(src[j]) {
				j++
			}
			if j < n && src[j] == '.' {
				if j+1 >= n || !isDigit(src[j+1]) {
					panic(syntaxErr(j+1, "после точки нужна цифра"))
				}
				j++
				for j < n && isDigit(src[j]) {
					j++
				}
			}
			v, _ := strconv.ParseFloat(string(src[i:j]), 64)
			out = append(out, token{kind: tNum, text: string(src[i:j]), num: v, pos: i + 1})
			i = j
		case c == '@':
			j := i + 1
			for j < n && isRefChar(src[j]) {
				j++
			}
			name := string(src[i+1 : j])
			if name == "" {
				panic(syntaxErr(i+1, "после @ нужно имя поля"))
			}
			if strings.HasPrefix(name, ".") || strings.HasSuffix(name, ".") || strings.Contains(name, "..") {
				panic(syntaxErr(i+1, "неверная ссылка «@%s»", name))
			}
			out = append(out, token{kind: tRef, text: name, pos: i + 1})
			i = j
		case unicode.IsLetter(c) || c == '_':
			j := i
			for j < n && (unicode.IsLetter(src[j]) || src[j] == '_') {
				j++
			}
			out = append(out, token{kind: tIdent, text: string(src[i:j]), pos: i + 1})
			i = j
		case strings.ContainsRune("+-*/(),", c):
			out = append(out, token{kind: tOp, text: string(c), pos: i + 1})
			i++
		case c == '<' || c == '>' || c == '=' || c == '!':
			if i+1 < n && src[i+1] == '=' {
				out = append(out, token{kind: tOp, text: string(src[i : i+2]), pos: i + 1})
				i += 2
				continue
			}
			if c == '=' {
				panic(syntaxErr(i+1, "для сравнения пишите «==»"))
			}
			if c == '!' {
				panic(syntaxErr(i+1, "неожиданный символ «!»"))
			}
			out = append(out, token{kind: tOp, text: string(c), pos: i + 1})
			i++
		default:
			panic(syntaxErr(i+1, "неожиданный символ «%c»", c))
		}
	}
	return append(out, token{kind: tEOF, pos: n + 1})
}

// ---------- дерево ----------

// node — узел дерева формулы. op: "num", "ref", "neg", "not", "and", "or",
// "+", "-", "*", "/", сравнения, "call", "dice" (args — число кубов и
// грани).
type node struct {
	op   string
	num  float64
	name string
	args []*node
	pos  int
}

// Expr — разобранная формула.
type Expr struct {
	root *node
	dice bool
	refs []string
}

// Refs — имена ссылок формулы (без @) в порядке появления, без повторов.
func (e *Expr) Refs() []string { return e.refs }

// arity — число аргументов функции: точное, или -1 — «хотя бы один».
var arity = map[string]int{
	"floor": 1, "ceil": 1, "round": 1, "abs": 1,
	"min": -1, "max": -1,
	"if": 3,
}

type parser struct {
	toks  []token
	i     int
	depth int
	refs  []string
	seen  map[string]bool
}

func (p *parser) cur() token { return p.toks[p.i] }

func (p *parser) next() token {
	t := p.toks[p.i]
	if t.kind != tEOF {
		p.i++
	}
	return t
}

func (p *parser) isOp(text string) bool {
	t := p.cur()
	return t.kind == tOp && t.text == text
}

func (p *parser) isWord(word string) bool {
	t := p.cur()
	return t.kind == tIdent && strings.ToLower(t.text) == word
}

func (p *parser) isDice() bool { return p.isWord("d") || p.isWord("к") }

func (p *parser) enter() {
	p.depth++
	if p.depth > maxDepth {
		panic(&Error{Code: CodeTooDeep, Pos: p.cur().pos})
	}
}

func (p *parser) leave() { p.depth-- }

func (p *parser) parseExpr() *node {
	p.enter()
	defer p.leave()
	return p.parseOr()
}

func (p *parser) parseOr() *node {
	l := p.parseAnd()
	for p.isWord("or") {
		t := p.next()
		l = &node{op: "or", args: []*node{l, p.parseAnd()}, pos: t.pos}
	}
	return l
}

func (p *parser) parseAnd() *node {
	l := p.parseNot()
	for p.isWord("and") {
		t := p.next()
		l = &node{op: "and", args: []*node{l, p.parseNot()}, pos: t.pos}
	}
	return l
}

func (p *parser) parseNot() *node {
	if p.isWord("not") {
		p.enter()
		defer p.leave()
		t := p.next()
		return &node{op: "not", args: []*node{p.parseNot()}, pos: t.pos}
	}
	return p.parseCmp()
}

var cmpOps = map[string]bool{"<": true, "<=": true, ">": true, ">=": true, "==": true, "!=": true}

func (p *parser) parseCmp() *node {
	l := p.parseAdd()
	for p.cur().kind == tOp && cmpOps[p.cur().text] {
		t := p.next()
		l = &node{op: t.text, args: []*node{l, p.parseAdd()}, pos: t.pos}
	}
	return l
}

func (p *parser) parseAdd() *node {
	l := p.parseMul()
	for p.isOp("+") || p.isOp("-") {
		t := p.next()
		l = &node{op: t.text, args: []*node{l, p.parseMul()}, pos: t.pos}
	}
	return l
}

func (p *parser) parseMul() *node {
	l := p.parseUnary()
	for p.isOp("*") || p.isOp("/") {
		t := p.next()
		l = &node{op: t.text, args: []*node{l, p.parseUnary()}, pos: t.pos}
	}
	return l
}

func (p *parser) parseUnary() *node {
	p.enter()
	defer p.leave()
	if p.isOp("-") {
		t := p.next()
		return &node{op: "neg", args: []*node{p.parseUnary()}, pos: t.pos}
	}
	if p.isOp("+") {
		p.next()
		return p.parseUnary()
	}
	return p.parseDice()
}

// parseDice — «NdM», «(выражение)dM», «@полеd6» и «d20» (один куб).
func (p *parser) parseDice() *node {
	if p.isDice() {
		t := p.next()
		return &node{op: "dice", args: []*node{{op: "num", num: 1, pos: t.pos}, p.parseSides(t)}, pos: t.pos}
	}
	x := p.parsePrimary()
	if p.isDice() {
		t := p.next()
		x = &node{op: "dice", args: []*node{x, p.parseSides(t)}, pos: t.pos}
	}
	return x
}

func (p *parser) parseSides(d token) *node {
	t := p.cur()
	if t.kind != tNum && t.kind != tRef && !p.isOp("(") {
		panic(syntaxErr(d.pos, "после «%s» нужно число граней", d.text))
	}
	return p.parsePrimary()
}

func (p *parser) parsePrimary() *node {
	t := p.cur()
	switch t.kind {
	case tNum:
		p.next()
		return &node{op: "num", num: t.num, pos: t.pos}
	case tRef:
		p.next()
		if !p.seen[t.text] {
			p.seen[t.text] = true
			p.refs = append(p.refs, t.text)
		}
		return &node{op: "ref", name: t.text, pos: t.pos}
	case tIdent:
		p.next()
		name := strings.ToLower(t.text)
		if !p.isOp("(") {
			panic(syntaxErr(t.pos, "непонятное слово «%s»", t.text))
		}
		want, ok := arity[name]
		if !ok {
			panic(&Error{Code: CodeUnknownFunc, Pos: t.pos, Detail: t.text})
		}
		p.next()
		var args []*node
		if !p.isOp(")") {
			for {
				args = append(args, p.parseExpr())
				if !p.isOp(",") {
					break
				}
				p.next()
			}
		}
		if !p.isOp(")") {
			panic(syntaxErr(p.cur().pos, "нет закрывающей «)»"))
		}
		p.next()
		switch {
		case want < 0 && len(args) == 0:
			panic(&Error{Code: CodeArity, Pos: t.pos, Detail: fmt.Sprintf("функции «%s» нужен хотя бы один аргумент", name)})
		case want == 1 && len(args) != 1:
			panic(&Error{Code: CodeArity, Pos: t.pos, Detail: fmt.Sprintf("функции «%s» нужен один аргумент", name)})
		case want == 3 && len(args) != 3:
			panic(&Error{Code: CodeArity, Pos: t.pos, Detail: fmt.Sprintf("функции «%s» нужно три аргумента: условие, «да», «нет»", name)})
		}
		return &node{op: "call", name: name, args: args, pos: t.pos}
	case tOp:
		if t.text == "(" {
			p.next()
			x := p.parseExpr()
			if !p.isOp(")") {
				panic(syntaxErr(p.cur().pos, "нет закрывающей «)»"))
			}
			p.next()
			return x
		}
		panic(syntaxErr(t.pos, "неожиданное «%s»", t.text))
	}
	panic(syntaxErr(t.pos, "формула оборвалась"))
}

// checkDice — кубы только слагаемыми верхнего уровня броска: «2*1d6» или
// «max(1d6, 3)» сервер бросить не умеет.
func checkDice(n *node, top bool) {
	switch {
	case n.op == "dice":
		if !top {
			panic(&Error{Code: CodeDiceHere, Pos: n.pos})
		}
		checkDice(n.args[0], false)
		checkDice(n.args[1], false)
	case top && (n.op == "+" || n.op == "-" || n.op == "neg"):
		for _, a := range n.args {
			checkDice(a, true)
		}
	default:
		for _, a := range n.args {
			checkDice(a, false)
		}
	}
}

// Parse разбирает формулу. dice — формула броска: кубы разрешены
// слагаемыми верхнего уровня.
func Parse(src string, dice bool) (expr *Expr, err error) {
	runes := []rune(src)
	if len(runes) > MaxLen {
		return nil, &Error{Code: CodeTooLong}
	}
	if strings.TrimSpace(src) == "" {
		return nil, syntaxErr(0, "формула пустая")
	}
	defer func() {
		if r := recover(); r != nil {
			fe, ok := r.(*Error)
			if !ok {
				panic(r)
			}
			expr, err = nil, fe
		}
	}()
	p := &parser{toks: lex(runes), seen: map[string]bool{}}
	root := p.parseExpr()
	if t := p.cur(); t.kind != tEOF {
		panic(syntaxErr(t.pos, "лишнее «%s»", t.text))
	}
	checkDice(root, dice)
	return &Expr{root: root, dice: dice, refs: p.refs}, nil
}

// ---------- вычисление ----------

// Resolver — значение ссылки @name. Ошибку он возвращает сам (обычно
// *Error с кодом not_number, ref_error или cycle).
type Resolver func(name string) (float64, error)

func finite(v float64) bool { return !math.IsInf(v, 0) && !math.IsNaN(v) }

func bool01(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

func eval(n *node, resolve Resolver) (float64, error) {
	switch n.op {
	case "num":
		return n.num, nil
	case "ref":
		return resolve(n.name)
	case "dice":
		return 0, &Error{Code: CodeDiceHere, Pos: n.pos}
	case "neg":
		v, err := eval(n.args[0], resolve)
		return -v, err
	case "not":
		v, err := eval(n.args[0], resolve)
		return bool01(v == 0), err
	case "and", "or":
		a, err := eval(n.args[0], resolve)
		if err != nil {
			return 0, err
		}
		if n.op == "and" && a == 0 {
			return 0, nil
		}
		if n.op == "or" && a != 0 {
			return 1, nil
		}
		b, err := eval(n.args[1], resolve)
		return bool01(b != 0), err
	case "call":
		return evalCall(n, resolve)
	}
	a, err := eval(n.args[0], resolve)
	if err != nil {
		return 0, err
	}
	b, err := eval(n.args[1], resolve)
	if err != nil {
		return 0, err
	}
	switch n.op {
	case "+":
		return a + b, nil
	case "-":
		return a - b, nil
	case "*":
		return a * b, nil
	case "/":
		if b == 0 {
			return 0, &Error{Code: CodeDivZero, Pos: n.pos}
		}
		return a / b, nil
	case "<":
		return bool01(a < b), nil
	case "<=":
		return bool01(a <= b), nil
	case ">":
		return bool01(a > b), nil
	case ">=":
		return bool01(a >= b), nil
	case "==":
		return bool01(a == b), nil
	case "!=":
		return bool01(a != b), nil
	}
	return 0, fmt.Errorf("formula: неизвестный узел %q", n.op)
}

func evalCall(n *node, resolve Resolver) (float64, error) {
	if n.name == "if" {
		c, err := eval(n.args[0], resolve)
		if err != nil {
			return 0, err
		}
		if c != 0 {
			return eval(n.args[1], resolve)
		}
		return eval(n.args[2], resolve)
	}
	vals := make([]float64, len(n.args))
	for i, a := range n.args {
		v, err := eval(a, resolve)
		if err != nil {
			return 0, err
		}
		vals[i] = v
	}
	switch n.name {
	case "floor":
		return math.Floor(vals[0]), nil
	case "ceil":
		return math.Ceil(vals[0]), nil
	case "round":
		// floor(x + 0.5), а не math.Round: тот округляет −2.5 до −3, а JS
		// Math.round — до −2. Так обе реализации дают одно и то же.
		return math.Floor(vals[0] + 0.5), nil
	case "abs":
		return math.Abs(vals[0]), nil
	case "min", "max":
		out := vals[0]
		for _, v := range vals[1:] {
			if (n.name == "min" && v < out) || (n.name == "max" && v > out) {
				out = v
			}
		}
		return out, nil
	}
	return 0, fmt.Errorf("formula: неизвестная функция %q", n.name)
}

// Eval считает формулу числом.
func (e *Expr) Eval(resolve Resolver) (float64, error) {
	v, err := eval(e.root, resolve)
	if err != nil {
		return 0, err
	}
	if !finite(v) {
		return 0, &Error{Code: CodeTooBig}
	}
	return v, nil
}

// Roll — формула броска, сведённая к грамматике сервера: Formula —
// «1d20+3», Dice — сколько в ней кубов (0 — бросать нечего, результат —
// Const), Const — сумма числовых частей (округлена вниз).
type Roll struct {
	Formula string
	Dice    int
	Const   int
}

type diceTerm struct {
	sign float64
	n    *node
}

func collectTerms(n *node, sign float64, out *[]diceTerm) {
	switch n.op {
	case "+", "-":
		collectTerms(n.args[0], sign, out)
		s := sign
		if n.op == "-" {
			s = -sign
		}
		collectTerms(n.args[1], s, out)
	case "neg":
		collectTerms(n.args[0], -sign, out)
	default:
		*out = append(*out, diceTerm{sign: sign, n: n})
	}
}

// Dice сводит формулу броска к строке для сервера: числовые части
// считаются и складываются в одну константу, кубы остаются. Число кубов и
// граней тоже может быть выражением («(ceil(@level/2))d6») — округляется
// вниз; 0 кубов — слагаемое пропадает.
func (e *Expr) Dice(resolve Resolver) (Roll, error) {
	var terms []diceTerm
	collectTerms(e.root, 1, &terms)
	var parts []string
	constSum := 0.0
	total := 0
	for _, t := range terms {
		if t.n.op != "dice" {
			v, err := eval(t.n, resolve)
			if err != nil {
				return Roll{}, err
			}
			constSum += t.sign * v
			continue
		}
		c, err := eval(t.n.args[0], resolve)
		if err != nil {
			return Roll{}, err
		}
		s, err := eval(t.n.args[1], resolve)
		if err != nil {
			return Roll{}, err
		}
		if !finite(c) || !finite(s) {
			return Roll{}, &Error{Code: CodeTooBig}
		}
		c, s = math.Floor(c), math.Floor(s)
		if c < 0 {
			return Roll{}, &Error{Code: CodeDiceCount, Pos: t.n.pos}
		}
		if c == 0 {
			continue
		}
		if s < 2 || s > maxDiceSides {
			return Roll{}, &Error{Code: CodeDiceSides, Pos: t.n.pos}
		}
		if float64(total)+c > maxDiceCount {
			return Roll{}, &Error{Code: CodeDiceLimit}
		}
		total += int(c)
		sign := "+"
		if t.sign < 0 {
			sign = "-"
		}
		parts = append(parts, fmt.Sprintf("%s%dd%d", sign, int(c), int(s)))
	}
	if !finite(constSum) {
		return Roll{}, &Error{Code: CodeTooBig}
	}
	k := math.Floor(constSum)
	if math.Abs(k) > maxConst {
		return Roll{}, &Error{Code: CodeTooBig}
	}
	n := len(parts)
	if k != 0 {
		n++
	}
	if n > maxDiceTerms {
		return Roll{}, &Error{Code: CodeDiceLimit}
	}
	ki := int(k)
	if len(parts) == 0 {
		return Roll{Formula: strconv.Itoa(ki), Const: ki}, nil
	}
	out := strings.Join(parts, "")
	out = strings.TrimPrefix(out, "+")
	if ki != 0 {
		out += fmt.Sprintf("%+d", ki)
	}
	return Roll{Formula: out, Dice: total, Const: ki}, nil
}
