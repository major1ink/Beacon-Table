package http

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository/memory"
	"beacon-table/internal/service"
)

// loginAPI — API с настоящим ограничителем и пустой базой аккаунтов: любой
// вход неудачен, что и нужно для проверки перебора. Часы ограничителя
// управляемы, чтобы не ждать реальную минуту. Хендлер зовём напрямую —
// через httptest.Server RemoteAddr всегда 127.0.0.1, а тут нужен разный IP.
func loginAPI(t *testing.T) (*API, *clock) {
	t.Helper()
	accounts := memory.NewAccountStore()
	sessions := memory.NewSessionStore(accounts)
	api := &API{Auth: service.NewAuthService(accounts, sessions), loginGuard: newLoginGuard()}
	c := &clock{t: testStart}
	api.loginGuard.now = c.now
	return api, c
}

func tryLogin(api *API, ip, user string) *httptest.ResponseRecorder {
	body := `{"Username":"` + user + `","Password":"нет"}`
	req := httptest.NewRequest(http.MethodPost, "/api/login", strings.NewReader(body))
	req.RemoteAddr = ip + ":50000"
	rec := httptest.NewRecorder()
	api.handleLogin(rec, req)
	return rec
}

// TestLoginRateLimitByIP — один источник, перебирающий пароли: после шести
// неудач подряд адрес получает 429 с Retry-After, а не бесконечные попытки.
func TestLoginRateLimitByIP(t *testing.T) {
	api, c := loginAPI(t)

	for i := 0; i < loginMaxFails; i++ {
		if code := tryLogin(api, "198.51.100.7", "dm").Code; code != http.StatusUnauthorized {
			t.Fatalf("попытка %d: код %d, ожидался 401", i+1, code)
		}
	}
	// Шестая — уже 429.
	rec := tryLogin(api, "198.51.100.7", "dm")
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("после лимита код %d, ожидался 429", rec.Code)
	}
	ra, err := strconv.Atoi(rec.Header().Get("Retry-After"))
	if err != nil || ra <= 0 {
		t.Fatalf("Retry-After = %q", rec.Header().Get("Retry-After"))
	}

	// Другой адрес с другим логином не задет (логин "dm" тут заперт и по
	// имени — см. TestLoginRateLimitByUsername).
	if code := tryLogin(api, "203.0.113.9", "player").Code; code != http.StatusUnauthorized {
		t.Fatalf("чужой адрес заблокирован заодно: код %d", code)
	}

	// Пауза прошла — снова пускаем.
	c.add(loginBaseLock + 2*loginWindow)
	if code := tryLogin(api, "198.51.100.7", "dm").Code; code != http.StatusUnauthorized {
		t.Fatalf("после паузы адрес всё ещё заперт: код %d", code)
	}
}

// TestLoginRateLimitByUsername — распределённый перебор одного аккаунта:
// адреса разные, но логин один, и после лимита он закрыт с любого адреса.
// Ровно то, чем грозит открытый в интернет аккаунт «dm».
func TestLoginRateLimitByUsername(t *testing.T) {
	api, _ := loginAPI(t)

	for i := 0; i < loginMaxFails; i++ {
		tryLogin(api, "203.0.113."+strconv.Itoa(i+1), "dm")
	}
	// Свежий адрес, тот же логин — заперто по логину.
	rec := tryLogin(api, "203.0.113.200", "dm")
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("перебор одного логина с разных адресов не пойман: код %d", rec.Code)
	}
	// Другой логин с того же свежего адреса — проходит.
	if code := tryLogin(api, "203.0.113.201", "player").Code; code != http.StatusUnauthorized {
		t.Fatalf("чужой логин заблокирован заодно: код %d", code)
	}
}

// TestLoginRateLimitPendingNotCounted — аккаунт, ждущий одобрения ДМ, при
// входе даёт 403; это не подбор, и такие ответы не должны копить лимит,
// иначе игрок, тыкающий «Войти» до одобрения, сам себя запер бы.
func TestLoginRateLimitPendingNotCounted(t *testing.T) {
	accounts := memory.NewAccountStore()
	sessions := memory.NewSessionStore(accounts)
	hash, err := bcrypt.GenerateFromPassword([]byte("secret123"), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("bcrypt: %v", err)
	}
	if err := accounts.Create(t.Context(), &domain.Account{
		ID: "acc-1", Username: "newbie", PasswordHash: string(hash),
		Role: domain.AccountRolePlayer, Status: domain.AccountStatusPending, CompanyID: "w1",
	}); err != nil {
		t.Fatalf("аккаунт: %v", err)
	}
	api := &API{Auth: service.NewAuthService(accounts, sessions), loginGuard: newLoginGuard()}
	c := &clock{t: testStart}
	api.loginGuard.now = c.now

	for i := 0; i < loginMaxFails+3; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/login",
			strings.NewReader(`{"Username":"newbie","Password":"secret123"}`))
		req.RemoteAddr = "198.51.100.7:50000"
		rec := httptest.NewRecorder()
		api.handleLogin(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("попытка %d: код %d, ожидался 403 (ждёт одобрения)", i+1, rec.Code)
		}
	}
}
