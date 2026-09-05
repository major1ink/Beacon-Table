package service

import (
	"strings"
	"testing"

	"beacon-table/internal/domain"
)

// Тесты собирают *Room напрямую, без actor-горутины — тот же приём и по той
// же причине, что и в room_statuses_test.go.

// drawClient — минимальный RoomClient: роль и id, больше обработчикам
// пометок ничего от клиента не нужно.
type drawClient struct {
	role     domain.ClientRole
	playerID string
	name     string
}

func (c *drawClient) Send(payload any)        {}
func (c *drawClient) Close()                  {}
func (c *drawClient) Role() domain.ClientRole { return c.role }
func (c *drawClient) PlayerID() string        { return c.playerID }
func (c *drawClient) PlayerName() string      { return c.name }

func drawingsRoom() *Room {
	scene := domain.NewScene("scene-1", "Тест")
	return &Room{
		scenes:         map[string]*domain.SceneState{"scene-1": scene},
		sceneOrder:     []string{"scene-1"},
		currentSceneID: "scene-1",
		scene:          scene,
		clients:        map[RoomClient]bool{},
		dirtyScenes:    map[string]bool{},
		combat:         domain.NewCombatState(),
		hub:            domain.NewLootHub(),
	}
}

func addDrawingMsg(id, kind string) domain.ClientMsg {
	return domain.ClientMsg{
		Type:    "add_drawing",
		Drawing: &domain.Drawing{ID: id, Kind: kind, Points: []domain.Point{{X: 1, Y: 2}, {X: 30, Y: 40}}},
	}
}

var (
	dmClient     = &drawClient{role: domain.RoleDM}
	playerClient = &drawClient{role: domain.RolePlayer, playerID: "acc-1", name: "Валера"}
	otherPlayer  = &drawClient{role: domain.RolePlayer, playerID: "acc-2", name: "Гость"}
	tvClient     = &drawClient{role: domain.RoleTV}
)

func TestDMDrawsAndServerStampsAuthor(t *testing.T) {
	r := drawingsRoom()
	r.handleAddDrawing(dmClient, addDrawingMsg("d1", "arrow"))

	got := r.scene.Drawings["d1"]
	if got == nil {
		t.Fatal("пометка ДМ не сохранилась")
	}
	if got.AuthorID != "" || got.AuthorName != "ДМ" {
		t.Errorf("автор = %q/%q, ожидался пустой id и «ДМ»", got.AuthorID, got.AuthorName)
	}
}

func TestPlayerDrawingNeedsTableToggle(t *testing.T) {
	r := drawingsRoom()
	r.handleAddDrawing(playerClient, addDrawingMsg("d1", "line"))
	if len(r.scene.Drawings) != 0 {
		t.Fatal("игрок нарисовал при выключенном тумблере стола")
	}

	r.combat.PlayerDrawingEnabled = true
	r.handleAddDrawing(playerClient, addDrawingMsg("d1", "line"))
	got := r.scene.Drawings["d1"]
	if got == nil {
		t.Fatal("игрок не смог нарисовать при включённом тумблере")
	}
	// Автора ставит сервер, а не клиент — по нему решается, чей это элемент.
	if got.AuthorID != "acc-1" || got.AuthorName != "Валера" {
		t.Errorf("автор = %q/%q, ожидался acc-1/Валера", got.AuthorID, got.AuthorName)
	}
}

func TestPlayerCannotTouchOthersDrawings(t *testing.T) {
	r := drawingsRoom()
	r.combat.PlayerDrawingEnabled = true
	r.handleAddDrawing(playerClient, addDrawingMsg("d1", "line"))

	// Чужой игрок не может ни переписать элемент, ни стереть его.
	r.handleAddDrawing(otherPlayer, domain.ClientMsg{
		Type:    "add_drawing",
		Drawing: &domain.Drawing{ID: "d1", Kind: "circle", Points: []domain.Point{{}, {X: 5}}},
	})
	if r.scene.Drawings["d1"].Kind != "line" {
		t.Error("чужой игрок переписал пометку")
	}
	r.handleRemoveDrawing(otherPlayer, domain.ClientMsg{Type: "remove_drawing", ID: "d1"})
	if r.scene.Drawings["d1"] == nil {
		t.Error("чужой игрок стёр пометку")
	}

	// Свою — может.
	r.handleRemoveDrawing(playerClient, domain.ClientMsg{Type: "remove_drawing", ID: "d1"})
	if r.scene.Drawings["d1"] != nil {
		t.Error("игрок не смог стереть свою пометку")
	}
}

