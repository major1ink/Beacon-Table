package http

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"beacon-table/internal/app"
	"beacon-table/internal/domain"
	"beacon-table/internal/repository/memory"
	"beacon-table/internal/service"
)

// ownerGateAPI — API с сессиями владельца и гостя демо. Хранилище аккаунтов
// возвращается вторым: проверять «гостя больше нет» больше негде — сессии к
// этому моменту тоже удалены.
func ownerGateAPI(t *testing.T) (*API, *memory.AccountStore) {
	t.Helper()
	ctx := context.Background()
	accounts := memory.NewAccountStore()
	sessions := memory.NewSessionStore(accounts)

	for _, a := range []struct {
		id, role, token string
	}{
		{"owner", domain.AccountRoleAdmin, "sess-owner"},
		{"guest", domain.AccountRoleDemo, "sess-guest"},
	} {
		if err := accounts.Create(ctx, &domain.Account{
			ID: a.id, Username: a.id, PasswordHash: "x",
			Role: a.role, Status: domain.AccountStatusActive, CompanyID: "world-1",
		}); err != nil {
			t.Fatalf("аккаунт %s: %v", a.id, err)
		}
		if err := sessions.Create(ctx, a.token, a.id); err != nil {
			t.Fatalf("сессия %s: %v", a.id, err)
		}
	}
	return &API{
		Auth:     service.NewAuthService(accounts, sessions),
		DemoMode: true,
		// Без менеджера миров: уборщику здесь нужно убрать аккаунт, а фишки и
		// заготовки живут в мире и проверяются там (см. app.GuestKeeper,
		// service.TestRemoveOwnerTokens).
		Guests: app.NewGuestKeeper(nil, accounts),
	}, accounts
}

func gateCode(t *testing.T, token string, gate func(http.ResponseWriter, *http.Request) (*domain.Account, bool)) int {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/whatever", nil)
	req.AddCookie(&http.Cookie{Name: domain.SessionCookieName, Value: token})
	rec := httptest.NewRecorder()
	if _, ok := gate(rec, req); ok {
		return http.StatusOK
	}
	return rec.Code
}

// TestOwnerGateBlocksDemoGuest — главная граница демо: гость ведёт стол, но
// к серверу его не пускают. Без этого публичное демо отдавало бы сервер
// любому посетителю.
//
// Игрок здесь не проверяется: у него гейт упирается в проверку активного
// мира (см. requireAccount), для которой нужен собранный CompanyManager.
// Что игрок не ДМ и не владелец, проверяет TestGuestRoleSeparatesTableFromServer
// на уровне domain.
func TestOwnerGateBlocksDemoGuest(t *testing.T) {
	api, _ := ownerGateAPI(t)

	// Стол: и владелец, и гость.
	if code := gateCode(t, "sess-owner", api.requireAdminAccount); code != http.StatusOK {
		t.Errorf("владельцу закрыт стол: %d", code)
	}
	if code := gateCode(t, "sess-guest", api.requireAdminAccount); code != http.StatusOK {
		t.Errorf("гостю закрыт стол: %d — демо теряет смысл", code)
	}
	// Сервер: только владелец.
	if code := gateCode(t, "sess-owner", api.requireOwner); code != http.StatusOK {
		t.Errorf("владельцу закрыт сервер: %d", code)
	}
	if code := gateCode(t, "sess-guest", api.requireOwner); code != http.StatusForbidden {
		t.Errorf("гость демо допущен к настройкам сервера: %d", code)
	}
}

// TestDemoStatusReflectsMode — кнопка «Посмотреть демо» появляется только на
// демо-сервере; обычная установка о ней не знает.
func TestDemoStatusReflectsMode(t *testing.T) {
	for _, mode := range []bool{true, false} {
		api := &API{DemoMode: mode}
		req := httptest.NewRequest(http.MethodGet, "/api/demo", nil)
		rec := httptest.NewRecorder()
		api.handleDemoStatus(rec, req)

		want := `{"enabled":true}`
		if !mode {
			want = `{"enabled":false}`
		}
		if got := rec.Body.String(); got != want+"\n" {
			t.Errorf("при DemoMode=%v ответ %q, ожидался %q", mode, got, want)
		}
	}
}

// TestDemoGuestRefusedWhenModeOff — на обычной установке гостевой вход не
// работает, даже если кто-то дёрнет ручку напрямую.
func TestDemoGuestRefusedWhenModeOff(t *testing.T) {
	api, _ := ownerGateAPI(t)
	api.DemoMode = false

	req := httptest.NewRequest(http.MethodPost, "/api/demo/guest", nil)
	rec := httptest.NewRecorder()
	api.handleDemoGuest(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("код %d, ожидался 404 — на обычном сервере такой ручки как бы нет", rec.Code)
	}
}

// TestLogoutRemovesDemoGuest — «Выйти» у гостя означает не «до завтра», а
// «меня тут не было»: аккаунт-однодневка исчезает целиком, освобождая место
// за столом сразу, а не через уборку по бездействию (см. app.GuestKeeper).
//
// Порядок внутри хендлера здесь и проверяется: аккаунт надо достать ДО
// закрытия сессии — после неё по cookie уже никого не найти, и гость висел
// бы до уборщика.
func TestLogoutRemovesDemoGuest(t *testing.T) {
	api, accounts := ownerGateAPI(t)

	req := httptest.NewRequest(http.MethodPost, "/api/logout", nil)
	req.AddCookie(&http.Cookie{Name: domain.SessionCookieName, Value: "sess-guest"})
	rec := httptest.NewRecorder()
	api.handleLogout(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("выход ответил %d, ожидался 200", rec.Code)
	}
	if _, err := accounts.ByID(context.Background(), "guest"); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("гость остался в базе после выхода: %v", err)
	}
}

// TestLogoutKeepsOwnerAccount — тот же хендлер у владельца сервера закрывает
// одну сессию и не более: перепутать здесь роли означало бы стереть админа
// стола по нажатию «Выйти».
func TestLogoutKeepsOwnerAccount(t *testing.T) {
	api, accounts := ownerGateAPI(t)

	req := httptest.NewRequest(http.MethodPost, "/api/logout", nil)
	req.AddCookie(&http.Cookie{Name: domain.SessionCookieName, Value: "sess-owner"})
	rec := httptest.NewRecorder()
	api.handleLogout(rec, req)

	if _, err := accounts.ByID(context.Background(), "owner"); err != nil {
		t.Errorf("выход стёр аккаунт владельца: %v", err)
	}
}
