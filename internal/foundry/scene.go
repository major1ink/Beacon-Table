package foundry

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strings"

	"beacon-table/internal/domain"
)

// MapScene переводит документ Scene из компендиума в нашу сцену
// (domain.SceneState) и попутно переносит из архива фон карты, арт токенов и
// амбиент-трек.
//
// Почему на сервере, а не на клиенте, как карточки: сцена — не «умный
// бланк», который ДМ потом правит руками, а геометрия (стены, свет,
// координаты), которую надо положить в Room целиком и сразу, вместе с
// файлами. Клиентского маппера для неё нет и не планируется.
//
// Что переносится и что теряется:
//
//   - фон, размер холста, сетка (размер/цвет/прозрачность/единицы) — как есть;
//   - стены: отрезок, дверь (обычная/секретная) и её состояние, «окно» —
//     сегмент, который не блокирует обзор (у Foundry это sight: NONE);
//   - источники света Foundry — «токенами света» (domain.Token.LightOnly):
//     отдельной сущности под ambient light у нас нет, а лампочка-токен даёт
//     ровно то же самое на карте;
//   - расставленные токены — арт, имя, размер, скрытость и id актёра, которого
//     токен изображал (domain.Token.FoundryActorID). Сам статблок в этот
//     момент подставить нельзя: карточки бестиария приезжают ОТДЕЛЬНЫМ паком,
//     возможно уже после сцены, — поэтому id сохраняется как якорь, а связь
//     (Token.MonsterID) дописывается потом проходом
//     service.FoundryService.LinkSceneTokens. Ничего не угадывается по имени:
//     сводятся ровно одинаковые id;
//   - гексагональная сетка ложится квадратной (гексов у нас нет), плитки
//     (tiles), рисунки (drawings) и шаблоны эффектов не переносятся вовсе —
//     кроме плиток-этажей модуля Levels, см. MapScenes;
//   - значки на карте (notes) — в domain.NoteMarker, если ix знает, куда
//     приехала запись, на которую значок ссылается (см. mapNoteMarker).
//
// ix — индекс перекрёстных ссылок модуля (см. LinkIndex): нужен только для
// значков, для остального можно передать nil.
func MapScene(ctx context.Context, d Doc, assets *Assets, ix *LinkIndex) *domain.SceneState {
	return mapScene(ctx, d, assets, ix, nil)
}

// MapScenes — то же, но сцена с этажами модуля Levels (flags.levels.
// sceneLevels) раскладывается в несколько наших сцен одного здания
// (domain.SceneState.Building): у каждого этажа своя карта, стены, свет и
// токены по своему диапазону высот. Без этажей — одна сцена, как MapScene.
//
// Что переносится по этажам и как:
//
//   - карта этажа — самая большая плитка (tiles) с flags.levels.rangeBottom/
//     rangeTop внутри диапазона этажа; холст этажа = размер плитки, геометрия
//     сдвигается к её углу. Этаж без плитки, содержащий высоту фона (обычно
//     земля), берёт фон сцены; прочие без плитки остаются без карты, но со
//     стенами. Этаж, склеенный из нескольких плиток, переедет одной —
//     плитки как сущность мы всё ещё не импортируем;
//   - стены — по flags.wall-height.top/bottom (нет флага — на всех этажах);
//   - токены — по elevation; свет — по flags.levels.rangeBottom/rangeTop
//     (нет — на всех); значки — только на этаже с фоном.
func MapScenes(ctx context.Context, d Doc, assets *Assets, ix *LinkIndex) []*domain.SceneState {
	levels := sceneLevels(d)
	if len(levels) < 2 {
		return []*domain.SceneState{mapScene(ctx, d, assets, ix, nil)}
	}
	out := make([]*domain.SceneState, 0, len(levels))
	for i := range levels {
		out = append(out, mapScene(ctx, d, assets, ix, &levels[i]))
	}
	return out
}

// levelRange — этаж модуля Levels: диапазон высот и имя; Floor — порядковый
// номер снизу, Ground — этаж, которому достаётся фон сцены.
type levelRange struct {
	bottom, top float64
	name        string
	floor       int
	ground      bool
}

