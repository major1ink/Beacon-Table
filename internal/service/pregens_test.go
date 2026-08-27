package service_test

import (
	"context"
	"errors"
	"testing"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository/memory"
	"beacon-table/internal/service"
)

func TestPregenService_ClaimReleaseFlow(t *testing.T) {
	ctx := context.Background()
	pregens := memory.NewPregenStore()
	chars := memory.NewCharacterStore()
	svc := service.NewPregenService(pregens, chars)

	// Импорт: пустой пре-ген по имени, затем полная перезапись листом.
	p, err := svc.Import(ctx, "  Шила  ")
	if err != nil {
		t.Fatalf("Import: %v", err)
	}
	if p.Name != "Шила" {
		t.Fatalf("ожидали обрезанное имя, получили %q", p.Name)
	}
	sheet := domain.DefaultCharacterSheet()
	sheet.Info.Class = "Плут"
	sheet.Info.Level = 3
	sheet.Combat.HPMax = 21
	if _, err := svc.Update(ctx, p.ID, "Шила", "http://x/a.png", "ag-goblin-trouble", sheet); err != nil {
		t.Fatalf("Update: %v", err)
	}

	if avail, _ := svc.Available(ctx); len(avail) != 1 {
		t.Fatalf("ожидали 1 свободного пре-гена, получили %d", len(avail))
	}

	// Игрок берёт пре-гена — создаётся персонаж с перенесённым листом.
	c, err := svc.Claim(ctx, p.ID, "acc-1")
	if err != nil {
		t.Fatalf("Claim: %v", err)
	}
	if c.AccountID != "acc-1" || c.Name != "Шила" || c.Sheet.Info.Class != "Плут" || c.Sheet.Combat.HPMax != 21 {
		t.Fatalf("лист не перенёсся в персонажа: %+v", c)
	}
	if avail, _ := svc.Available(ctx); len(avail) != 0 {
		t.Fatalf("занятый пре-ген не должен быть в списке свободных")
	}

	// Повторный захват тем же аккаунтом идемпотентен — тот же персонаж.
	c2, err := svc.Claim(ctx, p.ID, "acc-1")
	if err != nil || c2.ID != c.ID {
		t.Fatalf("повторный Claim должен вернуть того же персонажа: c2=%+v err=%v", c2, err)
	}

	// Чужой аккаунт занятого взять не может.
	if _, err := svc.Claim(ctx, p.ID, "acc-2"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("Claim занятого чужим должен быть ErrForbidden, got %v", err)
	}

	// Вернуть в пул — пре-ген снова свободен, персонаж игрока остаётся.
	if err := svc.Release(ctx, p.ID); err != nil {
		t.Fatalf("Release: %v", err)
	}
	if avail, _ := svc.Available(ctx); len(avail) != 1 {
		t.Fatalf("после Release пре-ген должен вернуться в пул")
	}
	if got, err := chars.ByID(ctx, c.ID); err != nil || got.AccountID != "acc-1" {
		t.Fatalf("Release не должен трогать персонажа игрока: got=%+v err=%v", got, err)
	}

	// Назначение ДМ-ом — тот же Claim с явным аккаунтом.
	if _, err := svc.Claim(ctx, p.ID, "acc-3"); err != nil {
		t.Fatalf("назначение аккаунту acc-3: %v", err)
	}
	// Освобождение при удалении аккаунта.
	if err := svc.FreeByAccount(ctx, "acc-3"); err != nil {
		t.Fatalf("FreeByAccount: %v", err)
	}
	if avail, _ := svc.Available(ctx); len(avail) != 1 {
		t.Fatalf("после удаления держателя пре-ген должен освободиться")
	}
}

func TestPregenService_ImportRejectsEmptyName(t *testing.T) {
	svc := service.NewPregenService(memory.NewPregenStore(), memory.NewCharacterStore())
	if _, err := svc.Import(context.Background(), "   "); err == nil {
		t.Fatal("пустое имя пре-гена должно отклоняться")
	}
}
