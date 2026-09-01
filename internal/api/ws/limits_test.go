package ws_test

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/gorilla/websocket"

	apiws "beacon-table/internal/api/ws"
	"beacon-table/internal/app"
	"beacon-table/internal/domain"
	"beacon-table/internal/repository/sqlite"
	"beacon-table/internal/service"
)

// Пределы соединения (см. api/ws/client.go). Всё здесь — про поведение
// сокета, смотрящего в интернет: кадр произвольного размера от гостя демо,
// молча оборванное мобильной сетью соединение, живой но молчащий клиент.

// testTable — поднятый стол с запущенным миром, аккаунтом ДМ и сервером на
// случайном порту. Возвращает адрес и cookie сессии для дозвона.
func testTable(t *testing.T) (url, cookie string) {
	t.Helper()
	ctx := context.Background()
	dir := t.TempDir()

	db, err := sqlite.Open(filepath.Join(dir, "beacon.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	accounts := sqlite.NewAccountStore(db)
	sessions := sqlite.NewSessionStore(db, accounts)
	companies := sqlite.NewCompanyStore(db)
	mgr := app.NewCompanyManager(db, companies, accounts, sessions, service.NewDiceRoller(),
		fstest.MapFS{}, filepath.Join(dir, "data"), filepath.Join(dir, "uploads"), "/uploads/", true, nil)
	if err := mgr.Bootstrap(ctx); err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}
	company, err := mgr.Create(ctx, "Мир", domain.SystemDnD5e2024)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := mgr.Launch(ctx, company.ID); err != nil {
		t.Fatalf("Launch: %v", err)
	}
	t.Cleanup(mgr.Shutdown)

	if err := accounts.Create(ctx, &domain.Account{
		ID: "dm-1", Username: "dm", PasswordHash: "x",
		Role: domain.AccountRoleAdmin, Status: domain.AccountStatusActive,
	}); err != nil {
		t.Fatalf("аккаунт: %v", err)
	}
	if err := sessions.Create(ctx, "sess-dm", "dm-1"); err != nil {
		t.Fatalf("сессия: %v", err)
	}

	mux := http.NewServeMux()
	apiws.RegisterRoutes(mux, mgr, service.NewAuthService(accounts, sessions),
		service.NewBroadcastService(sqlite.NewServerStateStore(db)), apiws.Options{})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws/dm",
		domain.SessionCookieName + "=sess-dm"
}

// dialTable подключается к столу и дочитывает пачку кадров, которую комната
// шлёт каждому вошедшему (снапшот, состав стола, бой, хаб), — дальше тест
// имеет дело с тишиной.
func dialTable(t *testing.T, url, cookie string) *websocket.Conn {
	t.Helper()
	conn, resp, err := websocket.DefaultDialer.Dial(url, http.Header{"Cookie": {cookie}})
	if resp != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatalf("SetReadDeadline: %v", err)
	}
	if _, _, err := conn.ReadMessage(); err != nil {
		t.Fatalf("снапшот не пришёл: %v", err)
	}
	return conn
}

// TestOversizedFrameIsRefused — главная причина, по которой лимит вообще
// появился: гость публичного демо (см. api/http/demo_handlers.go) не должен
// уметь занять память сервера одним кадром. Раньше ReadMessage складывал в
// неё кадр любого размера.
func TestOversizedFrameIsRefused(t *testing.T) {
	url, cookie := testTable(t)
	conn := dialTable(t, url, cookie)

	// Заведомо больше предела, но не настолько, чтобы тест сам стал тяжёлым.
	huge := make([]byte, apiws.MaxClientFrame+1024)
	for i := range huge {
		huge[i] = 'x'
	}
	_ = conn.SetWriteDeadline(time.Now().Add(3 * time.Second))
	if err := conn.WriteMessage(websocket.TextMessage, huge); err != nil {
		// Сервер мог закрыть соединение уже на середине приёма — это тот же
		// правильный исход, что и close-кадр ниже.
		return
	}

	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	var err error
	for {
		if _, _, err = conn.ReadMessage(); err != nil {
			break
		}
	}
	if !websocket.IsCloseError(err, websocket.CloseMessageTooBig) && !isBrokenPipe(err) {
		t.Fatalf("кадр сверх предела не отвергнут: %v", err)
	}
}

