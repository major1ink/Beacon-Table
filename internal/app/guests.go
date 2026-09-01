package app

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository"
)

// GuestKeeper убирает за гостями публичного демо: аккаунт, заведённый одним
// нажатием кнопки (см. api/http.handleDemoGuest), должен так же сам собой и
// исчезнуть, когда человек ушёл.
//
// Без этого демо живёт ровно до предела maxDemoGuests: гость никуда не
// девается ни при выходе, ни по протуханию сессии (domain.SessionTTL — три
// месяца), так что счётчик упирается в потолок после десяти ЛЮБЫХ посещений
// и следующему гостю сервер отвечает «слишком много гостей» — хотя за столом
// давно никого. Сброс мира по расписанию (см. cmd/beacon-table/demo.go) чинил
// это раз в несколько часов, а до сброса витрина стояла закрытой.
//
// Есть два повода убрать гостя, и второй — только страховка первому:
//
//   - человек нажал «Выйти» — Release зовут прямо из хендлера выхода, стол
//     освобождается в ту же секунду;
//   - человек просто закрыл вкладку (так уходит большинство) — тогда его
//     уносит Sweep, когда с последней активности прошло guestIdle.
//
// Живые аккаунты (ДМ сервера, обычные игроки) уборщик не трогает вовсе —
// смотрит только на domain.Account.IsDemo.
type GuestKeeper struct {
	worlds   worldSource
	accounts repository.AccountRepository

	// idle — сколько тишины считать уходом (guestIdle, в тестах короче).
	idle time.Duration

	mu   sync.Mutex
	seen map[string]time.Time // id гостя → когда его видели в последний раз
	// online — сколько сейчас открытых WS-подключений у гостя. Пока их хоть
	// одно, он за столом, даже если не сделал ни одного HTTP-запроса: сидеть
	// и смотреть, как ДМ водит, — это тоже присутствие, а не бездействие.
	online map[string]int
}

// worldSource — откуда брать сейчас запущенный мир. В бою это
// *CompanyManager; интерфейс — чтобы тесты уборщика не поднимали базу,
// файлы сцен и все сервисы мира ради одной проверки «убрали ли гостя».
type worldSource interface {
	Current() *ActiveWorld
}

// guestIdle — сколько молчания считать уходом. Двадцать минут: достаточно,
// чтобы отойти за чаем посреди осмотра карты, и достаточно мало, чтобы
// закрытая вкладка не держала место в очереди полдня.
//
// Не настройка: цифру такого рода владелец демо крутит один раз в жизни, а
// каждый BEACON_* — ещё одна строка, которую читает КАЖДЫЙ, кто ставит стол
// себе (см. cmd/beacon-table/configfile.go).
const guestIdle = 20 * time.Minute

// guestSweepEvery — как часто заглядывать. Минуты хватает: точность здесь
// никому не нужна, а обход — это один List аккаунтов.
const guestSweepEvery = time.Minute

// NewGuestKeeper собирает уборщика. Возвращаемый *GuestKeeper безопасно
// держать nil'ом: Touch/Online на нём — пустышки, так что обычная (не
// демонстрационная) установка просто передаёт nil и ничего не платит.
func NewGuestKeeper(companies *CompanyManager, accounts repository.AccountRepository) *GuestKeeper {
	// Пустой интерфейс, а не обёрнутый nil-указатель: Release проверяет
	// именно worlds == nil (уборщик без менеджера миров собирают тесты
	// транспорта), а типизированный nil эту проверку прошёл бы и упал уже
	// внутри Current().
	var worlds worldSource
	if companies != nil {
		worlds = companies
	}
	return &GuestKeeper{
		worlds:   worlds,
		accounts: accounts,
		idle:     guestIdle,
		seen:     map[string]time.Time{},
		online:   map[string]int{},
	}
}

// Touch — гость только что о себе напомнил (любой запрос с его сессией, см.
// api/http.API.sessionAccount).
func (g *GuestKeeper) Touch(accountID string) {
	if g == nil || accountID == "" {
		return
	}
	g.mu.Lock()
	g.seen[accountID] = time.Now()
	g.mu.Unlock()
}

// Online отмечает открытое WS-подключение гостя и возвращает функцию, которую
// нужно позвать при его закрытии (обычно через defer, см. api/ws).
func (g *GuestKeeper) Online(accountID string) func() {
	if g == nil || accountID == "" {
		return func() {}
	}
	g.mu.Lock()
	g.online[accountID]++
	g.seen[accountID] = time.Now()
	g.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			g.mu.Lock()
			if n := g.online[accountID] - 1; n > 0 {
				g.online[accountID] = n
			} else {
				delete(g.online, accountID)
			}
			// Отсчёт бездействия начинается с ОТКЛЮЧЕНИЯ, а не с последнего
			// запроса: иначе гость, просидевший за столом час молча, был бы
			// убран в ту же минуту, как закрыл вкладку.
			g.seen[accountID] = time.Now()
			g.mu.Unlock()
		})
	}
}

