package service

import (
	"context"
	"testing"

	"beacon-table/internal/domain"
)

// Тесты собирают *Room напрямую, без NewRoom и без запуска actor-горутины
// run(): все проверяемые здесь функции — чистые мутации состояния комнаты, а
// broadcast* при пустом r.clients ничего не делает. Так тест не зависит ни
// от каналов, ни от таймера автосейва, ни от фейкового транспорта.

type fakeConditions struct {
	list []*domain.Condition
}

func (f *fakeConditions) List(ctx context.Context) ([]*domain.Condition, error) {
	return f.list, nil
}
func (f *fakeConditions) Get(ctx context.Context, id string) (*domain.Condition, error) {
	for _, c := range f.list {
		if c.ID == id {
			return c, nil
		}
	}
	return nil, domain.ErrNotFound
}
func (f *fakeConditions) Create(ctx context.Context, id string, c *domain.Condition) error {
	return nil
}
func (f *fakeConditions) Update(ctx context.Context, id string, c *domain.Condition) (bool, error) {
	return true, nil
}
func (f *fakeConditions) Delete(ctx context.Context, id string) error { return nil }

// testRoom — комната с одной сценой, одним токеном ("tok-1") и пустым
// трекером. conditions — каталог из трёх карточек: обычная, многоуровневая
// и та, что тянет за собой зависимые.
func testRoom() *Room {
	scene := domain.NewScene("scene-1", "Тест")
	scene.Tokens["tok-1"] = &domain.Token{ID: "tok-1", Label: "Гоблин"}
	return &Room{
		scenes:         map[string]*domain.SceneState{"scene-1": scene},
		sceneOrder:     []string{"scene-1"},
		currentSceneID: "scene-1",
		scene:          scene,
		clients:        map[RoomClient]bool{},
		dirtyScenes:    map[string]bool{},
		combat:         domain.NewCombatState(),
		hub:            domain.NewLootHub(),
		conditions: &fakeConditions{list: []*domain.Condition{
			{ID: "sys-prone", Name: "Положение лёжа", Slug: "prone", Icon: "🛌", Color: "#a9825d"},
			{ID: "sys-incapacitated", Name: "Недееспособность", Slug: "incapacitated", Icon: "🚫"},
			{ID: "sys-exhaustion", Name: "Истощение", Slug: "exhaustion", Icon: "🪫", Levels: 6},
			{ID: "sys-unconscious", Name: "Беспамятство", Slug: "unconscious", Icon: "😵", Overlay: true,
				Riders: []string{"incapacitated", "prone"}},
		}},
	}
}

func tokenStatuses(r *Room) []domain.AppliedStatus {
	return r.scenes["scene-1"].Tokens["tok-1"].Statuses
}

func TestApplyStatusSnapshotsCard(t *testing.T) {
	r := testRoom()
	r.handleApplyStatus(domain.ClientMsg{Type: "apply_status", TokenID: "tok-1", StatusSlug: "Prone"})

	got := tokenStatuses(r)
	if len(got) != 1 {
		t.Fatalf("ожидалась одна метка, получено %d", len(got))
	}
	// Slug нормализуется тем же правилом, что и на карточке — "Prone" должен
	// найти карточку "prone", иначе импорт из Foundry не сойдётся с ручным
	// вводом.
	if got[0].Slug != "prone" {
		t.Errorf("slug = %q, ожидался %q", got[0].Slug, "prone")
	}
	// Имя/иконка/цвет берутся из карточки, а не от клиента.
	if got[0].Name != "Положение лёжа" || got[0].Icon != "🛌" || got[0].Color != "#a9825d" {
		t.Errorf("снимок карточки не подставлен: %+v", got[0])
	}
}

func TestApplyStatusUnknownSlugStillApplies(t *testing.T) {
	r := testRoom()
	r.handleApplyStatus(domain.ClientMsg{TokenID: "tok-1", StatusSlug: "bleeding"})

	got := tokenStatuses(r)
	if len(got) != 1 || got[0].Slug != "bleeding" {
		t.Fatalf("метка с незнакомым slug должна вешаться, получено %+v", got)
	}
	if got[0].Name != "bleeding" {
		t.Errorf("имя = %q, ожидался сам slug как запасной вариант", got[0].Name)
	}
}

func TestApplyStatusIsIdempotent(t *testing.T) {
	r := testRoom()
	three := 3
	r.handleApplyStatus(domain.ClientMsg{TokenID: "tok-1", StatusSlug: "prone"})
	r.handleApplyStatus(domain.ClientMsg{TokenID: "tok-1", StatusSlug: "prone", Rounds: &three})

	got := tokenStatuses(r)
	if len(got) != 1 {
		t.Fatalf("повторное наложение не должно плодить вторую метку, получено %d", len(got))
	}
	if got[0].Rounds != 3 {
		t.Errorf("rounds = %d, ожидалось 3 (повторное наложение правит существующую метку)", got[0].Rounds)
	}
}