// sceneLevels — flags.levels.sceneLevels: [[низ, верх, имя], …] (числа
// приезжают и строками). Сортируются по низу; нулевой этаж — тот, что
// содержит высоту 0, иначе самый нижний.
func sceneLevels(d Doc) []levelRange {
	var out []levelRange
	for _, raw := range asSlice(dig(d, "flags", "levels", "sceneLevels")) {
		row := asSlice(raw)
		if len(row) < 2 {
			continue
		}
		lv := levelRange{bottom: num(row[0], 0), top: num(row[1], 0)}
		if len(row) > 2 {
			lv.name = strings.TrimSpace(asString(row[2]))
		}
		if lv.top <= lv.bottom {
			continue
		}
		out = append(out, lv)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].bottom < out[j].bottom })
	ground := -1
	for i, lv := range out {
		if lv.bottom <= 0 && 0 < lv.top {
			ground = i
			break
		}
	}
	if ground < 0 && len(out) > 0 {
		ground = 0
	}
	for i := range out {
		out[i].floor = i - ground
		out[i].ground = i == ground
		if out[i].name == "" {
			out[i].name = fmt.Sprintf("Этаж %d", out[i].floor)
		}
	}
	return out
}

// within — диапазон [lo, hi] объекта пересекается с этажом; отсутствующие
// границы — бесконечность (объект на всех этажах).
func (lv *levelRange) within(lo, hi any) bool {
	if lv == nil {
		return true
	}
	bottom, top := math.Inf(-1), math.Inf(1)
	if lo != nil {
		bottom = num(lo, bottom)
	}
	if hi != nil {
		top = num(hi, top)
	}
	return bottom < lv.top && top > lv.bottom
}

// levelTile — самая большая плитка этажа: сначала целиком внутри диапазона,
// иначе пересекающая его.
func levelTile(d Doc, lv *levelRange) map[string]any {
	var best map[string]any
	bestArea, bestInside := 0.0, false
	for _, raw := range asSlice(d["tiles"]) {
		t := asMap(raw)
		if t == nil {
			continue
		}
		lo, hi := dig(t, "flags", "levels", "rangeBottom"), dig(t, "flags", "levels", "rangeTop")
		if lo == nil && hi == nil {
			continue // плитка без этажа — декорация, не карта этажа
		}
		if !lv.within(lo, hi) {
			continue
		}
		inside := num(lo, math.Inf(-1)) >= lv.bottom && num(hi, math.Inf(1)) <= lv.top
		area := num(t["width"], 0) * num(t["height"], 0)
		if best == nil || (inside && !bestInside) || (inside == bestInside && area > bestArea) {
			best, bestArea, bestInside = t, area, inside
		}
	}
	return best
}

func mapScene(ctx context.Context, d Doc, assets *Assets, ix *LinkIndex, lv *levelRange) *domain.SceneState {
	name := strings.TrimSpace(asString(d["name"]))
	if name == "" {
		name = "Сцена из Foundry"
	}
	building := name
	if lv != nil {
		name = name + " — " + lv.name
	}
	s := domain.NewScene(newID(), name)
	if lv != nil {
		s.Building = building
		s.Floor = lv.floor
	}

	width := digNum(d, 0, "width")
	height := digNum(d, 0, "height")
	if width > 0 && height > 0 {
		s.Width, s.Height = width, height
	}

	gridSize, gridType := sceneGrid(d)
	// Padding: у Foundry холст шире карты на поля, и координаты стен/токенов
	// отсчитываются от края ПОЛЕЙ, а не от края картинки. У нас полей нет —
	// вычитаем сдвиг, иначе вся геометрия уедет вправо-вниз.
	padding := digNum(d, 0, "padding")
	offsetX, offsetY := 0.0, 0.0
	if padding > 0 && gridSize > 0 {
		offsetX = math.Ceil(padding*s.Width/gridSize) * gridSize
		offsetY = math.Ceil(padding*s.Height/gridSize) * gridSize
	}
	offsetX += digNum(d, 0, "background", "offsetX")
	offsetY += digNum(d, 0, "background", "offsetY")

	// Карта этажа — плитка: холст этажа = плитка, геометрия — от её угла
	// (координаты плиток и стен у Foundry в одном пространстве холста с
	// полями, поэтому padding тут не вычитается).
	var tile map[string]any
	if lv != nil {
		tile = levelTile(d, lv)
	}
	if tile != nil {
		if tw, th := num(tile["width"], 0), num(tile["height"], 0); tw > 0 && th > 0 {
			s.Width, s.Height = tw, th
		}
		offsetX, offsetY = num(tile["x"], 0), num(tile["y"], 0)
	}

	if gridType == 0 {
		s.Grid.Size = 0 // "gridless" в Foundry — сетки нет, привязки нет
	} else {
		s.Grid.Size = gridSize
	}
	s.Grid.UnitsPerCell = digNum(d, digNum(d, 5, "gridDistance"), "grid", "distance")
	if unit := firstNonEmpty(digString(d, "grid", "units"), asString(d["gridUnits"])); unit != "" {
		s.Grid.Unit = unit
	}
	if color := firstNonEmpty(digString(d, "grid", "color"), asString(d["gridColor"])); color != "" {
		s.Grid.LineColor = color
	}
	s.Grid.LineOpacity = digNum(d, digNum(d, 0.5, "gridAlpha"), "grid", "alpha")

	switch {
	case tile != nil:
		s.MapURL = assets.URL(ctx, domain.AssetKindMaps, firstNonEmpty(digString(tile, "texture", "src"), asString(tile["img"])))
	case lv == nil || lv.ground:
		s.MapURL = assets.URL(ctx, domain.AssetKindMaps, firstNonEmpty(digString(d, "background", "src"), asString(d["img"])))
	}
	// Амбиент — только нулевому этажу: остальные наследуют его в комнате
	// (см. service.Room.ambientOf), дублировать трек по этажам незачем.
	if ambient := firstNonEmpty(digString(d, "playlistSound", "path"), asString(d["ambient"])); ambient != "" && (lv == nil || lv.ground) {
		s.AmbientURL = assets.URL(ctx, domain.AssetKindAudio, ambient)
	}

	// tokenVision=false в Foundry — «все всё видят»: ближайший аналог у нас
	// — выключенный туман войны.
	if d["tokenVision"] != nil && !asBool(d["tokenVision"]) {
		off := false
		s.FogOfWar = &off
	}
	if sceneGlobalLight(d) {
		s.GlobalLight = "bright"
	}

	for _, raw := range asSlice(d["walls"]) {
		m := asMap(raw)
		if !lv.within(dig(m, "flags", "wall-height", "bottom"), dig(m, "flags", "wall-height", "top")) {
			continue
		}
		if w := mapWall(m, offsetX, offsetY); w != nil {
			s.Walls[w.ID] = w
		}
	}
	for _, raw := range asSlice(d["lights"]) {
		m := asMap(raw)
		if !lv.within(dig(m, "flags", "levels", "rangeBottom"), dig(m, "flags", "levels", "rangeTop")) {
			continue
		}
		if t := mapLight(m, offsetX, offsetY, s.Grid.Size); t != nil {
			s.Tokens[t.ID] = t
		}
	}
	for _, raw := range asSlice(d["tokens"]) {
		m := asMap(raw)
		if lv != nil {
			e := num(m["elevation"], 0)
			if e < lv.bottom || e >= lv.top {
				continue
			}
		}
		if t := mapToken(ctx, m, offsetX, offsetY, gridSize, assets); t != nil {
			s.Tokens[t.ID] = t
		}
	}
	if lv == nil || lv.ground {
		for _, raw := range asSlice(d["notes"]) {
			if nm := mapNoteMarker(asMap(raw), offsetX, offsetY, ix); nm != nil {
				s.NoteMarkers[nm.ID] = nm
			}
		}
	}
	return s
}

