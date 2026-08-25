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
// суммируется в неё, а не плодит вторую строку), иначе новая строка. Надетая
// (equipped) запись в это сопоставление не участвует: новая партия того же
// предмета копится отдельной незанадетой стопкой, отображается отдельно
// от общей кучи (см. InventoryEntry.Equipped). Видит только персонажей,
// реально принадлежащих accountID/этой компании — как и Update/UpdateSheet/
// Delete. entry.ID должен быть уже проставлен вызывающим (service-слоем через
// newID(), как и у остальных Create-подобных методов этого пакета) — при
// апсерте в существующую запись он просто отбрасывается, используется ID уже
// существующей строки.
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
			`SELECT id, quantity FROM inventory_items WHERE character_id = ? AND account_id = ? AND company_id = ? AND item_id = ? AND equipped = 0`,
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

// SetInventoryEquipped implements repository.CharacterRepository — надел/снял
// одну штуку из стопки entryID, расщепляя или сливая её с соседней записью
// того же ItemID (см. интерфейс). Уже в целевом состоянии — no-op (true,
// nil), а не ошибка: повторный клик не должен ничего ломать.
func (s *CharacterStore) SetInventoryEquipped(ctx context.Context, characterID, accountID, entryID, newEntryID string, equipped bool) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()

	var ownerCount int
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(1) FROM characters WHERE id = ? AND account_id = ? AND company_id = ?`,
		characterID, accountID, s.companyID,
	).Scan(&ownerCount); err != nil {
		return false, err
	}
	if ownerCount == 0 {
		return false, nil
	}

	var itemID, name, imageURL, notes string
	var weightLb float64
	var quantity int
	var curEquipped int
	err = tx.QueryRowContext(ctx,
		`SELECT item_id, name, image_url, weight_lb, quantity, equipped, notes FROM inventory_items WHERE id = ? AND character_id = ? AND account_id = ? AND company_id = ?`,
		entryID, characterID, accountID, s.companyID,
	).Scan(&itemID, &name, &imageURL, &weightLb, &quantity, &curEquipped, &notes)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if (curEquipped != 0) == equipped {
		return true, nil
	}

	// Соседняя запись того же предмета уже в целевом equipped-состоянии —
	// штука уходит в неё, а не заводит третью строку. Записи без ItemID
	// сравнивать не с чем — hasSibling так и останется false.
	var siblingID string
	var siblingQty int
	hasSibling := false
	if itemID != "" {
		err := tx.QueryRowContext(ctx,
			`SELECT id, quantity FROM inventory_items WHERE character_id = ? AND account_id = ? AND company_id = ? AND item_id = ? AND equipped = ? AND id != ?`,
			characterID, accountID, s.companyID, itemID, boolToInt(equipped), entryID,
		).Scan(&siblingID, &siblingQty)
		if err == nil {
			hasSibling = true
		} else if !errors.Is(err, sql.ErrNoRows) {
			return false, err
		}
	}

	if itemID == "" || quantity <= 1 {
		// Слить/переключить строку целиком.
		if hasSibling {
			if _, err := tx.ExecContext(ctx, `UPDATE inventory_items SET quantity = ? WHERE id = ?`, siblingQty+quantity, siblingID); err != nil {
				return false, err
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM inventory_items WHERE id = ?`, entryID); err != nil {
				return false, err
			}
		} else if _, err := tx.ExecContext(ctx, `UPDATE inventory_items SET equipped = ? WHERE id = ?`, boolToInt(equipped), entryID); err != nil {
			return false, err
		}
	} else {
		// Отделить одну штуку от стопки.
		if _, err := tx.ExecContext(ctx, `UPDATE inventory_items SET quantity = ? WHERE id = ?`, quantity-1, entryID); err != nil {
			return false, err
		}
		if hasSibling {
			if _, err := tx.ExecContext(ctx, `UPDATE inventory_items SET quantity = ? WHERE id = ?`, siblingQty+1, siblingID); err != nil {
				return false, err
			}
		} else if _, err := tx.ExecContext(ctx,
			`INSERT INTO inventory_items (id, character_id, account_id, company_id, item_id, name, image_url, weight_lb, quantity, equipped, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			newEntryID, characterID, accountID, s.companyID, itemID, name, imageURL, weightLb, 1, boolToInt(equipped), "", time.Now().Format(timeLayout),
		); err != nil {
			return false, err
		}
	}

	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
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
