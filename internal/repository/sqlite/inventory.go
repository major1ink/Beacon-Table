package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"beacon-table/internal/domain"
)

// Инвентарь персонажа — своя таблица inventory_items (см. db.go), НЕ поле
// characters.sheet_json (см. комментарий repository.CharacterRepository про
// гонку с автосейвом листа). account_id/company_id денормализованы на
// строку записи — тот же приём, что у characters/playlists — Update/Remove/
// List фильтруются напрямую без JOIN.

const inventoryColumns = `id, item_id, name, image_url, weight_lb, quantity, equipped, notes`

func scanInventoryEntry(row interface{ Scan(...any) error }) (*domain.InventoryEntry, error) {
	var e domain.InventoryEntry
	var equipped int
	if err := row.Scan(&e.ID, &e.ItemID, &e.Name, &e.ImageURL, &e.WeightLb, &e.Quantity, &equipped, &e.Notes); err != nil {
		return nil, err
	}
	e.Equipped = equipped != 0
	return &e, nil
}

// ListInventory implements repository.CharacterRepository.
func (s *CharacterStore) ListInventory(ctx context.Context, characterID string) ([]*domain.InventoryEntry, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+inventoryColumns+` FROM inventory_items WHERE character_id = ? ORDER BY created_at`, characterID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]*domain.InventoryEntry, 0)
	for rows.Next() {
		e, err := scanInventoryEntry(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// AddInventoryEntry implements repository.CharacterRepository — апсерт по
// ItemID (если он не пустой и такая запись у персонажа уже есть — количество
// суммируется в неё, а не плодит вторую строку), иначе новая строка. Видит
// только персонажей, реально принадлежащих accountID/этой компании — как и
// Update/UpdateSheet/Delete. entry.ID должен быть уже проставлен вызывающим
// (service-слоем через newID(), как и у остальных Create-подобных методов
// этого пакета) — при апсерте в существующую запись он просто отбрасывается,
// используется ID уже существующей строки.
func (s *CharacterStore) AddInventoryEntry(ctx context.Context, characterID, accountID string, entry domain.InventoryEntry) (*domain.InventoryEntry, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	var ownerCount int
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(1) FROM characters WHERE id = ? AND account_id = ? AND company_id = ?`,
		characterID, accountID, s.companyID,
	).Scan(&ownerCount); err != nil {
		return nil, err
	}
	if ownerCount == 0 {
		return nil, domain.ErrNotFound
	}

	if entry.ItemID != "" {
		var existingID string
		var existingQty int
		err := tx.QueryRowContext(ctx,
			`SELECT id, quantity FROM inventory_items WHERE character_id = ? AND account_id = ? AND company_id = ? AND item_id = ?`,
			characterID, accountID, s.companyID, entry.ItemID,
		).Scan(&existingID, &existingQty)
		if err == nil {
			newQty := existingQty + entry.Quantity
			if _, err := tx.ExecContext(ctx, `UPDATE inventory_items SET quantity = ? WHERE id = ?`, newQty, existingID); err != nil {
				return nil, err
			}
			if err := tx.Commit(); err != nil {
				return nil, err
			}
			entry.ID = existingID
			entry.Quantity = newQty
			return &entry, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
	}

	_, err = tx.ExecContext(ctx,
		`INSERT INTO inventory_items (id, character_id, account_id, company_id, item_id, name, image_url, weight_lb, quantity, equipped, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		entry.ID, characterID, accountID, s.companyID, entry.ItemID, entry.Name, entry.ImageURL, entry.WeightLb, entry.Quantity, boolToInt(entry.Equipped), entry.Notes, time.Now().Format(timeLayout),
	)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &entry, nil
}

// UpdateInventoryEntry implements repository.CharacterRepository.
func (s *CharacterStore) UpdateInventoryEntry(ctx context.Context, characterID, accountID, entryID string, quantity int, equipped bool, notes string) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE inventory_items SET quantity = ?, equipped = ?, notes = ? WHERE id = ? AND character_id = ? AND account_id = ? AND company_id = ?`,
		quantity, boolToInt(equipped), notes, entryID, characterID, accountID, s.companyID,
	)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// RemoveInventoryEntry implements repository.CharacterRepository.
func (s *CharacterStore) RemoveInventoryEntry(ctx context.Context, characterID, accountID, entryID string) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM inventory_items WHERE id = ? AND character_id = ? AND account_id = ? AND company_id = ?`,
		entryID, characterID, accountID, s.companyID,
	)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}
