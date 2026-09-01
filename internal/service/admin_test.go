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

	chars := service.NewCharacterService(characters)
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

// TestAdminService_MultipleDM — несколько аккаунтов ДМ: создаются через
// панель, видны в списке аккаунтов любого мира (CompanyID == ""), последний
// удалить нельзя.
func TestAdminService_MultipleDM(t *testing.T) {
	ctx := context.Background()
	accounts := memory.NewAccountStore()
	sessions := memory.NewSessionStore(accounts)
	characters := memory.NewCharacterStore()

	// первый ДМ — как seed "dm"
	if err := accounts.Create(ctx, &domain.Account{
		ID: "dm-1", Username: "dm", PasswordHash: "h", Role: domain.AccountRoleAdmin,
		Status: domain.AccountStatusActive,
	}); err != nil {
		t.Fatalf("seed dm: %v", err)
	}

	admin := service.NewAdminService(accounts, sessions, characters, "co-1")

	dm2, err := admin.CreateAccount(ctx, "dm-two", "password2", domain.AccountRoleAdmin)
	if err != nil {
		t.Fatalf("CreateAccount(admin): %v", err)
	}
	if dm2.CompanyID != "" || dm2.Role != domain.AccountRoleAdmin {
		t.Fatalf("второй ДМ должен быть глобальным admin: %+v", dm2)
	}

	list, err := admin.ListAccounts(ctx)
	if err != nil {
		t.Fatalf("ListAccounts: %v", err)
	}
	admins := 0
	for _, a := range list {
		if a.Role == domain.AccountRoleAdmin {
			admins++
		}
	}
	if admins != 2 {
		t.Fatalf("ожидали 2 ДМ в списке мира, получили %d: %+v", admins, list)
	}

	// второго ДМ можно удалить (первый остаётся)
	if err := admin.DeleteAccount(ctx, "dm-1", dm2.ID); err != nil {
		t.Fatalf("DeleteAccount(второй ДМ): %v", err)
	}
	// последнего — нельзя
	err = admin.DeleteAccount(ctx, dm2.ID, "dm-1")
	var verr *domain.ValidationError
	if !errors.As(err, &verr) {
		t.Fatalf("ожидали ValidationError на удалении последнего ДМ, получили %v", err)
	}
}

// TestAdminService_UpdateCharacterSheet_BypassesOwnership — тот же принцип,
// что и выше, но для листа персонажа (character-sheet.html в режиме ДМ).
func TestAdminService_UpdateCharacterSheet_BypassesOwnership(t *testing.T) {
	ctx := context.Background()
	accounts := memory.NewAccountStore()
	sessions := memory.NewSessionStore(accounts)
	characters := memory.NewCharacterStore()

	chars := service.NewCharacterService(characters)
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
