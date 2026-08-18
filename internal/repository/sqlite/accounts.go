package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"beacon-table/internal/domain"
)

// AccountStore реализует repository.AccountRepository.
type AccountStore struct {
	db *sql.DB
}

// NewAccountStore строит репозиторий аккаунтов поверх db, открытого Open.
func NewAccountStore(db *sql.DB) *AccountStore {
	return &AccountStore{db: db}
}

func scanAccount(row interface{ Scan(...any) error }) (*domain.Account, error) {
	var a domain.Account
	var mustChange int
	var createdAt string
	if err := row.Scan(&a.ID, &a.Username, &a.PasswordHash, &a.Role, &a.Status, &mustChange, &a.CompanyID, &createdAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, domain.ErrNotFound
		}
		return nil, err
	}
	a.MustChangePassword = mustChange != 0
	a.CreatedAt, _ = time.Parse(timeLayout, createdAt)
	return &a, nil
}

// Create implements repository.AccountRepository.
func (s *AccountStore) Create(ctx context.Context, a *domain.Account) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO accounts (id, username, password_hash, role, status, must_change_password, company_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		a.ID, a.Username, a.PasswordHash, a.Role, a.Status, boolToInt(a.MustChangePassword), a.CompanyID, time.Now().Format(timeLayout),
	)
	return err
}

// ByUsername implements repository.AccountRepository.
func (s *AccountStore) ByUsername(ctx context.Context, username string) (*domain.Account, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id, username, password_hash, role, status, must_change_password, company_id, created_at FROM accounts WHERE username = ?`, username)
	return scanAccount(row)
}

// ByID implements repository.AccountRepository.
func (s *AccountStore) ByID(ctx context.Context, id string) (*domain.Account, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id, username, password_hash, role, status, must_change_password, company_id, created_at FROM accounts WHERE id = ?`, id)
	return scanAccount(row)
}

// List implements repository.AccountRepository — все аккаунты вообще, вне
// зависимости от компании (используется только seed/миграцией и
// AdminService, который сам фильтрует по своей компании, см.
// internal/service/admin.go).
func (s *AccountStore) List(ctx context.Context) ([]*domain.Account, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, username, password_hash, role, status, must_change_password, company_id, created_at FROM accounts ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*domain.Account
	for rows.Next() {
		a, err := scanAccount(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// Delete implements repository.AccountRepository.
func (s *AccountStore) Delete(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM accounts WHERE id = ?`, id)
	return err
}

// Approve implements repository.AccountRepository.
func (s *AccountStore) Approve(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE accounts SET status = 'active' WHERE id = ?`, id)
	return err
}

// SetPassword implements repository.AccountRepository.
func (s *AccountStore) SetPassword(ctx context.Context, id, passwordHash string, mustChangePassword bool) error {
	_, err := s.db.ExecContext(ctx, `UPDATE accounts SET password_hash = ?, must_change_password = ? WHERE id = ?`, passwordHash, boolToInt(mustChangePassword), id)
	return err
}