func TestApplyStatusExpandsRiders(t *testing.T) {
	r := testRoom()
	r.handleApplyStatus(domain.ClientMsg{TokenID: "tok-1", StatusSlug: "unconscious"})

	got := tokenStatuses(r)
	if len(got) != 3 {
		t.Fatalf("ожидались метка + 2 зависимых, получено %d: %+v", len(got), got)
	}
	if indexOfStatus(got, "incapacitated") < 0 || indexOfStatus(got, "prone") < 0 {
		t.Errorf("зависимые состояния не развёрнуты: %+v", got)
	}
	// Снятие родителя зависимых НЕ снимает — они могли прилететь и сами по
	// себе (то же поведение, что у Foundry).
	r.handleRemoveStatus(domain.ClientMsg{TokenID: "tok-1", StatusSlug: "unconscious"})
	if len(tokenStatuses(r)) != 2 {
		t.Errorf("снятие родителя не должно снимать зависимые, осталось %+v", tokenStatuses(r))
	}
}

func TestStatusLevelClampedToCard(t *testing.T) {
	r := testRoom()
	r.handleApplyStatus(domain.ClientMsg{TokenID: "tok-1", StatusSlug: "exhaustion"})
	if got := tokenStatuses(r)[0].Level; got != 1 {
		t.Errorf("многоуровневое состояние вешается с 1-го уровня, получено %d", got)
	}

	over := 99
	r.handleSetStatusLevel(domain.ClientMsg{TokenID: "tok-1", StatusSlug: "exhaustion", Level: &over})
	if got := tokenStatuses(r)[0].Level; got != 6 {
		t.Errorf("уровень = %d, ожидался потолок карточки 6", got)
	}

	// 0 — снять метку целиком (клик по первой лампе, как у спасбросков).
	zero := 0
	r.handleSetStatusLevel(domain.ClientMsg{TokenID: "tok-1", StatusSlug: "exhaustion", Level: &zero})
	if len(tokenStatuses(r)) != 0 {
		t.Errorf("уровень 0 должен снимать метку, осталось %+v", tokenStatuses(r))
	}
}

func TestStatusLevelIgnoredForToggleCard(t *testing.T) {
	r := testRoom()
	three := 3
	r.handleApplyStatus(domain.ClientMsg{TokenID: "tok-1", StatusSlug: "prone", Level: &three})
	if got := tokenStatuses(r)[0].Level; got != 0 {
		t.Errorf("у обычного тумблера уровня быть не должно, получено %d", got)
	}
}

// Боец БЕЗ токена держит метки у себя, боец С токеном — на токене (см.
// room_statuses.go: resolveStatusTarget).
func TestStatusTargetFollowsToken(t *testing.T) {
	r := testRoom()
	r.combat.Combatants["c1"] = &domain.Combatant{ID: "c1", Name: "Без токена"}
	r.combat.Combatants["c2"] = &domain.Combatant{ID: "c2", Name: "С токеном", TokenID: "tok-1"}

	r.handleApplyStatus(domain.ClientMsg{CombatantID: "c1", StatusSlug: "prone"})
	if len(r.combat.Combatants["c1"].Statuses) != 1 {
		t.Errorf("метка бойца без токена должна лежать на нём самом")
	}
	if len(tokenStatuses(r)) != 0 {
		t.Errorf("метка бойца без токена не должна попадать на чужой токен")
	}

	r.handleApplyStatus(domain.ClientMsg{CombatantID: "c2", StatusSlug: "exhaustion"})
	if len(r.combat.Combatants["c2"].Statuses) != 0 {
		t.Errorf("у бойца с токеном собственного списка быть не должно")
	}
	if len(tokenStatuses(r)) != 1 {
		t.Errorf("метка бойца с токеном должна лечь на токен, получено %+v", tokenStatuses(r))
	}
	// Чтение идёт через ту же точку — трекер видит метки токена.
	if got := r.statusesOf(r.combat.Combatants["c2"]); len(got) != 1 {
		t.Errorf("statusesOf должен отдавать метки токена, получено %+v", got)
	}
}

func TestPlaceCombatantTokenMovesStatuses(t *testing.T) {
	r := testRoom()
	r.combat.Combatants["c1"] = &domain.Combatant{ID: "c1", Name: "Гоблин"}
	r.handleApplyStatus(domain.ClientMsg{CombatantID: "c1", StatusSlug: "prone"})

	r.handlePlaceCombatantToken("c1", 10, 20)

	cmb := r.combat.Combatants["c1"]
	if len(cmb.Statuses) != 0 {
		t.Errorf("после постановки токена собственный список бойца должен опустеть: %+v", cmb.Statuses)
	}
	tok := r.scene.Tokens[cmb.TokenID]
	if tok == nil || len(tok.Statuses) != 1 || tok.Statuses[0].Slug != "prone" {
		t.Errorf("метки должны переехать на новый токен, получено %+v", tok)
	}
}

