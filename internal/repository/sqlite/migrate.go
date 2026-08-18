package sqlite

import (
	"context"
	"database/sql"

	"beacon-table/internal/domain"
)

// MigrateLegacyCompany — миграция инсталляции, созданной ДО появления
// миров/компаний (см. service.CompanyManager.Bootstrap): все существующие
// аккаунты-игроки/персонажи/плейлисты, у которых ещё пустой company_id,
// "усыновляются" единственной, только что созданной для этого legacy-
// компанией. Одноразовая операция при самом первом старте с этой версией —
// не часть постоянного business-flow сервиса, поэтому не заведена как метод
// в repository.*Repository интерфейсах, а лежит здесь голым SQL.
func MigrateLegacyCompany(ctx context.Context, db *sql.DB, companyID, system string) error {
	stmts := []struct {
		query string
		args  []any
	}{
		// Единственный admin-аккаунт ("dm") к компании не привязывается —
		// он управляет всеми мирами, а не принадлежит одному (см.
		// domain.Account.CompanyID).
		{`UPDATE accounts SET company_id = ? WHERE company_id = '' AND role != ?`, []any{companyID, domain.AccountRoleAdmin}},
		{`UPDATE characters SET company_id = ?, system = ? WHERE company_id = ''`, []any{companyID, system}},
		{`UPDATE playlists SET company_id = ? WHERE company_id = ''`, []any{companyID}},
	}
	for _, s := range stmts {
		if _, err := db.ExecContext(ctx, s.query, s.args...); err != nil {
			return err
		}
	}
	return nil
}
