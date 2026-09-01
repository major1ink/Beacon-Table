package service_test

import (
	"context"
	"strings"
	"testing"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository/memory"
	"beacon-table/internal/service"
)

// TestCreateGuestOpensSession — гость демо входит одним нажатием: аккаунт
// сразу активен (без одобрения ДМ) и сессия открыта, иначе посетитель
// упёрся бы в «ждите подтверждения» и ушёл.
func TestCreateGuestOpensSession(t *testing.T) {
	ctx := context.Background()
	accounts := memory.NewAccountStore()
	sessions := memory.NewSessionStore(accounts)
	auth := service.NewAuthService(accounts, sessions)

	token, acc, err := auth.CreateGuest(ctx, "world-1", 10)
	if err != nil {
		t.Fatalf("CreateGuest: %v", err)
	}
	if acc.Role != domain.AccountRoleDemo {
		t.Fatalf("роль %q, ожидалась demo", acc.Role)
	}
	if !acc.IsActive() {
		t.Fatal("гость заведён неактивным — он не сможет войти")
	}
	if acc.CompanyID != "world-1" {
		t.Fatalf("гость привязан к миру %q", acc.CompanyID)
	}
	if !strings.HasPrefix(acc.Username, "гость-") {
		t.Fatalf("логин %q — по нему не отличить гостя в списке аккаунтов", acc.Username)
	}

	// Сессия действительно работает.
	got, err := auth.AccountBySession(ctx, token)
	if err != nil {
		t.Fatalf("сессия гостя не резолвится: %v", err)
	}
	if got.ID != acc.ID {
		t.Fatalf("сессия ведёт на чужой аккаунт")
	}
}

// TestGuestRoleSeparatesTableFromServer — гость ведёт стол, но не
// распоряжается сервером. Это и есть граница, на которой держится публичное
// демо.
func TestGuestRoleSeparatesTableFromServer(t *testing.T) {
	guest := &domain.Account{Role: domain.AccountRoleDemo}
	if !guest.IsGM() {
		t.Error("гость не может вести стол — демо теряет смысл")
	}
	if guest.IsOwner() {
		t.Error("гость распоряжается сервером — публичное демо означало бы «возьмите мой сервер»")
	}

	dm := &domain.Account{Role: domain.AccountRoleAdmin}
	if !dm.IsGM() || !dm.IsOwner() {
		t.Error("настоящий ДМ потерял права")
	}

	player := &domain.Account{Role: domain.AccountRolePlayer}
	if player.IsGM() || player.IsOwner() {
		t.Error("игрок получил лишние права")
	}
}

// TestCreateGuestRespectsLimit — гостей заводят без всякого участия
// человека, поэтому их число ограничено: иначе один скрипт набьёт базу.
func TestCreateGuestRespectsLimit(t *testing.T) {
	ctx := context.Background()
	accounts := memory.NewAccountStore()
	auth := service.NewAuthService(accounts, memory.NewSessionStore(accounts))

	for i := 0; i < 3; i++ {
		if _, _, err := auth.CreateGuest(ctx, "world-1", 3); err != nil {
			t.Fatalf("гость %d: %v", i+1, err)
		}
	}
	if _, _, err := auth.CreateGuest(ctx, "world-1", 3); err == nil {
		t.Fatal("гость сверх предела заведён")
	}
}

// TestCreateGuestNeedsWorld — без запущенного стола гостя пускать некуда.
func TestCreateGuestNeedsWorld(t *testing.T) {
	accounts := memory.NewAccountStore()
	auth := service.NewAuthService(accounts, memory.NewSessionStore(accounts))

	if _, _, err := auth.CreateGuest(context.Background(), "", 10); err == nil {
		t.Fatal("гость заведён без запущенного мира")
	}
}

// TestGuestCannotLogInByPassword — у гостя нет пароля, который он мог бы
// ввести: вход только через кнопку демо, повторно этим логином не войти.
func TestGuestCannotLogInByPassword(t *testing.T) {
	ctx := context.Background()
	accounts := memory.NewAccountStore()
	auth := service.NewAuthService(accounts, memory.NewSessionStore(accounts))

	_, acc, err := auth.CreateGuest(ctx, "world-1", 10)
	if err != nil {
		t.Fatalf("CreateGuest: %v", err)
	}
	for _, pass := range []string{"", " ", acc.Username} {
		if _, _, err := auth.Login(ctx, acc.Username, pass); err == nil {
			t.Errorf("вход гостем по паролю %q прошёл", pass)
		}
	}
}
