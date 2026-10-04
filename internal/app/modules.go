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

// SetWorldModules — какие модули подключены к миру, в порядке подключения;
// возвращает сохранённый список. Модуль системы мира остаётся всегда, второй
// системный модуль и контент чужой системы не включаются. Уже включённый, но
// пропавший с сервера модуль из списка молча не выкидывается — это решает ДМ.
func (m *CompanyManager) SetWorldModules(ctx context.Context, companyID string, ids []string) ([]string, error) {
	company, err := m.companies.ByID(ctx, companyID)
	if err != nil {
		return nil, err
	}
	current := company.EnabledModules()
	clean := make([]string, 0, len(ids)+1)
	if company.System != domain.SystemCustom && !slices.Contains(ids, company.System) {
		clean = append(clean, company.System)
	}
	for _, id := range ids {
		if slices.Contains(clean, id) {
			continue
		}
		mod, err := m.modules.Get(id)
		switch {
		case err != nil && !slices.Contains(current, id):
			return nil, &domain.ValidationError{Msg: fmt.Sprintf("модуль %q не установлен на сервере", id)}
		case err != nil, id == company.System:
		case mod.Manifest.Type == module.TypeSystem:
			return nil, &domain.ValidationError{Msg: fmt.Sprintf("«%s» — игровая система: её не включают, а выбирают системой мира", mod.Manifest.Title)}
		case !compatible(mod.Manifest, company.System):
			return nil, &domain.ValidationError{Msg: fmt.Sprintf("«%s» сделан для другой системы — в мире на «%s» его не включить", mod.Manifest.Title, m.systemTitle(company.System))}
		}
		clean = append(clean, id)
	}
	if err := m.companies.SetModules(ctx, companyID, clean); err != nil {
		return nil, err
	}
	return clean, m.relaunch(ctx, companyID)
}

// SetWorldSystem меняет систему мира и возвращает модули, которые пришлось
// выключить. Данные мира не трогаются: ключи прежней системы остаются в
// карточках и листах и снова покажутся при обратной смене. Модули прежней
// системы (у «Своей» — базовые состояния) уступают место модулям новой,
// контент чужой системы выключается.
func (m *CompanyManager) SetWorldSystem(ctx context.Context, companyID, system string) ([]string, error) {
	company, err := m.companies.ByID(ctx, companyID)
	if err != nil {
		return nil, err
	}
	if !m.systemInstalled(system) {
		return nil, &domain.ValidationError{Msg: "игровая система не установлена — поставь её модуль"}
	}
	if company.System == system {
		return []string{}, nil
	}
	old := defaultModules(company.System)
	modules := defaultModules(system)
	disabled := []string{}
	for _, id := range company.EnabledModules() {
		if slices.Contains(old, id) || slices.Contains(modules, id) {
			continue
		}
		if mod, err := m.modules.Get(id); err == nil && (mod.Manifest.Type == module.TypeSystem || !compatible(mod.Manifest, system)) {
			disabled = append(disabled, id)
			continue
		}
		modules = append(modules, id)
	}
	if err := m.companies.SetSystem(ctx, companyID, system, modules); err != nil {
		return nil, err
	}
	return disabled, m.relaunch(ctx, companyID)
}

// compatible — контент подходит миру на system: модуль без systems — любому.
func compatible(man *module.Manifest, system string) bool {
	return len(man.Systems) == 0 || slices.Contains(man.Systems, system)
}

func (m *CompanyManager) systemTitle(id string) string {
	for _, s := range m.Systems() {
		if s.ID == id {
			return s.Title
		}
	}
	return id
}

// WorldModules — включённые в мире модули (EnabledModules), для ответа API.
func (m *CompanyManager) WorldModules(ctx context.Context, companyID string) ([]string, error) {
	company, err := m.companies.ByID(ctx, companyID)
	if err != nil {
		return nil, err
	}
	return company.EnabledModules(), nil
}

// World — мир по id (для витрины: система и список модулей).
func (m *CompanyManager) World(ctx context.Context, companyID string) (*domain.Company, error) {
	return m.companies.ByID(ctx, companyID)
}

func (m *CompanyManager) relaunchIfUses(ctx context.Context, moduleID string) error {
	w := m.Current()
	if w == nil || !slices.Contains(w.Company.EnabledModules(), moduleID) {
		return nil
	}
	return m.relaunch(ctx, w.Company.ID)
}

// relaunch перезапускает мир, если он на столе: страницы получают
// world_reload и перечитывают модули и схемы.
func (m *CompanyManager) relaunch(ctx context.Context, companyID string) error {
	w := m.Current()
	if w == nil || w.Company.ID != companyID {
		return nil
	}
	w.Room.ShutdownForReload()
	return m.Launch(ctx, companyID)
}
