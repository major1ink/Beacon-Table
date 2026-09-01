package app

import (
	"context"
	"testing"
	"time"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository/memory"
)

// emptyWorlds — «мир сейчас не запущен». Уборщика это не должно смущать:
// аккаунт уходит в любом случае, а фишки и заготовки убирать просто негде
// (см. GuestKeeper.Release). Всё, что касается фишек, проверяется там, где
// они живут, — см. service.TestRemoveOwnerTokens.
type emptyWorlds struct{}

func (emptyWorlds) Current() *ActiveWorld { return nil }

// testKeeper — уборщик с коротким терпением и своим списком аккаунтов.
func testKeeper(t *testing.T, accs ...*domain.Account) (*GuestKeeper, *memory.AccountStore) {
	t.Helper()
	accounts := memory.NewAccountStore()
	for _, a := range accs {
		if err := accounts.Create(context.Background(), a); err != nil {
			t.Fatalf("аккаунт %s: %v", a.Username, err)
		}
	}
	return &GuestKeeper{
		worlds:   emptyWorlds{},
		accounts: accounts,
		idle:     time.Minute,
		seen:     map[string]time.Time{},
		online:   map[string]int{},
	}, accounts
}

func account(id, role string) *domain.Account {
	return &domain.Account{
		ID: id, Username: id, PasswordHash: "x",
		Role: role, Status: domain.AccountStatusActive, CompanyID: "world-1",
	}
}

func alive(t *testing.T, accounts *memory.AccountStore, id string) bool {
	t.Helper()
	_, err := accounts.ByID(context.Background(), id)
	return err == nil
}

// TestSweepRemovesSilentGuest — то, ради чего уборщик и заведён: закрывший
// вкладку гость освобождает место, не дожидаясь сброса демо-стола.
func TestSweepRemovesSilentGuest(t *testing.T) {
	keeper, accounts := testKeeper(t, account("guest", domain.AccountRoleDemo))
	keeper.seen["guest"] = time.Now().Add(-2 * time.Minute)

	if got := keeper.Sweep(context.Background()); got != 1 {
		t.Fatalf("убрано %d гостей, ожидался 1", got)
	}
	if alive(t, accounts, "guest") {
		t.Error("замолчавший гость остался в базе")
	}
}

// TestSweepKeepsGuestAtTheTable — гость может час смотреть, как водит ДМ, не
// сделав ни одного запроса. Пока его WS открыт, он за столом, и уносить его
// нельзя, сколько бы времени ни прошло с последней отметки.
func TestSweepKeepsGuestAtTheTable(t *testing.T) {
	keeper, accounts := testKeeper(t, account("guest", domain.AccountRoleDemo))
	offline := keeper.Online("guest")
	keeper.seen["guest"] = time.Now().Add(-time.Hour)

	if got := keeper.Sweep(context.Background()); got != 0 {
		t.Fatalf("убрано %d гостей, ожидалось 0", got)
	}
	if !alive(t, accounts, "guest") {
		t.Fatal("гостя убрали, пока он сидел за столом")
	}

	// Вкладка закрыта — отсчёт бездействия начинается только сейчас, поэтому
	// ближайший обход его ещё не трогает.
	offline()
	if got := keeper.Sweep(context.Background()); got != 0 {
		t.Fatalf("убрано %d гостей сразу после отключения, ожидалось 0", got)
	}

	keeper.seen["guest"] = time.Now().Add(-2 * time.Minute)
	if got := keeper.Sweep(context.Background()); got != 1 {
		t.Fatalf("убрано %d гостей после тишины, ожидался 1", got)
	}
}

// TestSweepSparesLiveAccounts — ДМ сервера и обычный игрок не гости: их
// аккаунты не должны исчезать оттого, что человек неделю не заходил.
func TestSweepSparesLiveAccounts(t *testing.T) {
	keeper, accounts := testKeeper(t,
		account("dm", domain.AccountRoleAdmin),
		account("player", domain.AccountRolePlayer),
		account("guest", domain.AccountRoleDemoPlayer),
	)
	for _, id := range []string{"dm", "player", "guest"} {
		keeper.seen[id] = time.Now().Add(-time.Hour)
	}

	if got := keeper.Sweep(context.Background()); got != 1 {
		t.Fatalf("убрано %d аккаунтов, ожидался 1 (только гость)", got)
	}
	for _, id := range []string{"dm", "player"} {
		if !alive(t, accounts, id) {
			t.Errorf("уборщик стёр живой аккаунт %s", id)
		}
	}
}

// TestSweepGivesUnknownGuestGrace — сервер перезапустился и растерял отметки
// присутствия. Первый же обход не должен вымести всех, кто в этот момент за
// столом: незнакомцу даётся тот же срок, что и всем.
func TestSweepGivesUnknownGuestGrace(t *testing.T) {
	keeper, accounts := testKeeper(t, account("guest", domain.AccountRoleDemo))

	if got := keeper.Sweep(context.Background()); got != 0 {
		t.Fatalf("убрано %d гостей на первом обходе, ожидалось 0", got)
	}
	if !alive(t, accounts, "guest") {
		t.Fatal("гостя убрали, не дав ему ни минуты")
	}

	keeper.seen["guest"] = time.Now().Add(-2 * time.Minute)
	if got := keeper.Sweep(context.Background()); got != 1 {
		t.Fatalf("убрано %d гостей после срока, ожидался 1", got)
	}
}

// TestReleaseRefusesLiveAccount — Release зовут из хендлера выхода, куда
// приходят все подряд. Перепутать роль здесь означало бы стереть аккаунт ДМ
// по нажатию «Выйти», поэтому проверка стоит внутри самого Release.
func TestReleaseRefusesLiveAccount(t *testing.T) {
	keeper, accounts := testKeeper(t, account("dm", domain.AccountRoleAdmin))
	acc, err := accounts.ByID(context.Background(), "dm")
	if err != nil {
		t.Fatal(err)
	}
	if err := keeper.Release(context.Background(), acc); err != nil {
		t.Fatalf("Release вернул ошибку: %v", err)
	}
	if !alive(t, accounts, "dm") {
		t.Error("Release стёр аккаунт ДМ")
	}
}

// TestKeeperNilIsHarmless — обычная (не демонстрационная) установка держит
// nil вместо уборщика, и все обращения к нему обязаны быть пустышками: иначе
// каждый вызов пришлось бы оборачивать проверкой на месте.
func TestKeeperNilIsHarmless(t *testing.T) {
	var keeper *GuestKeeper
	keeper.Touch("whoever")
	keeper.Online("whoever")()
	if err := keeper.Release(context.Background(), account("guest", domain.AccountRoleDemo)); err != nil {
		t.Fatalf("Release на nil-уборщике: %v", err)
	}
	if got := keeper.Sweep(context.Background()); got != 0 {
		t.Fatalf("Sweep на nil-уборщике убрал %d", got)
	}
}

// TestDropStrangersForgetsGoneGuests — гость может уйти мимо уборщика (сброс
// демо-стола сносит их всех разом). Таблица отметок иначе росла бы на
// каждого, кто когда-либо заходил.
func TestDropStrangersForgetsGoneGuests(t *testing.T) {
	keeper, _ := testKeeper(t)
	keeper.seen["ушедший"] = time.Now()
	keeper.online["ушедший"] = 1

	keeper.Sweep(context.Background())

	keeper.mu.Lock()
	defer keeper.mu.Unlock()
	if len(keeper.seen) != 0 || len(keeper.online) != 0 {
		t.Errorf("в таблице остались отметки: seen=%v online=%v", keeper.seen, keeper.online)
	}
}
