package foundry

import (
	"context"
	"math"
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
//   - расставленные токены — арт, имя, размер, скрытость. Связь с актёром
//     (и, значит, статблок) не переносится: карточки бестиария импортируются
//     отдельным паком и своими id, угадывать соответствие мы не беремся;
//   - гексагональная сетка ложится квадратной (гексов у нас нет), плитки
//     (tiles), рисунки (drawings) и шаблоны эффектов не переносятся вовсе.
func MapScene(ctx context.Context, d Doc, assets *Assets) *domain.SceneState {
	name := strings.TrimSpace(asString(d["name"]))
	if name == "" {
		name = "Сцена из Foundry"
	}
	s := domain.NewScene(newID(), name)

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

	s.MapURL = assets.URL(ctx, domain.AssetKindMaps, firstNonEmpty(digString(d, "background", "src"), asString(d["img"])))
	if ambient := firstNonEmpty(digString(d, "playlistSound", "path"), asString(d["ambient"])); ambient != "" {
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
		if w := mapWall(asMap(raw), offsetX, offsetY); w != nil {
			s.Walls[w.ID] = w
		}
	}
	for _, raw := range asSlice(d["lights"]) {
		if t := mapLight(asMap(raw), offsetX, offsetY, s.Grid.Size); t != nil {
			s.Tokens[t.ID] = t
		}
	}
	for _, raw := range asSlice(d["tokens"]) {
		if t := mapToken(ctx, asMap(raw), offsetX, offsetY, gridSize, assets); t != nil {
			s.Tokens[t.ID] = t
		}
	}
	return s
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
	if cfg != nil {
		bright = num(cfg["bright"], bright)
		dim = num(cfg["dim"], dim)
	}
	if bright <= 0 && dim <= 0 {
		return nil
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
		Light:     &domain.TokenLight{Enabled: !asBool(l["hidden"]), Bright: bright, Dim: dim},
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
		ID:     newID(),
		X:      num(t["x"], 0) - offsetX + cells*gridSize/2,
		Y:      num(t["y"], 0) - offsetY + num(t["height"], cells)*gridSize/2,
		Size:   cells * gridSize / 2,
		Color:  "#888888",
		Label:  asString(t["name"]),
		Image:  assets.URL(ctx, domain.AssetKindTokens, art),
		Hidden: asBool(t["hidden"]),
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
