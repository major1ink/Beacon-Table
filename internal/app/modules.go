package app

import (
	"context"
	"fmt"
	"slices"

	"beacon-table/internal/domain"
	"beacon-table/internal/module"
)

// Модули контента глазами менеджера миров: установка и удаление — на весь
// сервер (реестр), включение — в конкретном мире. Всё, что меняет состав
// карточек ЗАПУЩЕННОГО мира, перезапускает его: каталоги собираются при
// запуске (см. Launch), и иначе стол увидел бы изменения только после
// следующего переключения мира.

// InstallModule ставит или обновляет модуль из архива .btmod.
func (m *CompanyManager) InstallModule(ctx context.Context, archive string) (*module.Module, error) {
	mod, err := m.modules.Install(archive)
	if err != nil {
		return nil, err
	}
	return mod, m.relaunchIfUses(ctx, mod.Manifest.ID)
}

// RemoveModule удаляет установленный модуль с сервера. Миры, где он был
// включён, продолжают его «помнить» и покажут как ненайденный — вернуть
// можно, поставив модуль снова.
func (m *CompanyManager) RemoveModule(ctx context.Context, id string) error {
	if err := m.modules.Remove(id); err != nil {
		return err
	}
	return m.relaunchIfUses(ctx, id)
}

// SetWorldModules — какие модули подключены к миру, в порядке подключения.
// Включить можно только модуль, который есть на сервере; уже включённый, но
// пропавший с сервера, из списка не выкидывается молча — это решает ДМ.
func (m *CompanyManager) SetWorldModules(ctx context.Context, companyID string, ids []string) error {
	company, err := m.companies.ByID(ctx, companyID)
	if err != nil {
		return err
	}
	current := company.EnabledModules()
	clean := make([]string, 0, len(ids))
	for _, id := range ids {
		if slices.Contains(clean, id) {
			continue
		}
		if _, err := m.modules.Get(id); err != nil && !slices.Contains(current, id) {
			return &domain.ValidationError{Msg: fmt.Sprintf("модуль %q не установлен на сервере", id)}
		}
		clean = append(clean, id)
	}
	if err := m.companies.SetModules(ctx, companyID, clean); err != nil {
		return err
	}
	if m.ActiveCompanyID() == companyID {
		return m.Launch(ctx, companyID)
	}
	return nil
}

// WorldModules — включённые в мире модули (EnabledModules), для ответа API.
func (m *CompanyManager) WorldModules(ctx context.Context, companyID string) ([]string, error) {
	company, err := m.companies.ByID(ctx, companyID)
	if err != nil {
		return nil, err
	}
	return company.EnabledModules(), nil
}

func (m *CompanyManager) relaunchIfUses(ctx context.Context, moduleID string) error {
	w := m.Current()
	if w == nil || !slices.Contains(w.Company.EnabledModules(), moduleID) {
		return nil
	}
	return m.Launch(ctx, w.Company.ID)
}
