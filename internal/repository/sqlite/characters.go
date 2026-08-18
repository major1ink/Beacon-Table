package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"beacon-table/internal/domain"
)

// CharacterStore реализует repository.CharacterRepository, привязанный к
// одной компании (миру) — companyID/system проставляются в конструкторе и
// сервер сам штампует их на Create/сканирует на чтении, вызывающий код
// (service.CharacterService) их не передаёт. Пересобирается заново на каждый
// service.CompanyManager.Launch — переключение мира меняет ЭКЗЕМПЛЯР стора,
// а не параметр отдельных вызовов, поэтому один персонаж физически не может
// утечь в чужой мир ни при каком запросе через этот стор.
type CharacterStore struct {
	db        *sql.DB
	companyID string
	system    string
}

// NewCharacterStore строит репозиторий персонажей поверх db, открытого
// Open, для компании companyID с системой system (см. domain.Company).
func NewCharacterStore(db *sql.DB, companyID, system string) *CharacterStore {
	return &CharacterStore{db: db, companyID: companyID, system: system}
}

// decodeSheet — пустая строка (старые строки до sheet_json) или битый JSON
// не должны валить чтение персонажа: откатываемся на пустой лист. Разбираем
// ПОВЕРХ DefaultCharacterSheet(), а не в зеро-значение var sheet
// domain.CharacterSheet{} — json.Unmarshal трогает только поля, реально
// присутствующие в raw, остальные остаются как есть. Так неполный (но
// валидный) JSON вроде "{}" — легаси-строки до появления
// DefaultCharacterSheet(), см. git-историю — тоже откатывается на
// характеристики по 10 (модификатор +0), а не на Go zero-value (Str/Dex/…=0,
// модификатор -5 — именно так дважды свалилась инициатива в трекере: 1d20-5
// для персонажа с пустым листом, у которого Ловкость фактически 0, хотя
// "±0 по умолчанию" ожидался бы любым, кто ни разу не открывал лист).
//
// Формат sheet_json один и тот же для обеих систем (D&D 5e 2014/2024) —
// см. domain.CharacterSheet: поля Race/PersonalityTraits/Ideals/Bonds/Flaws
// (2014) и Species/Background (2024) просто сосуществуют в одной структуре,
// декодировать по-разному в зависимости от Character.System не нужно.
func decodeSheet(raw string) domain.CharacterSheet {
	if raw == "" {
		return domain.DefaultCharacterSheet()
	}
	sheet := domain.DefaultCharacterSheet()
	if err := json.Unmarshal([]byte(raw), &sheet); err != nil {
		return domain.DefaultCharacterSheet()
	}
	return sheet
}

func scanCharacter(row interface{ Scan(...any) error }) (*domain.Character, error) {
	var c domain.Character
	var createdAt, sheetJSON string
	if err := row.Scan(&c.ID, &c.AccountID, &c.CompanyID, &c.System, &c.Name, &c.AvatarURL, &sheetJSON, &createdAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, domain.ErrNotFound
		}
		return nil, err
	}
	c.CreatedAt, _ = time.Parse(timeLayout, createdAt)
	c.Sheet = decodeSheet(sheetJSON)
	return &c, nil
}

const characterColumns = `id, account_id, company_id, system, name, avatar_url, sheet_json, created_at`

// Create implements repository.CharacterRepository. c.Sheet — то, что
// проставил вызывающий (service.CharacterService.Create всегда кладёт
// domain.DefaultCharacterSheet()); хранилище само дефолты не подставляет.
// company_id/system хранилище ставит САМО из своих полей — не из c
// (см. комментарий типа CharacterStore выше), так что вызывающему
// невозможно нечаянно создать персонажа в чужой компании.
func (s *CharacterStore) Create(ctx context.Context, c *domain.Character) error {
	sheetJSON, err := json.Marshal(c.Sheet)
	if err != nil {
		return err
	}
	c.CompanyID = s.companyID
	c.System = s.system
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO characters (id, account_id, company_id, system, name, avatar_url, sheet_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		c.ID, c.AccountID, c.CompanyID, c.System, c.Name, c.AvatarURL, string(sheetJSON), time.Now().Format(timeLayout),
	)
	return err
}

// ByID implements repository.CharacterRepository.
func (s *CharacterStore) ByID(ctx context.Context, id string) (*domain.Character, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+characterColumns+` FROM characters WHERE id = ? AND company_id = ?`, id, s.companyID)
	return scanCharacter(row)
}

// ByAccount implements repository.CharacterRepository.
func (s *CharacterStore) ByAccount(ctx context.Context, accountID string) ([]*domain.Character, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+characterColumns+` FROM characters WHERE account_id = ? AND company_id = ? ORDER BY created_at`, accountID, s.companyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*domain.Character
	for rows.Next() {
		c, err := scanCharacter(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// All implements repository.CharacterRepository — все персонажи ЭТОЙ
// компании (не всего сервера, см. тип CharacterStore выше).
func (s *CharacterStore) All(ctx context.Context) ([]*domain.Character, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+characterColumns+` FROM characters WHERE company_id = ? ORDER BY account_id, created_at`, s.companyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*domain.Character
	for rows.Next() {
		c, err := scanCharacter(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// Update implements repository.CharacterRepository.
func (s *CharacterStore) Update(ctx context.Context, id, accountID, name, avatarURL string) (bool, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE characters SET name = ?, avatar_url = ? WHERE id = ? AND account_id = ? AND company_id = ?`, name, avatarURL, id, accountID, s.companyID)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// UpdateSheet implements repository.CharacterRepository — перезаписывает
// только лист персонажа, не трогая имя/аватар (те правит отдельная форма
// в player.html через Update).
func (s *CharacterStore) UpdateSheet(ctx context.Context, id, accountID string, sheet domain.CharacterSheet) (bool, error) {
	sheetJSON, err := json.Marshal(sheet)
	if err != nil {
		return false, err
	}
	res, err := s.db.ExecContext(ctx, `UPDATE characters SET sheet_json = ? WHERE id = ? AND account_id = ? AND company_id = ?`, string(sheetJSON), id, accountID, s.companyID)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// Delete implements repository.CharacterRepository.
func (s *CharacterStore) Delete(ctx context.Context, id, accountID string) (bool, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM characters WHERE id = ? AND account_id = ? AND company_id = ?`, id, accountID, s.companyID)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}
