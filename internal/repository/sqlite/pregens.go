package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"beacon-table/internal/domain"
)

// PregenStore реализует repository.PregenRepository, привязанный к одной
// компании (миру) — companyID проставляется в конструкторе и штампуется
// сервером на запись/фильтруется на чтении, вызывающий код его не передаёт.
// Пересобирается на каждый service.CompanyManager.Launch, как и
// CharacterStore (см. комментарий там) — пул одного мира не может утечь в
// другой ни при каком запросе через этот стор.
type PregenStore struct {
	db        *sql.DB
	companyID string
}

// NewPregenStore строит репозиторий пула готовых персонажей поверх db для
// компании companyID.
func NewPregenStore(db *sql.DB, companyID string) *PregenStore {
	return &PregenStore{db: db, companyID: companyID}
}

const pregenColumns = `id, company_id, name, avatar_url, sheet_json, source, claimed_by, claimed_character_id, created_at`

func scanPregen(row interface{ Scan(...any) error }) (*domain.Pregen, error) {
	var p domain.Pregen
	var sheetJSON, createdAt string
	if err := row.Scan(&p.ID, &p.CompanyID, &p.Name, &p.AvatarURL, &sheetJSON, &p.Source, &p.ClaimedBy, &p.ClaimedCharacterID, &createdAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, domain.ErrNotFound
		}
		return nil, err
	}
	p.CreatedAt, _ = time.Parse(timeLayout, createdAt)
	// decodeSheet — тот же откат на пустой лист при битом/пустом JSON, что и
	// у персонажей (см. characters.go).
	p.Sheet = decodeSheet(sheetJSON)
	return &p, nil
}

func (s *PregenStore) queryList(ctx context.Context, where string, args ...any) ([]*domain.Pregen, error) {
	q := `SELECT ` + pregenColumns + ` FROM pregen_characters WHERE company_id = ?` + where + ` ORDER BY created_at`
	rows, err := s.db.QueryContext(ctx, q, append([]any{s.companyID}, args...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*domain.Pregen
	for rows.Next() {
		p, err := scanPregen(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// List — весь пул мира (для ДМ).
func (s *PregenStore) List(ctx context.Context) ([]*domain.Pregen, error) {
	return s.queryList(ctx, "")
}

// Available — только свободные пре-гены (для игрока).
func (s *PregenStore) Available(ctx context.Context) ([]*domain.Pregen, error) {
	return s.queryList(ctx, ` AND claimed_by = ''`)
}

// ByID — один пре-ген; domain.ErrNotFound, если такого в этом мире нет.
func (s *PregenStore) ByID(ctx context.Context, id string) (*domain.Pregen, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+pregenColumns+` FROM pregen_characters WHERE id = ? AND company_id = ?`, id, s.companyID)
	return scanPregen(row)
}

// Create — company_id стор ставит сам из своего поля.
func (s *PregenStore) Create(ctx context.Context, p *domain.Pregen) error {
	sheetJSON, err := json.Marshal(p.Sheet)
	if err != nil {
		return err
	}
	p.CompanyID = s.companyID
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO pregen_characters (`+pregenColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		p.ID, p.CompanyID, p.Name, p.AvatarURL, string(sheetJSON), p.Source, p.ClaimedBy, p.ClaimedCharacterID, time.Now().Format(timeLayout),
	)
	return err
}

// Update перезаписывает имя/аватар/лист/метку модуля (используется импортом).
// Занятость (claimed_*) не трогает.
func (s *PregenStore) Update(ctx context.Context, id, name, avatarURL, source string, sheet domain.CharacterSheet) (bool, error) {
	sheetJSON, err := json.Marshal(sheet)
	if err != nil {
		return false, err
	}
	res, err := s.db.ExecContext(ctx,
		`UPDATE pregen_characters SET name = ?, avatar_url = ?, sheet_json = ?, source = ? WHERE id = ? AND company_id = ?`,
		name, avatarURL, string(sheetJSON), source, id, s.companyID,
	)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// SetClaim помечает пре-гена занятым: только если он ещё свободен ИЛИ уже
// занят этим же аккаунтом (идемпотентный повторный захват). Возвращает false,
// если пре-ген занят кем-то другим (или его нет).
func (s *PregenStore) SetClaim(ctx context.Context, id, accountID, characterID string) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE pregen_characters SET claimed_by = ?, claimed_character_id = ?
		 WHERE id = ? AND company_id = ? AND (claimed_by = '' OR claimed_by = ?)`,
		accountID, characterID, id, s.companyID, accountID,
	)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// ClearClaim снимает пометку занятости — пре-ген снова свободен в пуле.
// Созданную при захвате запись characters НЕ трогает.
func (s *PregenStore) ClearClaim(ctx context.Context, id string) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE pregen_characters SET claimed_by = '', claimed_character_id = '' WHERE id = ? AND company_id = ?`,
		id, s.companyID,
	)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// Delete убирает пре-гена из пула. Персонажа игрока (если пре-ген был занят)
// не трогает.
func (s *PregenStore) Delete(ctx context.Context, id string) (bool, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM pregen_characters WHERE id = ? AND company_id = ?`, id, s.companyID)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// FreeByAccount освобождает все пре-гены, занятые удаляемым аккаунтом (его
// персонажи уходят каскадом по FK characters, а пул-записи FK не имеют).
func (s *PregenStore) FreeByAccount(ctx context.Context, accountID string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE pregen_characters SET claimed_by = '', claimed_character_id = '' WHERE claimed_by = ? AND company_id = ?`,
		accountID, s.companyID,
	)
	return err
}

// DeleteBySource сносит пул-записи, приехавшие импортом модуля moduleID
// (см. FoundryService.Delete). Возвращает число удалённых.
func (s *PregenStore) DeleteBySource(ctx context.Context, moduleID string) (int, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM pregen_characters WHERE source = ? AND company_id = ?`, moduleID, s.companyID)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	return int(n), err
}
