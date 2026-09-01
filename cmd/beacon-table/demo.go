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
	// warnBefore — та же demoResetWarnBefore, полем, а не константой напрямую
	// в Run: тесты в этом же пакете держат её короче (guests_test.go делает
	// то же самое с GuestKeeper.idle), не дожидаясь настоящих минут.
	warnBefore time.Duration
}

func newDemoResetter(companies *app.CompanyManager, accounts repository.AccountRepository, worldZip string, interval time.Duration) *demoResetter {
	return &demoResetter{
		companies: companies, accounts: accounts, worldZip: worldZip, interval: interval,
		warnBefore: demoResetWarnBefore,
	}
}

// demoResetWarnBefore — за сколько до сброса предупредить тех, кто сейчас
// за столом (см. Announce ниже). Раньше сброс просто обрывал партию без
// единого слова — с точки зрения игрока это выглядело как обрыв связи,
// неотличимый от настоящего сбоя сети. Не настройка — как и у guestIdle
// (см. internal/app/guests.go), это цифра, которую владелец демо решает
// один раз, а не то, что нужно объяснять в конфиге каждому.
const demoResetWarnBefore = 2 * time.Minute

// Run предупреждает и сбрасывает стол по расписанию, пока не отменят ctx.
//
// Таймеры, а не один Ticker на d.interval: предупреждение и сам сброс —
// две разные точки одного и того же цикла (за d.warnBefore до конца и в
// конце), и только последовательные NewTimer держат их в фазе друг с
// другом без независимого дрейфа, которым страдали бы два параллельных
// Ticker с разными периодами.
func (d *demoResetter) Run(ctx context.Context) {
	for {
		if !sleepCtx(ctx, d.interval-d.warnBefore) {
			return
		}
		d.warn()

		if !sleepCtx(ctx, d.warnBefore) {
			return
		}
		if err := d.Reset(ctx); err != nil {
			if ctx.Err() != nil {
				return // остановка сервера
			}
			slog.Error("не удалось сбросить демо-стол", "err", err)
		}
	}
}

// sleepCtx ждёт d или отмену ctx — false, если проснулись из-за неё
// (вызывающему остаётся сразу выйти, не начиная следующий шаг).
// Неположительный d (интервал короче warnBefore, обычно только в тестах с
// укороченным расписанием) таймер не пугает — сработает почти сразу, просто
// без реальной паузы.
func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// warn — предупреждение всем сидящим за столом. Мимо стола предупреждать
// некого: между сбросами мир всегда запущен (Reset поднимает следующий
// раньше, чем сносит прежний), но защищаемся на случай гонки с остановкой
// сервера — тогда Current() на мгновение отдаёт nil.
func (d *demoResetter) warn() {
	world := d.companies.Current()
	if world == nil {
		return
	}
	world.Room.Announce(fmt.Sprintf(
		"Демо-стол сбросится к исходному состоянию через %d мин — если что-то важное, доиграйте или сохраните сейчас.",
		int(d.warnBefore.Minutes()),
	))
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
