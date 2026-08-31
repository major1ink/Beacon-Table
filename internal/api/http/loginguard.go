package http

import (
	"math"
	"strconv"
	"sync"
	"time"
)

// Пороги подбора. «Пять попыток в минуту» из README: пятая неудача подряд в
// пределах окна запирает ключ (проверка идёт до записи, так что пятый запрос
// ещё получает свой 401), шестая и дальше — 429 с паузой, растущей с каждым
// новым срывом.
const (
	loginWindow   = time.Minute
	loginMaxFails = 5
	// loginBaseLock — пауза после первого срыва; каждый следующий удваивает
	// её вплоть до loginMaxLock.
	loginBaseLock = time.Minute
	loginMaxLock  = 15 * time.Minute
	// loginGuardTTL — через сколько тишины ключ забывается. Заведомо больше
	// loginMaxLock, чтобы уборка не сняла ещё действующую блокировку.
	loginGuardTTL = 30 * time.Minute
	// maxLoginGuardEntries — потолок таблицы. Под распределённым перебором
	// она росла бы по числу источников; сверх потолка вытесняется ключ,
	// дольше всех не появлявшийся.
	maxLoginGuardEntries = 4096
)

// loginGuard — защита входа и саморегистрации от перебора. Считает срывы в
// скользящем окне по независимым ключам:
//
//   - по IP — против одного источника, перебирающего пароли к разным
//     аккаунтам;
//   - по логину — против распределённого перебора (ботнет с многих адресов)
//     одного и того же аккаунта, в первую очередь «dm»;
//   - по IP с префиксом «reg:» — против набивания базы pending-аккаунтами
//     через /api/register.
//
// Только в памяти: перебор не переживает перезапуск сервера в осмысленном
// виде, а заводить таблицу ради счётчика, живущего минуты, незачем. Успешный
// вход обнуляет ключи — считаются срывы ПОДРЯД, а не за всю жизнь аккаунта.
type loginGuard struct {
	mu      sync.Mutex
	entries map[string]*loginAttempts
	// now подменяется в тестах, чтобы не ждать реальную минуту.
	now func() time.Time
}

type loginAttempts struct {
	failures    int
	windowStart time.Time
	// strikes — сколько раз ключ уже упирался в лимит; определяет паузу.
	strikes     int
	lockedUntil time.Time
	seen        time.Time
}

func newLoginGuard() *loginGuard {
	return &loginGuard{entries: map[string]*loginAttempts{}, now: time.Now}
}

// Методы безопасны на nil-приёмнике: это «ограничитель выключен». Так
// литерал API{} в тестах, не строящих guard через NewAPI, просто не считает
// попытки, вместо того чтобы падать.

// retryAfter — сколько ключу ещё ждать; 0 — можно пробовать.
func (g *loginGuard) retryAfter(key string) time.Duration {
	if g == nil {
		return 0
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	e := g.entries[key]
	if e == nil {
		return 0
	}
	if d := e.lockedUntil.Sub(g.now()); d > 0 {
		return d
	}
	return 0
}

// worst — наибольшая пауза среди ключей: блокировка по любому из них
// закрывает вход.
func (g *loginGuard) worst(keys ...string) time.Duration {
	var worst time.Duration
	for _, k := range keys {
		if d := g.retryAfter(k); d > worst {
			worst = d
		}
	}
	return worst
}

// record отмечает срыв по ключу (неудачный вход либо любая попытка
// регистрации).
func (g *loginGuard) record(key string) {
	if g == nil {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.now()

	e := g.entries[key]
	if e == nil {
		e = &loginAttempts{windowStart: now}
		g.entries[key] = e
	}
	e.seen = now
	if now.Sub(e.windowStart) > loginWindow {
		e.windowStart = now
		e.failures = 0
	}
	e.failures++
	if e.failures >= loginMaxFails {
		e.strikes++
		lock := loginBaseLock << (e.strikes - 1)
		if lock <= 0 || lock > loginMaxLock {
			lock = loginMaxLock
		}
		e.lockedUntil = now.Add(lock)
		// Окно начинаем заново: иначе разблокировка приходила бы с уже
		// исчерпанным счётчиком и первая же попытка снова упирала бы в лимит.
		e.windowStart = now
		e.failures = 0
	}

	// Уборка после вставки — чтобы новый ключ учитывался в потолке.
	g.sweep(now)
}

// clear забывает ключ — вызывается после успешного входа.
func (g *loginGuard) clear(key string) {
	if g == nil {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.entries, key)
}

// sweep убирает давно молчащие ключи и держит потолок таблицы. Вызывается
// под g.mu из record — единственного пути, где таблица растёт.
func (g *loginGuard) sweep(now time.Time) {
	for k, e := range g.entries {
		if now.Sub(e.seen) > loginGuardTTL {
			delete(g.entries, k)
		}
	}
	for len(g.entries) > maxLoginGuardEntries {
		var oldestKey string
		var oldest time.Time
		for k, e := range g.entries {
			if oldestKey == "" || e.seen.Before(oldest) {
				oldestKey, oldest = k, e.seen
			}
		}
		delete(g.entries, oldestKey)
	}
}

// retryAfterHeader — значение заголовка Retry-After (целые секунды, вверх).
func retryAfterHeader(d time.Duration) string {
	return strconv.Itoa(int(math.Ceil(d.Seconds())))
}
