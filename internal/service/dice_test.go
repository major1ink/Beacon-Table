package service_test

import (
	"testing"

	"beacon-table/internal/service"
)

func TestDiceRoller_Roll(t *testing.T) {
	roller := service.NewDiceRoller()

	result, err := roller.Roll("3d6+2")
	if err != nil {
		t.Fatalf("Roll: %v", err)
	}
	if len(result.Rolls) != 3 {
		t.Fatalf("ожидали 3 кубика, получили %d", len(result.Rolls))
	}
	sum := result.Modifier
	for _, v := range result.Rolls {
		if v < 1 || v > 6 {
			t.Fatalf("значение кубика вне диапазона: %d", v)
		}
		sum += v
	}
	if sum != result.Total {
		t.Fatalf("сумма не сходится: посчитано %d, Total %d", sum, result.Total)
	}
}

// TestDiceRoller_MixedPool — пул из разных кубиков, который собирает панель
// кубов кликами (см. web/src/dice.js): значения в Rolls лежат ПЛОСКО, в
// порядке блоков формулы, чтобы клиент мог разбить их обратно по тем же
// блокам.
func TestDiceRoller_MixedPool(t *testing.T) {
	roller := service.NewDiceRoller()

	result, err := roller.Roll("3d4+2d6+1")
	if err != nil {
		t.Fatalf("Roll: %v", err)
	}
	if len(result.Rolls) != 5 {
		t.Fatalf("ожидали 5 кубиков, получили %d", len(result.Rolls))
	}
	for i, v := range result.Rolls[:3] {
		if v < 1 || v > 4 {
			t.Fatalf("rolls[%d]=%d вне диапазона d4", i, v)
		}
	}
	for i, v := range result.Rolls[3:] {
		if v < 1 || v > 6 {
			t.Fatalf("rolls[%d]=%d вне диапазона d6", i+3, v)
		}
	}
	if result.Modifier != 1 {
		t.Fatalf("ожидали модификатор 1, получили %d", result.Modifier)
	}
	sum := result.Modifier
	for _, v := range result.Rolls {
		sum += v
	}
	if sum != result.Total {
		t.Fatalf("сумма не сходится: посчитано %d, Total %d", sum, result.Total)
	}
}

// TestDiceRoller_NegativeDiceBlock — знак члена учитывается в Total, но в
// Rolls значение остаётся лицевой стороной вверх (см. doc-комментарий Roll).
func TestDiceRoller_NegativeDiceBlock(t *testing.T) {
	roller := service.NewDiceRoller()

	result, err := roller.Roll("1d20-1d4")
	if err != nil {
		t.Fatalf("Roll: %v", err)
	}
	if len(result.Rolls) != 2 {
		t.Fatalf("ожидали 2 кубика, получили %d", len(result.Rolls))
	}
	if want := result.Rolls[0] - result.Rolls[1]; result.Total != want {
		t.Fatalf("ожидали Total %d, получили %d", want, result.Total)
	}
}

// TestDiceRoller_ImplicitCount — "d20" без числа спереди это один кубик:
// так формулу чаще всего набирают руками в поле панели.
func TestDiceRoller_ImplicitCount(t *testing.T) {
	roller := service.NewDiceRoller()

	result, err := roller.Roll("d20+3")
	if err != nil {
		t.Fatalf("Roll: %v", err)
	}
	if len(result.Rolls) != 1 {
		t.Fatalf("ожидали 1 кубик, получили %d", len(result.Rolls))
	}
	if result.Modifier != 3 {
		t.Fatalf("ожидали модификатор 3, получили %d", result.Modifier)
	}
}

func TestDiceRoller_RejectsOutOfBounds(t *testing.T) {
	roller := service.NewDiceRoller()
	if _, err := roller.Roll("999d999999"); err == nil {
		t.Fatal("ожидали ошибку для формулы вне лимитов")
	}
	// Потолок кубиков — на всю формулу целиком, а не на отдельный блок.
	if _, err := roller.Roll("60d6+60d6"); err == nil {
		t.Fatal("ожидали ошибку: суммарно больше 100 кубиков")
	}
}

func TestDiceRoller_RejectsGarbage(t *testing.T) {
	roller := service.NewDiceRoller()
	for _, formula := range []string{"not a formula", "", "2d6+", "2d6++1", "5", "2d6 2d6"} {
		if _, err := roller.Roll(formula); err == nil {
			t.Fatalf("ожидали ошибку для некорректной формулы %q", formula)
		}
	}
}