func TestDMEditKeepsOriginalAuthor(t *testing.T) {
	r := drawingsRoom()
	r.combat.PlayerDrawingEnabled = true
	r.handleAddDrawing(playerClient, addDrawingMsg("d1", "line"))
	r.handleAddDrawing(dmClient, addDrawingMsg("d1", "arrow"))

	got := r.scene.Drawings["d1"]
	if got.Kind != "arrow" {
		t.Error("ДМ не смог поправить пометку игрока")
	}
	// Иначе ДМ, тронувший чужую стрелку, «присвоил» бы её и игрок потерял бы
	// право её стереть.
	if got.AuthorID != "acc-1" {
		t.Errorf("автор после правки ДМ = %q, ожидался acc-1", got.AuthorID)
	}
}

func TestDrawingValidation(t *testing.T) {
	r := drawingsRoom()
	bad := []domain.ClientMsg{
		{Type: "add_drawing", Drawing: nil},
		{Type: "add_drawing", Drawing: &domain.Drawing{ID: "", Kind: "line", Points: []domain.Point{{}, {}}}},
		{Type: "add_drawing", Drawing: &domain.Drawing{ID: "d", Kind: "спираль", Points: []domain.Point{{}, {}}}},
		{Type: "add_drawing", Drawing: &domain.Drawing{ID: "d", Kind: "line", Points: []domain.Point{{}}}},
		{Type: "add_drawing", Drawing: &domain.Drawing{ID: "d", Kind: "free", Points: []domain.Point{{}}}},
		{Type: "add_drawing", Drawing: &domain.Drawing{ID: "d", Kind: "text", Points: []domain.Point{{}}, Text: "  "}},
	}
	for i, msg := range bad {
		r.handleAddDrawing(dmClient, msg)
		if len(r.scene.Drawings) != 0 {
			t.Fatalf("случай %d: негодная пометка сохранилась", i)
		}
	}
}

func TestDrawingColorAndTextAreSanitized(t *testing.T) {
	r := drawingsRoom()
	r.handleAddDrawing(dmClient, domain.ClientMsg{
		Type: "add_drawing",
		Drawing: &domain.Drawing{
			ID: "d1", Kind: "text", Points: []domain.Point{{}},
			Text: strings.Repeat("я", maxDrawingTextLen*2), Color: "javascript:alert(1)",
		},
	})
	got := r.scene.Drawings["d1"]
	if got.Color != "" {
		t.Errorf("цвет = %q, ожидалось отбрасывание мусора", got.Color)
	}
	if len(got.Text) > maxDrawingTextLen {
		t.Errorf("длина текста = %d, ожидалось не больше %d", len(got.Text), maxDrawingTextLen)
	}

	r.handleAddDrawing(dmClient, domain.ClientMsg{
		Type:    "add_drawing",
		Drawing: &domain.Drawing{ID: "d2", Kind: "line", Points: []domain.Point{{}, {X: 9}}, Color: "#FF7B72"},
	})
	if r.scene.Drawings["d2"].Color != "#ff7b72" {
		t.Errorf("цвет = %q, ожидался #ff7b72", r.scene.Drawings["d2"].Color)
	}
}

func TestClearDrawings(t *testing.T) {
	r := drawingsRoom()
	r.handleAddDrawing(dmClient, addDrawingMsg("d1", "line"))
	r.handleAddDrawing(dmClient, addDrawingMsg("d2", "rect"))
	r.handleClearDrawings()
	if len(r.scene.Drawings) != 0 {
		t.Errorf("после очистки осталось %d пометок", len(r.scene.Drawings))
	}
}

func TestDrawingsAuthorization(t *testing.T) {
	r := drawingsRoom()
	for _, msgType := range []string{"add_drawing", "remove_drawing"} {
		if !r.authorize(playerClient, msgType) {
			t.Errorf("игроку не положен %q", msgType)
		}
		if r.authorize(tvClient, msgType) {
			t.Errorf("трансляции не должен быть положен %q", msgType)
		}
	}
	// Очистка слоя — только ДМ: игроку этот тип вообще не проходит authorize.
	if r.authorize(playerClient, "clear_drawings") {
		t.Error("игроку не должна быть положена очистка слоя")
	}
}