// mapNoteMarker — значок на карте Foundry (Note) в domain.NoteMarker. Note
// ссылается на запись журнала (entryId) и, необязательно, на её страницу
// (pageId). У нас запись журнала — это заметка, а страница — раздел внутри
// неё (см. MapJournal), поэтому значок ведём на заметку и запоминаем раздел.
//
// Резолв — по индексу модуля: если записи, на которую ссылается значок, в
// импорте нет (значок вёл на документ мира или другого модуля), значок
// пропускаем — «свиток в никуда» на карте бесполезен. Настоящий id заметки
// на этом этапе неизвестен (её заводит клиент, и в заметки ДМ либо в журнал
// стола — по галочке ДМ), поэтому кладём имя записи и папку «якорем», а
// связывание с реальной заметкой оставляем клиенту на первый клик (см.
// domain.NoteMarker.FoundryEntry).
func mapNoteMarker(n map[string]any, offsetX, offsetY float64, ix *LinkIndex) *domain.NoteMarker {
	if n == nil || ix == nil {
		return nil
	}
	target, ok := ix.Lookup(asString(n["pageId"]))
	if !ok {
		target, ok = ix.Lookup(asString(n["entryId"]))
	}
	if !ok || target.Kind != "note" {
		return nil
	}
	label := strings.TrimSpace(asString(n["text"]))
	if label == "" {
		label = firstNonEmpty(target.Section, target.Name)
	}
	return &domain.NoteMarker{
		ID:            newID(),
		Label:         label,
		Section:       target.Section,
		X:             num(n["x"], 0) - offsetX,
		Y:             num(n["y"], 0) - offsetY,
		FoundryEntry:  target.Name,
		FoundryFolder: target.Folder,
	}
}

// sceneGrid — размер клетки и тип сетки с учётом переезда полей в v10:
// раньше grid был числом, а тип/единицы лежали рядом, теперь всё в объекте.
func sceneGrid(d Doc) (size float64, gridType int) {
	if g := asMap(d["grid"]); g != nil {
		return num(g["size"], 100), int(num(g["type"], 1))
	}
	return num(d["grid"], 100), int(num(d["gridType"], 1))
}