// TestFrameWithinLimitPasses — граница проведена там, где надо: обводка
// тумана вокруг крупной карты — это сотни килобайт законного JSON (см.
// web/src/vtt/interaction.js: fogPath), и она обязана доходить.
func TestFrameWithinLimitPasses(t *testing.T) {
	url, cookie := testTable(t)
	conn := dialTable(t, url, cookie)

	// Контур на ~7000 точек — заметно больше любой реальной обводки.
	var b strings.Builder
	b.WriteString(`{"type":"add_fog_area","fogArea":{"id":"fog-big","points":[`)
	for i := 0; i < 7000; i++ {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(`{"x":1234.5678,"y":8765.4321}`)
	}
	b.WriteString(`]}}`)
	if b.Len() >= apiws.MaxClientFrame {
		t.Fatalf("тестовый контур сам перерос предел (%d байт) — проверять нечего", b.Len())
	}

	_ = conn.SetWriteDeadline(time.Now().Add(3 * time.Second))
	if err := conn.WriteMessage(websocket.TextMessage, []byte(b.String())); err != nil {
		t.Fatalf("законный кадр не отправился: %v", err)
	}

	// Мутация принята — комната разослала обновление сцены всем за столом.
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, _, err := conn.ReadMessage(); err != nil {
		t.Fatalf("ответа на законный кадр нет, соединение закрыто: %v", err)
	}
}

// TestSilentClientIsDisconnected — соединение, оборванное мобильной сетью
// или NAT, не даёт ни ошибки чтения, ни закрытия. Без дедлайна горутина
// висела бы вечно, клиент оставался в комнате, и в списке игроков у ДМ
// стоял бы призрак.
//
// «Мёртвый» клиент изображается отключённым ответом на пинг: живой сокет,
// который молчит, — это ровно то, что видит сервер на другом конце
// оборванного канала.
func TestSilentClientIsDisconnected(t *testing.T) {
	defer apiws.SetKeepaliveForTest(50*time.Millisecond, 300*time.Millisecond)()

	url, cookie := testTable(t)
	conn := dialTable(t, url, cookie)
	conn.SetPingHandler(func(string) error { return nil }) // понг в ответ не шлём

	select {
	case <-readErrors(t, conn):
		// Сервер закрыл соединение — то, что нужно.
	case <-time.After(3 * time.Second):
		t.Fatal("молчащий клиент не отключён: соединение живо много дольше срока ожидания")
	}
}

// TestAnsweringClientStaysConnected — обратная сторона: клиент, который
// ничего не делает, но на пинги отвечает (свёрнутая вкладка, экран
// трансляции на телевизоре), обязан оставаться за столом. Иначе лечение
// оказалось бы хуже болезни.
func TestAnsweringClientStaysConnected(t *testing.T) {
	defer apiws.SetKeepaliveForTest(50*time.Millisecond, 300*time.Millisecond)()

	url, cookie := testTable(t)
	conn := dialTable(t, url, cookie)
	// Понг в ответ на пинг шлёт обработчик gorilla по умолчанию — его и
	// оставляем, как это делает браузер.

	// Ждём заведомо дольше укороченного pongWait. Тишина в канале ошибок —
	// это и есть успех: за всю секунду сервер не отключил клиента.
	select {
	case err := <-readErrors(t, conn):
		t.Fatalf("отвечающего на пинги клиента отключили: %v", err)
	case <-time.After(time.Second):
	}
}

// readErrors читает сокет в отдельной горутине и отдаёт первую ошибку.
//
// Читать обязательно, и обязательно без дедлайна: понг на пинг отправляет
// обработчик gorilla, а вызывается он изнутри чтения — «подождать, не читая»
// означало бы не отвечать на пинги, то есть изображать ровно того мёртвого
// клиента, которого проверяет соседний тест. Дедлайн тут тоже не годится:
// после любой ошибки чтения, включая тайм-аут, gorilla считает соединение
// провалившимся и паникует на следующем чтении.
func readErrors(t *testing.T, conn *websocket.Conn) <-chan error {
	t.Helper()
	ch := make(chan error, 1)
	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				ch <- err
				return
			}
		}
	}()
	return ch
}

// isTimeout — «мы не дождались», а не «нас отключили».
func isTimeout(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

// isBrokenPipe — сервер закрыл соединение раньше, чем мы дочитали ответ.
// Для теста это тот же успех, что и close-кадр: кадр сверх предела не был
// принят.
func isBrokenPipe(err error) bool {
	return err != nil && !websocket.IsCloseError(err, websocket.CloseNormalClosure) && !isTimeout(err)
}
