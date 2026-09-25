package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"beacon-table/internal/domain"
)

// stateActiveCompanyKey/stateLegacyCompanyKey — ключи server_state, см.
// repository.CompanyRepository.
const (
	stateActiveCompanyKey = "active_company_id"
	stateLegacyCompanyKey = "legacy_company_id"
)

// CompanyStore реализует repository.CompanyRepository.
type CompanyStore struct {
	db *sql.DB
}

// NewCompanyStore строит репозиторий миров поверх db, открытого Open.
func NewCompanyStore(db *sql.DB) *CompanyStore {
	return &CompanyStore{db: db}
}

func scanCompany(row interface{ Scan(...any) error }) (*domain.Company, error) {
	var c domain.Company
	var createdAt, modules string
	if err := row.Scan(&c.ID, &c.Name, &c.System, &modules, &createdAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, domain.ErrNotFound
		}
		return nil, err
	}
	c.CreatedAt, _ = time.Parse(timeLayout, createdAt)
	// Пустая строка — мир до модулей (nil, см. Company.EnabledModules);
	// "[]" — модули явно выключены все.
	if modules != "" {
		c.Modules = []string{}
		_ = json.Unmarshal([]byte(modules), &c.Modules)
	}
	return &c, nil
}

func encodeModules(modules []string) string {
	if modules == nil {
		return ""
	}
	b, _ := json.Marshal(modules)
	return string(b)
}

// SetModules — какие модули подключены к миру (порядок важен, см.
// domain.Company.Modules).
func (s *CompanyStore) SetModules(ctx context.Context, id string, modules []string) error {
	if modules == nil {
		modules = []string{}
	}
	res, err := s.db.ExecContext(ctx, `UPDATE companies SET modules = ? WHERE id = ?`, encodeModules(modules), id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return domain.ErrNotFound
	}
	return nil
}

// Create implements repository.CompanyRepository.
func (s *CompanyStore) Create(ctx context.Context, c *domain.Company) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO companies (id, name, system, modules, created_at) VALUES (?, ?, ?, ?, ?)`,
		c.ID, c.Name, c.System, encodeModules(c.Modules), time.Now().Format(timeLayout),
	)
	return err
}

// List implements repository.CompanyRepository.
func (s *CompanyStore) List(ctx context.Context) ([]*domain.Company, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, system, modules, created_at FROM companies ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*domain.Company
	for rows.Next() {
		c, err := scanCompany(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ByID implements repository.CompanyRepository.
func (s *CompanyStore) ByID(ctx context.Context, id string) (*domain.Company, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id, name, system, modules, created_at FROM companies WHERE id = ?`, id)
	return scanCompany(row)
}

// Delete implements repository.CompanyRepository.
func (s *CompanyStore) Delete(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM companies WHERE id = ?`, id)
	return err
}

func (s *CompanyStore) getState(ctx context.Context, key string) (string, error) {
	var value string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM server_state WHERE key = ?`, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return value, err
}

func (s *CompanyStore) setState(ctx context.Context, key, value string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO server_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		key, value,
	)
	return err
}

// ActiveID implements repository.CompanyRepository.
func (s *CompanyStore) ActiveID(ctx context.Context) (string, error) {
	return s.getState(ctx, stateActiveCompanyKey)
}

// SetActiveID implements repository.CompanyRepository.
func (s *CompanyStore) SetActiveID(ctx context.Context, id string) error {
	return s.setState(ctx, stateActiveCompanyKey, id)
}

// LegacyID implements repository.CompanyRepository.
func (s *CompanyStore) LegacyID(ctx context.Context) (string, error) {
	return s.getState(ctx, stateLegacyCompanyKey)
}

// SetLegacyID implements repository.CompanyRepository.
func (s *CompanyStore) SetLegacyID(ctx context.Context, id string) error {
	return s.setState(ctx, stateLegacyCompanyKey, id)
}