// sceneGlobalLight — «вся карта освещена». v12 унёс флаг в environment,
// до этого он лежал на самой сцене.
func sceneGlobalLight(d Doc) bool {
	if env := asMap(d["environment"]); env != nil {
		if gl := asMap(env["globalLight"]); gl != nil {
			return asBool(gl["enabled"])
		}
	}
	return asBool(d["globalLight"])
}

func mapWall(w map[string]any, offsetX, offsetY float64) *domain.Wall {
	if w == nil {
		return nil
	}
	c := asSlice(w["c"])
	if len(c) < 4 {
		return nil
	}
	wall := &domain.Wall{
		ID: newID(),
		X1: num(c[0], 0) - offsetX,
		Y1: num(c[1], 0) - offsetY,
		X2: num(c[2], 0) - offsetX,
		Y2: num(c[3], 0) - offsetY,
	}
	switch int(num(w["door"], 0)) {
	case 1:
		wall.Door = "door"
	case 2:
		wall.Door = "secret"
	}
	if wall.Door != "" {
		switch int(num(w["ds"], 0)) {
		case 1:
			wall.DoorState = "open"
		case 2:
			wall.DoorState = "locked"
		default:
			wall.DoorState = "closed"
		}
	} else {
		wall.Window = !restricts(w["sight"])
		wall.LightThrough = !restricts(w["light"])
	}
	return wall
}

func restricts(v any) bool {
	if v == nil {
		return true
	}
	return num(v, 20) >= 20
}

// mapLight — источник света Foundry в «токен света». Радиусы у Foundry уже
// в единицах линейки сцены (футы), у нас Token.Light тоже — пересчёт не
// нужен, в отличие от координат.
func mapLight(l map[string]any, offsetX, offsetY, gridSize float64) *domain.Token {
	if l == nil {
		return nil
	}
	cfg := asMap(l["config"])
	bright := num(l["bright"], 0)
	dim := num(l["dim"], 0)
	color := asString(l["tintColor"])
	if cfg != nil {
		bright = num(cfg["bright"], bright)
		dim = num(cfg["dim"], dim)
		if c := asString(cfg["color"]); c != "" {
			color = c
		}
	}
	if bright <= 0 && dim <= 0 {
		return nil
	}
	// Конус: у Foundry angle — та же ширина сектора в градусах, rotation —
	// поворот, и отсчёт у обоих совпадает с нашим (0° вверх, по часовой),
	// см. domain.TokenLight.
	angle := num(l["angle"], 0)
	if angle >= 360 {
		angle = 0
	}
	size := gridSize / 2
	if size <= 0 {
		size = 24
	}
	return &domain.Token{
		ID:        newID(),
		X:         num(l["x"], 0) - offsetX,
		Y:         num(l["y"], 0) - offsetY,
		Size:      size,
		Color:     "#ffcc66",
		LightOnly: true,
		Light: &domain.TokenLight{
			Enabled:   !asBool(l["hidden"]),
			Bright:    bright,
			Dim:       dim,
			Color:     color,
			Angle:     angle,
			Direction: num(l["rotation"], 0),
		},
	}
}

// mapToken — расставленная на карте фигурка. У Foundry x/y — левый верхний
// угол, у нас — центр (см. web/src/vtt/layers/tokens.js), поэтому сдвигаем
// на половину размера.
func mapToken(ctx context.Context, t map[string]any, offsetX, offsetY, gridSize float64, assets *Assets) *domain.Token {
	if t == nil {
		return nil
	}
	cells := num(t["width"], 1)
	if cells <= 0 {
		cells = 1
	}
	if gridSize <= 0 {
		gridSize = 100
	}
	art := firstNonEmpty(digString(t, "texture", "src"), asString(t["img"]))
	return &domain.Token{
		ID:    newID(),
		X:     num(t["x"], 0) - offsetX + cells*gridSize/2,
		Y:     num(t["y"], 0) - offsetY + num(t["height"], cells)*gridSize/2,
		Size:  cells * gridSize / 2,
		Color: "#888888",
		Label: asString(t["name"]),
		Image: assets.URL(ctx, domain.AssetKindTokens, art),
		// В Foundry токен на сцене — это ВСЕГДА размещение актёра (декорации
		// там отдельная сущность, tiles, которую мы не импортируем вовсе).
		// Значит, всё, что сюда приезжает, — существа, и статблок им положен.
		// Прямо сейчас его взять неоткуда (актёры лежат в другом паке, см.
		// domain.Token.FoundryActorID), поэтому сохраняем якорь и оставляем
		// связывание на потом.
		FoundryActorID: firstNonEmpty(asString(t["actorId"]), digString(t, "delta", "_id")),
		Hidden:         asBool(t["hidden"]),
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
