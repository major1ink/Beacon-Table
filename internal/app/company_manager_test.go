package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository/sqlite"
)

func TestCompanyManager_Deactivate(t *testing.T) {
	ctx := context.Background()
	m, _ := newTestManager(t)

	if err := m.companies.SetActiveID(ctx, "some-world"); err != nil {
		t.Fatalf("SetActiveID: %v", err)
	}
	// current == nil (ничего реально не поднято) — Deactivate не должен падать.
	if err := m.Deactivate(ctx); err != nil {
		t.Fatalf("Deactivate: %v", err)
	}
	if id, _ := m.companies.ActiveID(ctx); id != "" {
		t.Fatalf("active_company_id не очищен: %q", id)
	}
	if m.Current() != nil {
		t.Fatal("Current() не nil после Deactivate")
	}
}

func TestCompanyManager_DeleteRefusesActive(t *testing.T) {
	ctx := context.Background()
	m, _ := newTestManager(t)

	c, err := m.Create(ctx, "На столе", domain.SystemDnD5e2024)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	m.mu.Lock()
	m.current = &ActiveWorld{Company: c}
	m.mu.Unlock()

	if err := m.Delete(ctx, c.ID, true); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("ожидали ErrForbidden для запущенного мира, получили %v", err)
	}
}

func TestCompanyManager_DeleteForceCascades(t *testing.T) {
	ctx := context.Background()
	m, _ := newTestManager(t)

	// аккаунт ДМ (глобальный) — не должен пострадать
	if err := m.accounts.Create(ctx, &domain.Account{
		ID: "acc-dm", Username: "dm", PasswordHash: "h",
		Role: domain.AccountRoleAdmin, Status: domain.AccountStatusActive,
	}); err != nil {
		t.Fatalf("dm: %v", err)
	}

	c, err := m.Create(ctx, "Кампания", domain.SystemDnD5e2024)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := m.accounts.Create(ctx, &domain.Account{
		ID: "acc-p", Username: "player", PasswordHash: "h",
		Role: domain.AccountRolePlayer, Status: domain.AccountStatusActive, CompanyID: c.ID,
	}); err != nil {
		t.Fatalf("player: %v", err)
	}
	cstore := sqlite.NewCharacterStore(m.db, c.ID, c.System)
	if err := cstore.Create(ctx, &domain.Character{ID: "char-p", AccountID: "acc-p", Name: "Пик"}); err != nil {
		t.Fatalf("char: %v", err)
	}
	if _, err := cstore.AddInventoryEntry(ctx, "char-p", "acc-p", domain.InventoryEntry{ID: "inv-1", Name: "Лук", Quantity: 1}); err != nil {
		t.Fatalf("inv: %v", err)
	}
	if err := sqlite.NewPregenStore(m.db, c.ID).Create(ctx, &domain.Pregen{ID: "pg-1", Name: "Аня"}); err != nil {
		t.Fatalf("pregen: %v", err)
	}
	ps := sqlite.NewPlaylistStore(m.db, c.ID)
	if err := ps.Create(ctx, "pl-1", "Бой"); err != nil {
		t.Fatalf("playlist: %v", err)
	}
	if err := ps.AddTrack(ctx, "tr-1", "pl-1", "u", "т", 0.5, false); err != nil {
		t.Fatalf("track: %v", err)
	}

	dataRoot, uploadsRoot, _ := m.rootsFor(c)
	writeFile(t, filepath.Join(dataRoot, "scenes", "s.json"), "{}")
	writeFile(t, filepath.Join(uploadsRoot, "maps", "m.png"), "PNG")

	// без force — блок, если есть аккаунты игроков
	if err := m.Delete(ctx, c.ID, false); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("ожидали ErrConflict без force, получили %v", err)
	}

	if err := m.Delete(ctx, c.ID, true); err != nil {
		t.Fatalf("Delete force: %v", err)
	}

	if _, err := m.companies.ByID(ctx, c.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("мир не удалён: %v", err)
	}
	if _, err := m.accounts.ByID(ctx, "acc-p"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("аккаунт игрока не удалён: %v", err)
	}
	if _, err := m.accounts.ByID(ctx, "acc-dm"); err != nil {
		t.Fatalf("аккаунт ДМ пострадал: %v", err)
	}
	if pgs, _ := sqlite.NewPregenStore(m.db, c.ID).List(ctx); len(pgs) != 0 {
		t.Fatalf("прегены остались: %+v", pgs)
	}
	if pls, _ := sqlite.NewPlaylistStore(m.db, c.ID).List(ctx); len(pls) != 0 {
		t.Fatalf("плейлисты остались: %+v", pls)
	}
	var invCount int
	if err := m.db.QueryRowContext(ctx, `SELECT COUNT(1) FROM inventory_items WHERE company_id = ?`, c.ID).Scan(&invCount); err != nil {
		t.Fatalf("count inv: %v", err)
	}
	if invCount != 0 {
		t.Fatalf("инвентарь остался: %d строк", invCount)
	}
	if _, err := os.Stat(dataRoot); !os.IsNotExist(err) {
		t.Fatalf("каталог data мира не удалён: %v", err)
	}
	if _, err := os.Stat(uploadsRoot); !os.IsNotExist(err) {
		t.Fatalf("каталог uploads мира не удалён: %v", err)
	}
}