// Release убирает гостя целиком и немедленно — так уходит тот, кто нажал
// «Выйти». Не-гостя не трогает: перепутать роль здесь означало бы стереть
// живой аккаунт, поэтому проверка стоит внутри, а не в вызывающем.
//
// Порядок важен только в одном месте: фишки убираются, пока комната ещё
// знает про этого владельца, а всё остальное уходит каскадом за аккаунтом
// (сессии, персонажи, инвентарь — см. схему в repository/sqlite/migrations.go).
func (g *GuestKeeper) Release(ctx context.Context, acc *domain.Account) error {
	if g == nil || acc == nil || !acc.IsDemo() {
		return nil
	}
	// Промахи здесь не отменяют ухода: место в очереди освобождает удаление
	// аккаунта ниже, а забытая на карте фишка — досадно, но не повод оставить
	// гостя висеть. Нечего убирать и когда мира нет вовсе: между сбросами
	// демо-стола (см. cmd/beacon-table/demo.go) он на секунду не запущен.
	if g.worlds != nil {
		if world := g.worlds.Current(); world != nil {
			if _, err := world.Room.RemoveOwnerTokens(ctx, acc.ID); err != nil {
				slog.Warn("фишку ушедшего гостя убрать не удалось", "гость", acc.Username, "err", err)
			}
			// Заготовка «готового персонажа», которую гость взял на входе,
			// должна вернуться в пул — FK у pregen_characters нет, каскадом
			// она не освободится (тот же отдельный вызов, что в
			// api/http.handleAdminAccountDelete).
			if err := world.Pregens.FreeByAccount(ctx, acc.ID); err != nil {
				slog.Warn("заготовку персонажа вернуть в пул не удалось", "гость", acc.Username, "err", err)
			}
		}
	}
	if err := g.accounts.Delete(ctx, acc.ID); err != nil {
		return err
	}
	g.forget(acc.ID)
	return nil
}

func (g *GuestKeeper) forget(accountID string) {
	g.mu.Lock()
	delete(g.seen, accountID)
	delete(g.online, accountID)
	g.mu.Unlock()
}

// Sweep убирает гостей, замолчавших дольше idle. Возвращает, скольких убрал.
func (g *GuestKeeper) Sweep(ctx context.Context) int {
	if g == nil {
		return 0
	}
	all, err := g.accounts.List(ctx)
	if err != nil {
		slog.Warn("не удалось перебрать аккаунты для уборки гостей", "err", err)
		return 0
	}
	now := time.Now()
	removed := 0
	alive := map[string]bool{}
	for _, acc := range all {
		if !acc.IsDemo() {
			continue
		}
		alive[acc.ID] = true
		if !g.idleSince(acc.ID, now) {
			continue
		}
		if err := g.Release(ctx, acc); err != nil {
			slog.Warn("не удалось убрать гостя по бездействию", "гость", acc.Username, "err", err)
			continue
		}
		removed++
		slog.Info("гость убран по бездействию", "гость", acc.Username)
	}
	g.dropStrangers(alive)
	return removed
}

// idleSince — молчит ли гость дольше положенного.
//
// Гость, о котором мы ещё ничего не знаем (сервер перезапустился и растерял
// отметки), не убирается сразу: ему заводится отметка «видели сейчас» и
// даётся тот же idle, что и всем. Иначе первый же обход после рестарта
// выкинул бы из-за стола всех, кто на нём в этот момент сидит.
func (g *GuestKeeper) idleSince(accountID string, now time.Time) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.online[accountID] > 0 {
		return false
	}
	last, ok := g.seen[accountID]
	if !ok {
		g.seen[accountID] = now
		return false
	}
	return now.Sub(last) >= g.idle
}

// dropStrangers выкидывает из таблицы отметки тех, кого среди гостей больше
// нет: аккаунт мог уйти мимо уборщика (сброс демо-стола, удаление ДМ), а
// таблица иначе росла бы на каждого прошедшего.
func (g *GuestKeeper) dropStrangers(alive map[string]bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for id := range g.seen {
		if !alive[id] {
			delete(g.seen, id)
			delete(g.online, id)
		}
	}
}

// Run убирает по расписанию, пока не отменят ctx.
func (g *GuestKeeper) Run(ctx context.Context) {
	if g == nil {
		return
	}
	t := time.NewTicker(guestSweepEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			g.Sweep(ctx)
		}
	}
}
