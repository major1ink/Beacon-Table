package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"beacon-table/internal/domain"
)

// SessionStore реализует repository.SessionRepository. Резолвит cookie в
// аккаунт через тот же db, что и AccountStore (см. AccountByToken).
type SessionStore struct {
	db       *sql.DB
	accounts *AccountStore
}

// NewSessionStore строит репозиторий сессий поверх db, открытого Open.
// accounts нужен, чтобы AccountByToken мог сразу отдать полный domain.Account,
// а не только его ID.
func NewSessionStore(db *sql.DB, accounts *AccountStore) *SessionStore {
	return &SessionStore{db: db, accounts: accounts}
}

// Create implements repository.SessionRepository.
func (s *SessionStore) Create(ctx context.Context, token, accountID string) error {
	now := time.Now()
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
		token, accountID, now.Format(timeLayout), now.Add(domain.SessionTTL).Format(timeLayout),
	)
	return err
}

// AccountByToken implements repository.SessionRepository. Резолвит cookie в
// аккаунт, попутно подчищая просроченную строку сессии, если наткнулись на
// неё (лениво, без фонового таймера).
func (s *SessionStore) AccountByToken(ctx context.Context, token string) (*domain.Account, error) {
	var accountID, expiresAt string
	err := s.db.QueryRowContext(ctx, `SELECT account_id, expires_at FROM sessions WHERE token = ?`, token).Scan(&accountID, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, domain.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if exp, perr := time.Parse(timeLayout, expiresAt); perr == nil && time.Now().After(exp) {
		_ = s.Delete(ctx, token)
		return nil, domain.ErrNotFound
	}
	return s.accounts.ByID(ctx, accountID)
}

// Delete implements repository.SessionRepository.
func (s *SessionStore) Delete(ctx context.Context, token string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE token = ?`, token)
	return err
}

// DeleteForAccount implements repository.SessionRepository.
func (s *SessionStore) DeleteForAccount(ctx context.Context, accountID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE account_id = ?`, accountID)
	return err
}