// Длительность тикает в начале хода того, на ком метка, и только вперёд.
func TestTickStatusesOnOwnTurn(t *testing.T) {
	r := testRoom()
	r.combat.Active = true
	r.combat.Round = 1
	r.combat.Combatants["c1"] = &domain.Combatant{ID: "c1", Name: "Первый", Initiative: 20, Seq: 1, TokenID: "tok-1"}
	r.combat.Combatants["c2"] = &domain.Combatant{ID: "c2", Name: "Второй", Initiative: 10, Seq: 2}
	r.combat.CurrentID = "c1"

	one := 1
	r.handleApplyStatus(domain.ClientMsg{TokenID: "tok-1", StatusSlug: "prone", Rounds: &one})

	// Ход уходит ко второму — метка первого не трогается.
	r.handleTurnStep(1)
	if len(tokenStatuses(r)) != 1 {
		t.Fatalf("чужой ход не должен списывать длительность: %+v", tokenStatuses(r))
	}
	// Ход возвращается к первому — метка с rounds=1 истекает.
	r.handleTurnStep(1)
	if len(tokenStatuses(r)) != 0 {
		t.Errorf("метка должна была истечь в начале своего хода: %+v", tokenStatuses(r))
	}
}

func TestTickStatusesIgnoresBackwardStep(t *testing.T) {
	r := testRoom()
	r.combat.Active = true
	r.combat.Round = 2
	r.combat.Combatants["c1"] = &domain.Combatant{ID: "c1", Initiative: 20, Seq: 1, TokenID: "tok-1"}
	r.combat.Combatants["c2"] = &domain.Combatant{ID: "c2", Initiative: 10, Seq: 2}
	r.combat.CurrentID = "c2"

	two := 2
	r.handleApplyStatus(domain.ClientMsg{TokenID: "tok-1", StatusSlug: "prone", Rounds: &two})

	r.handleTurnStep(-1) // шаг назад — отмена ошибки ДМ, а не течение времени
	if got := tokenStatuses(r)[0].Rounds; got != 2 {
		t.Errorf("шаг назад не должен списывать длительность, rounds = %d", got)
	}
}

func TestPermanentStatusNeverExpires(t *testing.T) {
	r := testRoom()
	r.combat.Active = true
	r.combat.Combatants["c1"] = &domain.Combatant{ID: "c1", Initiative: 20, Seq: 1, TokenID: "tok-1"}
	r.combat.CurrentID = "c1"
	r.handleApplyStatus(domain.ClientMsg{TokenID: "tok-1", StatusSlug: "prone"}) // rounds = 0

	for i := 0; i < 5; i++ {
		r.handleTurnStep(1)
	}
	if len(tokenStatuses(r)) != 1 {
		t.Errorf("метка с rounds=0 висит, пока ДМ её не снимет")
	}
}

func TestClearStatuses(t *testing.T) {
	r := testRoom()
	r.handleApplyStatus(domain.ClientMsg{TokenID: "tok-1", StatusSlug: "prone"})
	r.handleApplyStatus(domain.ClientMsg{TokenID: "tok-1", StatusSlug: "exhaustion"})
	r.handleClearStatuses(domain.ClientMsg{TokenID: "tok-1"})
	if len(tokenStatuses(r)) != 0 {
		t.Errorf("«Снять все» должно очищать список: %+v", tokenStatuses(r))
	}
}

func TestHiddenStatusesCutForPlayers(t *testing.T) {
	r := testRoom()
	hidden := true
	r.handleApplyStatus(domain.ClientMsg{TokenID: "tok-1", StatusSlug: "prone"})
	r.handleApplyStatus(domain.ClientMsg{TokenID: "tok-1", StatusSlug: "exhaustion", Hidden: &hidden})

	if got := publicStatuses(tokenStatuses(r), true); len(got) != 2 {
		t.Errorf("ДМ видит все метки, получено %d", len(got))
	}
	got := publicStatuses(tokenStatuses(r), false)
	if len(got) != 1 || got[0].Slug != "prone" {
		t.Errorf("скрытая метка не должна уходить игроку: %+v", got)
	}
	// Токен для игрока — копия: вырезание не должно портить состояние комнаты.
	pub := publicToken(r.scene.Tokens["tok-1"])
	if len(pub.Statuses) != 1 {
		t.Errorf("publicToken должен отдавать отфильтрованный список, получено %+v", pub.Statuses)
	}
	if len(tokenStatuses(r)) != 2 {
		t.Errorf("исходный токен комнаты не должен меняться: %+v", tokenStatuses(r))
	}
}

func TestStatusOnMissingTargetIsNoop(t *testing.T) {
	r := testRoom()
	r.handleApplyStatus(domain.ClientMsg{TokenID: "нет-такого", StatusSlug: "prone"})
	r.handleApplyStatus(domain.ClientMsg{CombatantID: "нет-такого", StatusSlug: "prone"})
	r.handleApplyStatus(domain.ClientMsg{StatusSlug: "prone"}) // цель не указана вовсе
	if len(tokenStatuses(r)) != 0 {
		t.Errorf("команда без валидной цели ничего не должна менять: %+v", tokenStatuses(r))
	}
}
