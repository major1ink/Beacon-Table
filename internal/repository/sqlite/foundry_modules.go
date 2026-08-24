package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"beacon-table/internal/domain"
)

// FoundryModuleStore реализует repository.FoundryModuleRepository, привязанный
// к одной компании (миру), тем же принципом, что и PlaylistStore (см.
// комментарий его типа) — пересобирается заново на каждый
// service.CompanyManager.Launch.
type FoundryModuleStore struct {
	db        *sql.DB
	companyID string
}

// NewFoundryModuleStore строит репозиторий установленных пакетов Foundry для
// компании companyID.
func NewFoundryModuleStore(db *sql.DB, companyID string) *FoundryModuleStore {
	return &FoundryModuleStore{db: db, companyID: companyID}
}

// Upsert implements repository.FoundryModuleRepository. INSERT ... ON
// CONFLICT — id пакета уникален внутри мира (см. схему таблицы), повторный
// импорт того же модуля обновляет запись на месте, а не плодит вторую.
func (s *FoundryModuleStore) Upsert(ctx context.Context, m domain.FoundryModule) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO foundry_modules (id, company_id, title, version, manifest_url, imported_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (id, company_id) DO UPDATE SET
			title = excluded.title,
			version = excluded.version,
			manifest_url = excluded.manifest_url,
			imported_at = excluded.imported_at
	`, m.ID, s.companyID, m.Title, m.Version, m.ManifestURL, m.ImportedAt.Format(timeLayout))
	return err
}

// List implements repository.FoundryModuleRepository.
func (s *FoundryModuleStore) List(ctx context.Context) ([]*domain.FoundryModule, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, title, version, manifest_url, imported_at FROM foundry_modules
		WHERE company_id = ? ORDER BY imported_at DESC
	`, s.companyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*domain.FoundryModule
	for rows.Next() {
		var m domain.FoundryModule
		var importedAt string
		if err := rows.Scan(&m.ID, &m.Title, &m.Version, &m.ManifestURL, &importedAt); err != nil {
			return nil, err
		}
		m.ImportedAt, _ = time.Parse(timeLayout, importedAt)
		out = append(out, &m)
	}
	return out, rows.Err()
}

// ByID implements repository.FoundryModuleRepository.
func (s *FoundryModuleStore) ByID(ctx context.Context, id string) (*domain.FoundryModule, error) {
	var m domain.FoundryModule
	var importedAt string
	err := s.db.QueryRowContext(ctx, `
		SELECT id, title, version, manifest_url, imported_at FROM foundry_modules
		WHERE id = ? AND company_id = ?
	`, id, s.companyID).Scan(&m.ID, &m.Title, &m.Version, &m.ManifestURL, &importedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, domain.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	m.ImportedAt, _ = time.Parse(timeLayout, importedAt)
	return &m, nil
}

// Delete implements repository.FoundryModuleRepository.
func (s *FoundryModuleStore) Delete(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM foundry_modules WHERE id = ? AND company_id = ?`, id, s.companyID)
	return err
}
