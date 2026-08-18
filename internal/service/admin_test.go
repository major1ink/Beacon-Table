package service_test

import (
	"context"
	"errors"
	"testing"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository/memory"
	"beacon-table/internal/service"
)

// TestAdminService_UpdateCharacter_BypassesOwnership — в отличие от
// CharacterService (владелец правит только свои id, см.
// TestCharacterService_OwnershipEnforced), AdminService — это ДМ, который
// правит ЛЮБОГО персонажа (панель "Персонажи" в dm.html): не зная и не
// передавая accountID владельца явно.
func TestAdminService_UpdateCharacter_BypassesOwnership(t *testing.T) {
	ctx := context.Background()
	accounts := memory.NewAccountStore()
	sessions := memory.NewSessionStore(accounts)
	characters := memory.NewCharacterStore()

	chars := service.NewCharacterService(characters, nil)
	admin := service.NewAdminService(accounts, sessions, characters, "co-1")

	c, err := chars.Create(ctx, "acc-player", "Drizzt", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := admin.UpdateCharacter(ctx, c.ID, "Drizzt Do'Urden", "http://example.com/a.png"); err != nil {
		t.Fatalf("AdminService.UpdateCharacter: %v", err)
	}
	got, err := chars.Get(ctx, c.ID, "acc-player")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Name != "Drizzt Do'Urden" || got.AvatarURL != "http://example.com/a.png" {
		t.Fatalf("правка не применилась: %+v", got)
	}

	if err := admin.UpdateCharacter(ctx, "no-such-id", "x", ""); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("ожидали ErrNotFound на несуществующем id, получили %v", err)
	}
}

// TestAdminService_UpdateCharacterSheet_BypassesOwnership — тот же принцип,
// что и выше, но для листа персонажа (character-sheet.html в режиме ДМ).
func TestAdminService_UpdateCharacterSheet_BypassesOwnership(t *testing.T) {
	ctx := context.Background()
	accounts := memory.NewAccountStore()
	sessions := memory.NewSessionStore(accounts)
	characters := memory.NewCharacterStore()

	chars := service.NewCharacterService(characters, nil)
	admin := service.NewAdminService(accounts, sessions, characters, "co-1")

	c, err := chars.Create(ctx, "acc-player", "Bruenor", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	sheet := domain.DefaultCharacterSheet()
	sheet.Abilities.Con = 18
	sheet.Info.Level = 7
	if err := admin.UpdateCharacterSheet(ctx, c.ID, sheet); err != nil {
		t.Fatalf("AdminService.UpdateCharacterSheet: %v", err)
	}

	got, err := chars.Get(ctx, c.ID, "acc-player")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Sheet.Abilities.Con != 18 || got.Sheet.Info.Level != 7 {
		t.Fatalf("лист не сохранился как ожидалось: %+v", got.Sheet)
	}

	if err := admin.UpdateCharacterSheet(ctx, "no-such-id", sheet); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("ожидали ErrNotFound на несуществующем id, получили %v", err)
	}
}
