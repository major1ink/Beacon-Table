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

func TestDiceRoller_RejectsOutOfBounds(t *testing.T) {
	roller := service.NewDiceRoller()
	if _, err := roller.Roll("999d999999"); err == nil {
		t.Fatal("ожидали ошибку для формулы вне лимитов")
	}
}

func TestDiceRoller_RejectsGarbage(t *testing.T) {
	roller := service.NewDiceRoller()
	if _, err := roller.Roll("not a formula"); err == nil {
		t.Fatal("ожидали ошибку для некорректной формулы")
	}
}
