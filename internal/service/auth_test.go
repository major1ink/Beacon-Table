package service_test

// Тесты AuthService поверх in-memory реализаций repository — без настоящей
// SQLite. Заодно они демонстрируют цель разделения на слои: AuthService не
// знает и не должен знать, что в проде за интерфейсами repository стоит
// sqlite.Store, а не memory.AccountStore.

import (
	"context"
	"errors"
	"strings"
	"testing"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository/memory"
	"beacon-table/internal/service"
)

// testSuite собирает AuthService и AdminService поверх одних и тех же
// in-memory репозиториев — тестам логина нужен ApproveAccount из
// AdminService, регистрация сама по себе создаёт только pending-аккаунт.
type testSuite struct {
	auth  service.AuthService
	admin service.AdminService
}

// testCompanyID — фиксированный id "мира" для этих тестов: AuthService.Register
// требует companyID (см. её комментарий), а AdminService теперь company-scoped
// (см. internal/service/admin.go) — оба используют один и тот же id, как и
// было бы в реальности (одна активная компания за раз).
const testCompanyID = "co-1"

func newTestSuite() testSuite {
	accounts := memory.NewAccountStore()
	sessions := memory.NewSessionStore(accounts)
	characters := memory.NewCharacterStore()
	return testSuite{
		auth:  service.NewAuthService(accounts, sessions),
		admin: service.NewAdminService(accounts, sessions, characters, testCompanyID),
	}
}

// registerAndApprove — регистрирует и сразу одобряет аккаунт, как это
// обычно делает ДМ в реальном сценарии, возвращает его domain.Account.
func (ts testSuite) registerAndApprove(t *testing.T, ctx context.Context, username, password string) *domain.Account {
	t.Helper()
	if err := ts.auth.Register(ctx, testCompanyID, username, password); err != nil {
		t.Fatalf("Register(%q): %v", username, err)
	}
	accs, err := ts.admin.ListAccounts(ctx)
	if err != nil {
		t.Fatalf("ListAccounts: %v", err)
	}
	var acc *domain.Account
	for _, a := range accs {
		if a.Username == username {
			acc = a
		}
	}
	if acc == nil {
		t.Fatalf("аккаунт %q не найден после регистрации", username)
	}
	if err := ts.admin.ApproveAccount(ctx, acc.ID); err != nil {
		t.Fatalf("ApproveAccount: %v", err)
	}
	return acc
}

func TestAuthService_Register_PendingCannotLogin(t *testing.T) {
	ctx := context.Background()
	ts := newTestSuite()

	if err := ts.auth.Register(ctx, testCompanyID, "alice", "hunter22"); err != nil {
		t.Fatalf("Register: %v", err)
	}
	// ещё не одобрен ДМ — логин должен отказать с ErrForbidden, а не 500/401.
	if _, _, err := ts.auth.Login(ctx, "alice", "hunter22"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("Login pending account: ожидали ErrForbidden, получили %v", err)
	}
}

func TestAuthService_Register_Validation(t *testing.T) {
	ctx := context.Background()
	ts := newTestSuite()

	cases := map[string]struct{ username, password string }{
		"короткое имя":    {"ab", "hunter22"},
		"длинное имя":     {strings.Repeat("a", 33), "hunter22"},
		"короткий пароль": {"validname", "123"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			var verr *domain.ValidationError
			err := ts.auth.Register(ctx, testCompanyID, tc.username, tc.password)
			if !errors.As(err, &verr) {
				t.Fatalf("ожидали *domain.ValidationError, получили %v", err)
			}
		})
	}
}

func TestAuthService_Register_DuplicateUsername(t *testing.T) {
	ctx := context.Background()
	ts := newTestSuite()

	if err := ts.auth.Register(ctx, testCompanyID, "alice", "hunter22"); err != nil {
		t.Fatalf("Register: %v", err)
	}
	err := ts.auth.Register(ctx, testCompanyID, "alice", "anotherpass")
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("ожидали ErrConflict, получили %v", err)
	}
}

func TestAuthService_Login_Success(t *testing.T) {
	ctx := context.Background()
	ts := newTestSuite()
	acc := ts.registerAndApprove(t, ctx, "alice", "hunter22")

	token, loggedIn, err := ts.auth.Login(ctx, "alice", "hunter22")
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if token == "" {
		t.Fatal("ожидали непустой токен сессии")
	}
	if loggedIn.ID != acc.ID {
		t.Fatalf("вернулся не тот аккаунт: %+v", loggedIn)
	}

	got, err := ts.auth.AccountBySession(ctx, token)
	if err != nil || got.ID != acc.ID {
		t.Fatalf("AccountBySession: %v, %v", got, err)
	}
}

func TestAuthService_Login_WrongPassword(t *testing.T) {
	ctx := context.Background()
	ts := newTestSuite()
	ts.registerAndApprove(t, ctx, "bob", "hunter22")

	if _, _, err := ts.auth.Login(ctx, "bob", "неверный-пароль"); !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatalf("ожидали ErrUnauthorized, получили %v", err)
	}
}

func TestAuthService_ChangeOwnPassword(t *testing.T) {
	ctx := context.Background()
	ts := newTestSuite()
	acc := ts.registerAndApprove(t, ctx, "carol", "hunter22")

	// неверный старый пароль — отказ, ничего не меняется
	if err := ts.auth.ChangeOwnPassword(ctx, acc.ID, "неверный-старый", "newpassword1"); !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatalf("ожидали ErrUnauthorized, получили %v", err)
	}

	// верный старый пароль — успех, старый пароль перестаёт работать
	if err := ts.auth.ChangeOwnPassword(ctx, acc.ID, "hunter22", "newpassword1"); err != nil {
		t.Fatalf("ChangeOwnPassword: %v", err)
	}
	if _, _, err := ts.auth.Login(ctx, "carol", "hunter22"); !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatalf("старый пароль всё ещё работает: %v", err)
	}
	if _, _, err := ts.auth.Login(ctx, "carol", "newpassword1"); err != nil {
		t.Fatalf("новый пароль не работает: %v", err)
	}
}
