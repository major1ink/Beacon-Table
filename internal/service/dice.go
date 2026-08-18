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

// diceFormulaRe разбирает простые формулы вида "2d6+3", "1d20", "4d8-2" —
// один блок кубиков плюс необязательный модификатор. Несколько блоков в
// одной формуле ("1d20+2d6"), преимущество/помеха и т.п. — за рамками
// первой версии, добавляются по мере необходимости.
var diceFormulaRe = regexp.MustCompile(`^\s*(\d{1,3})d(\d{1,4})\s*([+-]\s*\d{1,4})?\s*$`)

// maxDiceCount/maxDiceSides — потолок, чтобы кривая или намеренно
// злонамеренная формула ("999d999999") не заставила сервер аллоцировать и
// разослать здоровенный payload всем клиентам комнаты — единственная
// причина проверять это на сервере, а не только в UI: клиент игрока не
// доверенный, formula долетает как есть.
const (
	maxDiceCount = 100
	maxDiceSides = 1000
)

type cryptoDiceRoller struct{}

// NewDiceRoller — бросок на crypto/rand, а не math/rand: результат должен
// быть непредсказуем для игроков за столом, это не место для дешёвого ГПСЧ.
func NewDiceRoller() DiceRoller { return cryptoDiceRoller{} }

func (cryptoDiceRoller) Roll(formula string) (domain.RollResult, error) {
	m := diceFormulaRe.FindStringSubmatch(formula)
	if m == nil {
		return domain.RollResult{}, fmt.Errorf("некорректная формула: %q", formula)
	}
	count, _ := strconv.Atoi(m[1])
	sides, _ := strconv.Atoi(m[2])
	if count < 1 || count > maxDiceCount || sides < 2 || sides > maxDiceSides {
		return domain.RollResult{}, fmt.Errorf("формула вне допустимых пределов: %q", formula)
	}
	modifier := 0
	if m[3] != "" {
		v, err := strconv.Atoi(strings.ReplaceAll(m[3], " ", ""))
		if err != nil {
			return domain.RollResult{}, err
		}
		modifier = v
	}

	rolls := make([]int, count)
	total := modifier
	for i := 0; i < count; i++ {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(sides)))
		if err != nil {
			return domain.RollResult{}, err
		}
		v := int(n.Int64()) + 1 // rand.Int даёт [0, sides), кубику нужно [1, sides]
		rolls[i] = v
		total += v
	}
	return domain.RollResult{Rolls: rolls, Modifier: modifier, Total: total}, nil
}
