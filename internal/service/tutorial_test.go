package service_test

import (
	"context"
	"errors"
	"testing"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository/memory"
	"beacon-table/internal/service"
)

// TestTutorialStateUnsetUntilAnswered — на свежей установке состояние
// пустое: именно по нему экран миров решает, задавать ли вопрос.
func TestTutorialStateUnsetUntilAnswered(t *testing.T) {
	ctx := context.Background()
	svc := service.NewTutorialService(memory.NewServerStateStore())

	state, err := svc.State(ctx)
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if state != domain.TutorialUnset {
		t.Fatalf("на свежей установке состояние %q, ожидалось пустое", state)
	}

	if err := svc.SetState(ctx, domain.TutorialOff); err != nil {
		t.Fatalf("SetState: %v", err)
	}
	state, err = svc.State(ctx)
	if err != nil {
		t.Fatalf("State (повторно): %v", err)
	}
	if state != domain.TutorialOff {
		t.Fatalf("после отказа состояние %q, ожидалось %q", state, domain.TutorialOff)
	}
}

// TestTutorialRejectsUnknownState — в хранилище попадают только известные
// значения: форма может прислать что угодно.
func TestTutorialRejectsUnknownState(t *testing.T) {
	ctx := context.Background()
	svc := service.NewTutorialService(memory.NewServerStateStore())

	err := svc.SetState(ctx, "maybe")
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("SetState(maybe): ожидалась ErrValidation, получено %v", err)
	}
}
