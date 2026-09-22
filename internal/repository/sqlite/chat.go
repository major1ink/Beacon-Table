package sqlite

import (
	"context"
	"database/sql"

	"beacon-table/internal/domain"
)

// ChatStore реализует repository.ChatRepository для одного мира, как FoundryModuleStore.
type ChatStore struct {
	db        *sql.DB
	companyID string
}

func NewChatStore(db *sql.DB, companyID string) *ChatStore {
	return &ChatStore{db: db, companyID: companyID}
}

// List — по времени, при равном по id: порядок не плавает между перезапусками.
func (s *ChatStore) List(ctx context.Context) ([]*domain.ChatMessage, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, at, from_role, from_id, from_name, to_id, to_name, text FROM chat_messages
		WHERE company_id = ? ORDER BY at, id
	`, s.companyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*domain.ChatMessage{}
	for rows.Next() {
		var m domain.ChatMessage
		if err := rows.Scan(&m.ID, &m.At, &m.FromRole, &m.FromID, &m.FromName, &m.To, &m.ToName, &m.Text); err != nil {
			return nil, err
		}
		out = append(out, &m)
	}
	return out, rows.Err()
}

func (s *ChatStore) Add(ctx context.Context, m *domain.ChatMessage) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO chat_messages (id, company_id, at, from_role, from_id, from_name, to_id, to_name, text)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, m.ID, s.companyID, m.At, m.FromRole, m.FromID, m.FromName, m.To, m.ToName, m.Text)
	return err
}

func (s *ChatStore) Trim(ctx context.Context, keep int) error {
	if keep < 0 {
		keep = 0
	}
	_, err := s.db.ExecContext(ctx, `
		DELETE FROM chat_messages WHERE company_id = ? AND id NOT IN (
			SELECT id FROM chat_messages WHERE company_id = ? ORDER BY at DESC, id DESC LIMIT ?
		)
	`, s.companyID, s.companyID, keep)
	return err
}

func (s *ChatStore) Clear(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM chat_messages WHERE company_id = ?`, s.companyID)
	return err
}
