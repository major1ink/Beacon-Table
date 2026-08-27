package sqlite

import (
	"context"
	"testing"

	"beacon-table/internal/domain"
)

// TestCharacterStore_SetInventoryEquipped_SplitsAndMerges — тот же сценарий,
// что и в service.TestCharacterService_UpdateInventoryItem_EquipSplitsAndMerges,
// но напрямую на sqlite-реализации: надеть одну вещь из стопки в три
// одинаковых отделяет её в свою запись (1 надета, 2 остаются стопкой), снять
// обратно — сливает всё в одну запись на три.
func TestCharacterStore_SetInventoryEquipped_SplitsAndMerges(t *testing.T) {
	ctx := context.Background()
	db, err := Open(":memory:")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()

	const accountID, companyID, characterID = "acc-1", "company-1", "char-1"
	if _, err := db.ExecContext(ctx,
		`INSERT INTO accounts (id, username, password_hash, role, status, must_change_password, created_at, company_id) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
		accountID, "player", "hash", "player", "active", "2024-01-01T00:00:00Z", companyID,
	); err != nil {
		t.Fatalf("insert account: %v", err)
	}
	if _, err := db.ExecContext(ctx,
		`INSERT INTO characters (id, account_id, name, avatar_url, sheet_json, created_at, company_id) VALUES (?, ?, ?, '', '{}', ?, ?)`,
		characterID, accountID, "Дриззт", "2024-01-01T00:00:00Z", companyID,
	); err != nil {
		t.Fatalf("insert character: %v", err)
	}

	store := NewCharacterStore(db, companyID, "dnd5e-2024")
	entry, err := store.AddInventoryEntry(ctx, characterID, accountID, domain.InventoryEntry{ID: "seed-1", ItemID: "sword", Name: "Скимитар", Quantity: 3})
	if err != nil {
		t.Fatalf("AddInventoryEntry: %v", err)
	}

	found, err := store.SetInventoryEquipped(ctx, characterID, accountID, entry.ID, "split-1", true)
	if err != nil || !found {
		t.Fatalf("SetInventoryEquipped(надеть): found=%v err=%v", found, err)
	}
	list, err := store.ListInventory(ctx, characterID)
	if err != nil {
		t.Fatalf("ListInventory: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("ожидали 2 записи после расщепления, получили %d: %+v", len(list), list)
	}
	var equipped, rest *domain.InventoryEntry
	for _, e := range list {
		if e.Equipped {
			equipped = e
		} else {
			rest = e
		}
	}
	if equipped == nil || rest == nil {
		t.Fatalf("ожидали одну надетую и одну обычную запись: %+v", list)
	}
	if equipped.Quantity != 1 || rest.Quantity != 2 {
		t.Fatalf("ожидали 1 надетую и 2 в стопке, получили equipped=%d rest=%d", equipped.Quantity, rest.Quantity)
	}

	found, err = store.SetInventoryEquipped(ctx, characterID, accountID, equipped.ID, "unused", false)
	if err != nil || !found {
		t.Fatalf("SetInventoryEquipped(снять): found=%v err=%v", found, err)
	}
	list, err = store.ListInventory(ctx, characterID)
	if err != nil {
		t.Fatalf("ListInventory: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("ожидали слияние обратно в одну запись, получили %d: %+v", len(list), list)
	}
	if list[0].Quantity != 3 || list[0].Equipped {
		t.Fatalf("ожидали 3 штуки, не надето, получили %+v", list[0])
	}
}

// TestCharacterStore_SetInventoryEquipped_NoSiblingInsertsNewRow — надеть
// единственный экземпляр предмета без соседней записи заводит новую строку
// (а не теряет вещь), а повторное "надеть" уже надетой — no-op.
func TestCharacterStore_SetInventoryEquipped_NoSiblingInsertsNewRow(t *testing.T) {
	ctx := context.Background()
	db, err := Open(":memory:")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()

	const accountID, companyID, characterID = "acc-1", "company-1", "char-1"
	if _, err := db.ExecContext(ctx,
		`INSERT INTO accounts (id, username, password_hash, role, status, must_change_password, created_at, company_id) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
		accountID, "player", "hash", "player", "active", "2024-01-01T00:00:00Z", companyID,
	); err != nil {
		t.Fatalf("insert account: %v", err)
	}
	if _, err := db.ExecContext(ctx,
		`INSERT INTO characters (id, account_id, name, avatar_url, sheet_json, created_at, company_id) VALUES (?, ?, ?, '', '{}', ?, ?)`,
		characterID, accountID, "Дриззт", "2024-01-01T00:00:00Z", companyID,
	); err != nil {
		t.Fatalf("insert character: %v", err)
	}

	store := NewCharacterStore(db, companyID, "dnd5e-2024")
	entry, err := store.AddInventoryEntry(ctx, characterID, accountID, domain.InventoryEntry{ID: "seed-1", ItemID: "cloak", Name: "Плащ", Quantity: 1})
	if err != nil {
		t.Fatalf("AddInventoryEntry: %v", err)
	}

	if found, err := store.SetInventoryEquipped(ctx, characterID, accountID, entry.ID, "unused", true); err != nil || !found {
		t.Fatalf("SetInventoryEquipped(надеть): found=%v err=%v", found, err)
	}
	// Повтор того же состояния — no-op, ничего не расщепляет.
	if found, err := store.SetInventoryEquipped(ctx, characterID, accountID, entry.ID, "unused", true); err != nil || !found {
		t.Fatalf("SetInventoryEquipped(повтор): found=%v err=%v", found, err)
	}
	list, err := store.ListInventory(ctx, characterID)
	if err != nil {
		t.Fatalf("ListInventory: %v", err)
	}
	if len(list) != 1 || !list[0].Equipped || list[0].Quantity != 1 {
		t.Fatalf("ожидали одну надетую запись с quantity=1, получили %+v", list)
	}
}
