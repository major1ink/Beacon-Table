// room_drawings.go — слой пометок поверх сцены (domain.Drawing): стрелка
// «обходим слева», круг вокруг двери, подпись «здесь ловушка». Отдельный
// файл по той же причине, что и room_statuses.go, — механика
// самодостаточная и завязана только на r.scene/r.combat.
//
// Всё, что здесь происходит, выполняется в горутине Room.run().
//
// ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ ОСТАЛЬНЫХ ОБЪЕКТОВ СЦЕНЫ. Стены, туман и здания
// правит только ДМ, поэтому им хватает общего applyMutation, который вообще
// не знает отправителя. Пометки — первая правка сцены, доступная игроку
// (см. Room.authorize), поэтому у них свои обработчики с клиентом на входе:
// автора проставляет сервер, чужой элемент игроку не отдаётся ни на правку,
// ни на удаление.
package service

import (
	"strings"

	"beacon-table/internal/domain"
)

// maxDrawingsPerScene — сколько пометок максимум живёт на одной сцене.
// Не игровое правило, а защита от «залипшего» клиента: слой рисуется
// целиком на каждый кадр (см. web/src/vtt/layers/drawings.js), и бесконечно
// растущая карта элементов посадила бы кадр у всех за столом.
const maxDrawingsPerScene = 500

// maxDrawingPoints — предел точек в одной кривой свободной кисти. Клиент
// прореживает точки при рисовании (см. interaction.js), так что до предела
// доходит только ненормально длинный росчерк.
const maxDrawingPoints = 2000

// maxDrawingTextLen — предел подписи (Drawing.Text): текст со стороны
// недоверенного клиента, как Label у "roll_dice".
const maxDrawingTextLen = 200

// drawingKinds — формы, которые сервер принимает (см. domain.Drawing.Kind).
// Значение — сколько точек обязано быть у формы; 0 — «сколько угодно, но
// хотя бы две» (свободная кисть).
var drawingKinds = map[string]int{"free": 0, "line": 2, "arrow": 2, "rect": 2, "circle": 2, "text": 1}

// validDrawing проверяет присланный элемент целиком: форма из списка,
// точек ровно столько, сколько форма требует, текст непустой у подписи.
// Автор/цвет тут не смотрим — их разбирает handleAddDrawing.
func validDrawing(d *domain.Drawing) bool {
	if d == nil || d.ID == "" {
		return false
	}
	want, ok := drawingKinds[d.Kind]
	if !ok {
		return false
	}
	if want == 0 && (len(d.Points) < 2 || len(d.Points) > maxDrawingPoints) {
		return false
	}
	if want != 0 && len(d.Points) != want {
		return false
	}
	if d.Kind == "text" && strings.TrimSpace(d.Text) == "" {
		return false
	}
	return true
}

// sanitizeDrawingColor — цвет только в виде "#rrggbb"; всё остальное
// (включая пустую строку) отбрасывается в "", и клиент подставляет цвет
// автора сам (см. web/src/vtt/layers/drawings.js: colorForAuthor).
func sanitizeDrawingColor(c string) string {
	if len(c) != 7 || c[0] != '#' {
		return ""
	}
	for i := 1; i < 7; i++ {
		ch := c[i]
		hex := ch >= '0' && ch <= '9' || ch >= 'a' && ch <= 'f' || ch >= 'A' && ch <= 'F'
		if !hex {
			return ""
		}
	}
	return strings.ToLower(c)
}

// canDrawingWrite — можно ли этому клиенту создать/править/удалить пометку.
// existing — то, что уже лежит на сцене под этим ID (nil, если элемент
// новый). ДМ может всё; игрок — только пока включён тумблер стола и только
// свои элементы (по AuthorID, который проставлял сервер).
func (r *Room) canDrawingWrite(c RoomClient, existing *domain.Drawing) bool {
	if c.Role() == domain.RoleDM {
		return true
	}
	if c.Role() != domain.RolePlayer || !r.combat.PlayerDrawingEnabled {
		return false
	}
	if c.PlayerID() == "" {
		return false
	}
	return existing == nil || existing.AuthorID == c.PlayerID()
}

// handleAddDrawing — "add_drawing": апсерт элемента по ID (тем же приёмом,
// что "add_fog_area" — правка существующей фигуры идёт тем же сообщением,
// что и создание). Автора ставит сервер по отправителю, клиентские
// AuthorID/AuthorName игнорируются.
func (r *Room) handleAddDrawing(c RoomClient, msg domain.ClientMsg) {
	d := msg.Drawing
	if !validDrawing(d) {
		return
	}
	if r.scene.Drawings == nil {
		r.scene.Drawings = make(map[string]*domain.Drawing)
	}
	existing := r.scene.Drawings[d.ID]
	if !r.canDrawingWrite(c, existing) {
		return
	}
	if existing == nil && len(r.scene.Drawings) >= maxDrawingsPerScene {
		return
	}

	authorID := ""
	authorName := "ДМ"
	if c.Role() == domain.RolePlayer {
		authorID = c.PlayerID()
		authorName = c.PlayerName()
	}
	// Автор элемента не меняется при правке — иначе ДМ, подвинувший чужую
	// стрелку, «присвоил» бы её себе и игрок потерял бы право её стереть.
	if existing != nil {
		authorID = existing.AuthorID
		authorName = existing.AuthorName
	}

	text := d.Text
	if len(text) > maxDrawingTextLen {
		text = text[:maxDrawingTextLen]
	}
	width := d.Width
	if width <= 0 || width > 200 {
		width = 0 // клиент подставит свой дефолт
	}

	r.scene.Drawings[d.ID] = &domain.Drawing{
		ID:         d.ID,
		Kind:       d.Kind,
		Points:     d.Points,
		Text:       text,
		Color:      sanitizeDrawingColor(d.Color),
		Width:      width,
		AuthorID:   authorID,
		AuthorName: authorName,
	}
	r.markDirty(r.currentSceneID)
	r.broadcastAll()
}

// handleRemoveDrawing — "remove_drawing": ДМ стирает любую пометку, игрок —
// только свою.
func (r *Room) handleRemoveDrawing(c RoomClient, msg domain.ClientMsg) {
	existing := r.scene.Drawings[msg.ID]
	if existing == nil || !r.canDrawingWrite(c, existing) {
		return
	}
	delete(r.scene.Drawings, msg.ID)
	r.markDirty(r.currentSceneID)
	r.broadcastAll()
}

// handleClearDrawings — "clear_drawings" (только ДМ, см. authorize):
// очистить слой активной сцены целиком.
func (r *Room) handleClearDrawings() {
	if len(r.scene.Drawings) == 0 {
		return
	}
	r.scene.Drawings = make(map[string]*domain.Drawing)
	r.markDirty(r.currentSceneID)
	r.broadcastAll()
}

// handleSetPlayerDrawingEnabled — "set_player_drawing_enabled": общий
// тумблер стола, могут ли игроки рисовать (см.
// domain.CombatState.PlayerDrawingEnabled, combatPayload).
func (r *Room) handleSetPlayerDrawingEnabled(v bool) {
	r.combat.PlayerDrawingEnabled = v
	r.markCombatDirty()
	r.broadcastCombat()
}

// handleSetHidePlayerDrawings — "set_hide_player_drawings": общий тумблер
// стола, прятать ли пометки игроков (см.
// domain.CombatState.HidePlayerDrawings, combatPayload).
func (r *Room) handleSetHidePlayerDrawings(v bool) {
	r.combat.HidePlayerDrawings = v
	r.markCombatDirty()
	r.broadcastCombat()
}
