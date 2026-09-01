package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"time"

	"beacon-table/internal/app"
	"beacon-table/internal/domain"
	"beacon-table/internal/repository"
)

// demoResetter возвращает публичный стол к эталонному состоянию: посетители
// за ним хозяйничают как ДМ, и без сброса демо за день превращается в свалку
// из чужих карт, стёртых стен и переименованных сцен. Заодно уходят фишки
// гостей-игроков, которые сервер расставляет им при входе (см.
// service.Room.SpawnPlayerToken) — сами по себе они с карты не убираются.
//
// Сброс сделан через тот же экспорт-импорт мира, которым пользуется человек
// (см. app.CompanyManager.ImportWorld): эталон — обычный .beacon-world.zip,
// его можно подготовить прямо в приложении и заменить, не трогая код.
type demoResetter struct {
	companies *app.CompanyManager
	accounts  repository.AccountRepository
	worldZip  string
	interval  time.Duration
}

func newDemoResetter(companies *app.CompanyManager, accounts repository.AccountRepository, worldZip string, interval time.Duration) *demoResetter {
	return &demoResetter{companies: companies, accounts: accounts, worldZip: worldZip, interval: interval}
}

// Run сбрасывает стол по расписанию, пока не отменят ctx.
func (d *demoResetter) Run(ctx context.Context) {
	t := time.NewTicker(d.interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := d.Reset(ctx); err != nil {
				if ctx.Err() != nil {
					return // остановка сервера
				}
				slog.Error("не удалось сбросить демо-стол", "err", err)
			}
		}
	}
}

// Reset поднимает свежий стол из эталона и убирает старый вместе с гостями.
//
// Порядок именно такой: сначала новый мир, потом снос старого. Наоборот
// демо на минуту-другую осталось бы вовсе без стола, и зашедший в этот
// момент посетитель увидел бы пустоту вместо витрины.
func (d *demoResetter) Reset(ctx context.Context) error {
	//nolint:gosec // G703: путь к эталону задаёт владелец сервера через
	// конфигурацию (BEACON_DEMO_WORLD), а не посетитель по сети.
	if _, err := os.Stat(d.worldZip); err != nil {
		return fmt.Errorf("эталон демо-мира: %w", err)
	}
	previous := d.companies.ActiveCompanyID()

	res, err := d.companies.ImportWorld(ctx, d.worldZip)
	if err != nil {
		return fmt.Errorf("импорт эталона: %w", err)
	}
	if err := d.companies.Launch(ctx, res.Company.ID); err != nil {
		return fmt.Errorf("запуск свежего демо-стола: %w", err)
	}

	if previous != "" && previous != res.Company.ID {
		// force: вместе с миром уходят и гостевые аккаунты, заведённые в
		// нём, — отдельно подчищать их не нужно.
		if err := d.companies.Delete(ctx, previous, true); err != nil && !errors.Is(err, domain.ErrNotFound) {
			slog.Warn("прежний демо-стол удалить не удалось", "err", err)
		}
	}
	slog.Info("демо-стол сброшен к эталону", "мир", res.Company.Name)
	return nil
}
