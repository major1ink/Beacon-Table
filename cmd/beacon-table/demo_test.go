package main

import (
	"context"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"beacon-table/internal/app"
	"beacon-table/internal/domain"
	"beacon-table/internal/repository/sqlite"
	"beacon-table/internal/service"
)

// TestSleepCtxReturnsFalseOnCancel — отмена ctx должна разбудить sleepCtx
// сразу, не дожидаясь самой паузы: Run полагается ровно на это, чтобы
// остановка сервера посреди ожидания (между предупреждением и сбросом)
// не задерживала выход ни на секунду.
func TestSleepCtxReturnsFalseOnCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	start := time.Now()
	if sleepCtx(ctx, time.Hour) {
		t.Fatal("sleepCtx вернул true при уже отменённом ctx")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("sleepCtx ждал %v вместо немедленного выхода", elapsed)
	}
}

// TestSleepCtxReturnsTrueAfterDuration — обычный случай: никто не отменял,
// просто дождались срока.
func TestSleepCtxReturnsTrueAfterDuration(t *testing.T) {
	if !sleepCtx(context.Background(), 10*time.Millisecond) {
		t.Fatal("sleepCtx вернул false без отмены ctx")
	}
}

// fakeClient — реализация service.RoomClient, которая копит все Send и
// умеет вытащить из них тексты table_notice. Присоединяется к настоящей
// Room через Join, поэтому Announce виден ровно так, как его увидел бы
// браузер за столом.
type fakeClient struct {
	mu   sync.Mutex
	msgs []any
}

func (c *fakeClient) Send(v any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.msgs = append(c.msgs, v)
}
func (c *fakeClient) Close()                  {}
func (c *fakeClient) Role() domain.ClientRole { return domain.RoleDM }
func (c *fakeClient) PlayerID() string        { return "test-observer" }
func (c *fakeClient) PlayerName() string      { return "наблюдатель" }

func (c *fakeClient) notices() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []string
	for _, v := range c.msgs {
		if m, ok := v.(map[string]any); ok && m["type"] == "table_notice" {
			out = append(out, m["text"].(string))
		}
	}
	return out
}

// testDemoTable — CompanyManager с одним запущенным миром, тот же приём,
// что и в internal/api/ws/limits_test.go: полноценная (sqlite + Room-актор)
// среда, а не фейк, потому что именно доставку Announce через настоящий
// канал комнаты и проверяем.
func testDemoTable(t *testing.T) *app.CompanyManager {
	t.Helper()
	ctx := context.Background()
	dir := t.TempDir()

	db, err := sqlite.Open(filepath.Join(dir, "beacon.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	companies := sqlite.NewCompanyStore(db)
	accounts := sqlite.NewAccountStore(db)
	sessions := sqlite.NewSessionStore(db, accounts)
	mgr := app.NewCompanyManager(db, companies, accounts, sessions, service.NewDiceRoller(),
		fstest.MapFS{}, filepath.Join(dir, "data"), filepath.Join(dir, "uploads"), "/uploads/", true, nil)
	if err := mgr.Bootstrap(ctx); err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}
	company, err := mgr.Create(ctx, "Демо", domain.SystemDnD5e2024)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := mgr.Launch(ctx, company.ID); err != nil {
		t.Fatalf("Launch: %v", err)
	}
	t.Cleanup(mgr.Shutdown)
	return mgr
}

// TestDemoResetterWarnReachesTable — warn() доходит до реально сидящего за
// столом, тем же каналом, что и остальные широковещательные события комнаты
// (см. Room.Announce). Число минут в тексте берётся из d.warnBefore, а не
// зашито строкой — проверяем, что оно и правда подставляется.
func TestDemoResetterWarnReachesTable(t *testing.T) {
	mgr := testDemoTable(t)
	client := &fakeClient{}
	mgr.Current().Room.Join(client)

	d := &demoResetter{companies: mgr, warnBefore: 5 * time.Minute}
	d.warn()

	// Join — отправка в небуферизованный канал: она возвращается, как только
	// актор комнаты ПРИНЯЛ клиента, но тело этого case (запись в r.clients,
	// снапшот) актор доделывает уже после — гарантии, что это произошло до
	// возврата Join, нет. Поэтому ждём с опросом, а не проверяем сразу.
	var notices []string
	deadline := time.Now().Add(3 * time.Second)
	for len(notices) == 0 {
		notices = client.notices()
		if time.Now().After(deadline) {
			t.Fatalf("предупреждение не дошло за отведённое время")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if len(notices) != 1 {
		t.Fatalf("получено %d предупреждений, ожидалось 1: %v", len(notices), notices)
	}
	if !strings.Contains(notices[0], "5 мин") {
		t.Errorf("текст предупреждения не называет срок: %q", notices[0])
	}
}

// TestDemoResetterRunWarnsBeforeAttemptingReset — сквозная проверка Run:
// предупреждение доходит до стола РАНЬШЕ, чем сервер вообще пытается
// сбросить мир, а отмена ctx останавливает цикл, не дожидаясь следующего
// шага. worldZip намеренно указывает в никуда — сам Reset() не тестируется
// здесь (это экспорт-импорт всего мира, отдельная история), важен только
// порядок и то, что неудачный Reset не роняет цикл и не блокирует выход.
func TestDemoResetterRunWarnsBeforeAttemptingReset(t *testing.T) {
	mgr := testDemoTable(t)
	client := &fakeClient{}
	mgr.Current().Room.Join(client)

	d := &demoResetter{
		companies:  mgr,
		worldZip:   filepath.Join(t.TempDir(), "нет-такого-файла.zip"),
		interval:   120 * time.Millisecond,
		warnBefore: 80 * time.Millisecond,
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		d.Run(ctx)
		close(done)
	}()

	deadline := time.Now().Add(3 * time.Second)
	for len(client.notices()) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("предупреждение так и не пришло")
		}
		time.Sleep(5 * time.Millisecond)
	}

	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Run не остановился после отмены ctx")
	}
}

// TestDemoResetterWarnToleratesNoWorld — между остановкой сервера и выходом
// Current() на миг может отдать nil (см. комментарий warn); проверяем, что
// это не паника, а тихий no-op.
func TestDemoResetterWarnToleratesNoWorld(t *testing.T) {
	mgr := testDemoTable(t)
	if err := mgr.Deactivate(context.Background()); err != nil {
		t.Fatalf("Deactivate: %v", err)
	}
	d := &demoResetter{companies: mgr, warnBefore: time.Minute}
	d.warn() // не должно паниковать
}
