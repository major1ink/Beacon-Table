package service

import (
	"crypto/rand"
	"fmt"
	"math/big"
	"regexp"
	"strconv"
	"strings"

	"beacon-table/internal/domain"
)

// DiceRoller — бросок формулы кубиков. Интерфейс ради тестируемости Room:
// service-тесты могут подставить детерминированный ролл вместо
// crypto/rand-реализации.
type DiceRoller interface {
	Roll(formula string) (domain.RollResult, error)
}

// diceFormulaRe проверяет формулу ЦЕЛИКОМ (по уже вычищенной от пробелов и
// приведённой к нижнему регистру строке, см. Roll): последовательность
// членов — блок кубиков "NdM" (N можно опустить: "d20" = "1d20") или
// целая константа — через + и -. Так разбираются и "2d6+3"/"1d20", и
// смешанные пулы вида "3d4+2d6+1", которые собирает панель кубов на клиенте
// (см. web/src/dice.js: счётчик кликов по d4/d6/… складывается в одну
// формулу и бросается одной кнопкой).
var diceFormulaRe = regexp.MustCompile(`^[+-]?(?:\d{0,3}d\d{1,4}|\d{1,5})(?:[+-](?:\d{0,3}d\d{1,4}|\d{1,5}))*$`)

// diceTermRe вынимает из уже проверенной diceFormulaRe формулы каждый её
// член со своим знаком: группы — знак, количество кубиков, грани, константа.
var diceTermRe = regexp.MustCompile(`([+-]?)(?:(\d*)d(\d+)|(\d+))`)

// maxDiceCount/maxDiceSides/maxDiceTerms — потолок, чтобы кривая или
// намеренно злонамеренная формула ("999d999999", "1d6+1d6+1d6+…") не
// заставила сервер аллоцировать и разослать здоровенный payload всем
// клиентам комнаты — единственная причина проверять это на сервере, а не
// только в UI: клиент игрока не доверенный, formula долетает как есть.
// maxDiceCount — ограничение на ВСЮ формулу, а не на отдельный её блок:
// "50d6+50d6" стоит серверу ровно столько же, сколько "100d6".
const (
	maxDiceCount = 100
	maxDiceSides = 1000
	maxDiceTerms = 20
)

type cryptoDiceRoller struct{}

// NewDiceRoller — бросок на crypto/rand, а не math/rand: результат должен
// быть непредсказуем для игроков за столом, это не место для дешёвого ГПСЧ.
func NewDiceRoller() DiceRoller { return cryptoDiceRoller{} }

// Roll бросает формулу и возвращает ПЛОСКИЙ список выпавших значений в
// порядке блоков формулы (RollResult.Rolls) — разбить его обратно по блокам
// клиент умеет сам, у него есть та же formula (см. web/src/dice.js:
// formatRolls). Modifier — сумма одних только констант формулы; знак члена
// учитывается в Total (то есть "2d6-1d4" вычтет выпавшее на d4, хотя в
// Rolls его значение лежит как есть, лицевой стороной вверх).
func (cryptoDiceRoller) Roll(formula string) (domain.RollResult, error) {
	normalized := strings.ToLower(strings.ReplaceAll(formula, " ", ""))
	if !diceFormulaRe.MatchString(normalized) {
		return domain.RollResult{}, fmt.Errorf("некорректная формула: %q", formula)
	}
	terms := diceTermRe.FindAllStringSubmatch(normalized, -1)
	if len(terms) > maxDiceTerms {
		return domain.RollResult{}, fmt.Errorf("слишком много слагаемых в формуле: %q", formula)
	}

	var rolls []int
	modifier := 0
	total := 0
	for _, t := range terms {
		sign := 1
		if t[1] == "-" {
			sign = -1
		}
		if t[3] == "" { // константа
			v, err := strconv.Atoi(t[4])
			if err != nil {
				return domain.RollResult{}, err
			}
			modifier += sign * v
			total += sign * v
			continue
		}
		count := 1
		if t[2] != "" { // "d20" без числа — это один кубик
			var err error
			if count, err = strconv.Atoi(t[2]); err != nil {
				return domain.RollResult{}, err
			}
		}
		sides, err := strconv.Atoi(t[3])
		if err != nil {
			return domain.RollResult{}, err
		}
		if count < 1 || sides < 2 || sides > maxDiceSides || len(rolls)+count > maxDiceCount {
			return domain.RollResult{}, fmt.Errorf("формула вне допустимых пределов: %q", formula)
		}
		for i := 0; i < count; i++ {
			n, rerr := rand.Int(rand.Reader, big.NewInt(int64(sides)))
			if rerr != nil {
				return domain.RollResult{}, rerr
			}
			v := int(n.Int64()) + 1 // rand.Int даёт [0, sides), кубику нужно [1, sides]
			rolls = append(rolls, v)
			total += sign * v
		}
	}
	if len(rolls) == 0 {
		return domain.RollResult{}, fmt.Errorf("в формуле нет ни одного кубика: %q", formula)
	}
	return domain.RollResult{Rolls: rolls, Modifier: modifier, Total: total}, nil
}
