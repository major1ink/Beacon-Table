package http

import (
	"testing"
	"time"
)

// clock — управляемое время для guard: тесты не должны ждать реальную минуту.
type clock struct{ t time.Time }

func (c *clock) now() time.Time      { return c.t }
func (c *clock) add(d time.Duration) { c.t = c.t.Add(d) }

// testStart — общая точка отсчёта для управляемых часов guard.
var testStart = time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)

func testGuard() (*loginGuard, *clock) {
	c := &clock{t: testStart}
	g := newLoginGuard()
	g.now = c.now
	return g, c
}

// TestLoginGuardAllowsUpToLimit — несколько срывов подряд ещё не запирают
// ключ: человек, дважды опечатавшийся в пароле, не должен упереться в стену.
func TestLoginGuardAllowsUpToLimit(t *testing.T) {
	g, _ := testGuard()
	for i := 0; i < loginMaxFails-1; i++ {
		g.record("ip:198.51.100.7")
	}
	if d := g.retryAfter("ip:198.51.100.7"); d != 0 {
		t.Fatalf("ключ заперт после %d срывов, пауза %s — лимит %d", loginMaxFails-1, d, loginMaxFails)
	}
}

// TestLoginGuardLocksAfterLimit — пятый срыв в окне закрывает вход с паузой.
func TestLoginGuardLocksAfterLimit(t *testing.T) {
	g, c := testGuard()
	for i := 0; i < loginMaxFails; i++ {
		g.record("ip:198.51.100.7")
	}
	d := g.retryAfter("ip:198.51.100.7")
	if d <= 0 || d > loginBaseLock {
		t.Fatalf("пауза после первого срыва %s, ожидалась около %s", d, loginBaseLock)
	}
	// Пауза истекла — снова можно.
	c.add(loginBaseLock + time.Second)
	if d := g.retryAfter("ip:198.51.100.7"); d != 0 {
		t.Fatalf("ключ всё ещё заперт спустя %s, пауза %s", loginBaseLock, d)
	}
}

// TestLoginGuardEscalates — каждый следующий срыв удлиняет паузу, до потолка.
func TestLoginGuardEscalates(t *testing.T) {
	g, c := testGuard()
	trip := func() time.Duration {
		for i := 0; i < loginMaxFails; i++ {
			g.record("ip:203.0.113.9")
		}
		d := g.retryAfter("ip:203.0.113.9")
		c.add(d + time.Second) // переждать и сорваться снова
		return d
	}
	first := trip()
	second := trip()
	if second <= first {
		t.Fatalf("вторая пауза %s не длиннее первой %s", second, first)
	}
	for i := 0; i < 10; i++ {
		trip()
	}
	if last := g.retryAfter("ip:203.0.113.9"); last > loginMaxLock {
		t.Fatalf("пауза %s превысила потолок %s", last, loginMaxLock)
	}
}

// TestLoginGuardWindowResets — редкие ошибки не копятся: срыв час назад
// сегодняшнюю попытку не портит.
func TestLoginGuardWindowResets(t *testing.T) {
	g, c := testGuard()
	for i := 0; i < loginMaxFails-1; i++ {
		g.record("ip:198.51.100.7")
	}
	c.add(loginWindow + time.Second)
	g.record("ip:198.51.100.7") // первый в новом окне
	if d := g.retryAfter("ip:198.51.100.7"); d != 0 {
		t.Fatalf("окно не сбросилось: пауза %s после одного срыва в новом окне", d)
	}
}

// TestLoginGuardClearOnSuccess — успешный вход обнуляет счётчик: важны
// срывы подряд, а не за всю жизнь аккаунта.
func TestLoginGuardClearOnSuccess(t *testing.T) {
	g, _ := testGuard()
	for i := 0; i < loginMaxFails-1; i++ {
		g.record("user:dm")
	}
	g.clear("user:dm")
	for i := 0; i < loginMaxFails-1; i++ {
		g.record("user:dm")
	}
	if d := g.retryAfter("user:dm"); d != 0 {
		t.Fatalf("после сброса счётчик не начался заново: пауза %s", d)
	}
}

// TestLoginGuardWorstKeyWins — блокировка по любому из ключей закрывает вход,
// и Retry-After берётся по худшему.
func TestLoginGuardWorstKeyWins(t *testing.T) {
	g, _ := testGuard()
	for i := 0; i < loginMaxFails; i++ {
		g.record("user:dm")
	}
	// IP чист, логин заперт — вход всё равно закрыт.
	if d := g.worst("ip:198.51.100.7", "user:dm"); d <= 0 {
		t.Fatal("worst не увидел блокировку по логину при чистом IP")
	}
}

// TestLoginGuardSweepDropsStale — молчащие ключи забываются, таблица не
// растёт бесконечно под распределённым перебором.
func TestLoginGuardSweepDropsStale(t *testing.T) {
	g, c := testGuard()
	g.record("ip:198.51.100.1")
	c.add(loginGuardTTL + time.Minute)
	g.record("ip:198.51.100.2") // любой record запускает уборку
	g.mu.Lock()
	_, stale := g.entries["ip:198.51.100.1"]
	n := len(g.entries)
	g.mu.Unlock()
	if stale {
		t.Fatal("молчащий ключ не убран")
	}
	if n != 1 {
		t.Fatalf("в таблице %d ключей, ожидался 1", n)
	}
}

// TestLoginGuardCapEvictsOldest — при переполнении вытесняется ключ, дольше
// всех не появлявшийся.
func TestLoginGuardCapEvictsOldest(t *testing.T) {
	g, c := testGuard()
	g.mu.Lock()
	for i := 0; i < maxLoginGuardEntries; i++ {
		g.entries[keyN(i)] = &loginAttempts{seen: c.now()}
	}
	g.mu.Unlock()

	c.add(time.Minute)
	g.entries[keyN(0)].seen = c.now() // ключ 0 только что «появился»
	c.add(time.Minute)
	g.record("ip:fresh") // переполнение — кого-то надо вытеснить

	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.entries) > maxLoginGuardEntries {
		t.Fatalf("потолок не удержан: %d ключей", len(g.entries))
	}
	if _, ok := g.entries[keyN(0)]; !ok {
		t.Fatal("вытеснен недавно активный ключ вместо давно молчащего")
	}
}

func keyN(i int) string {
	return "ip:10.0." + itoa(i/256) + "." + itoa(i%256)
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}
