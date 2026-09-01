package service

import (
	"context"
	"math"

	"beacon-table/internal/domain"
)

// Гость публичного демо, вошедший ИГРОКОМ, приходит на стол, где ДМ может и
// не быть вовсе (демо-стол общий, но пустой в три часа ночи). Без токена на
// карте он увидел бы ровно чёрный экран: обзор игрока считается от токенов
// партии, и когда их нет, показывать нечего (см.
// web/src/vtt/vision-plan.js). Поэтому токен ему ставит сервер сразу при
// входе — это и есть та самая «половина продукта», ради которой роль игрока
// в демо и заводится.
//
// Всё, что здесь есть, — политика расстановки: КУДА поставить и ДАТЬ ЛИ
// факел. Само добавление токена — обычная мутация сцены, как от ДМ.

// guestTorchBright/guestTorchDim — факел в футах (D&D: 20 ярко / 40 тускло,
// см. domain.TokenLight — значения в единицах сцены, не в пикселях).
const (
	guestTorchBright = 20
	guestTorchDim    = 40
)

// guestTokenColor — цвет кружка, если у персонажа нет арта.
const guestTokenColor = "#4ea1ff"

// spawnTokenReq — заявка на постановку токена гостя, см. SpawnPlayerToken.
type spawnTokenReq struct {
	ownerID     string
	characterID string
	label       string
	image       string
	reply       chan bool
}

// SpawnPlayerToken ставит на АКТИВНУЮ сцену токен персонажа игрока и
// раздаёт обновление всем за столом. Возвращает false, если ставить некуда
// (в комнате нет ни одной сцены).
//
// Свой канал, а не inbound: это не команда клиента, роль по ней не
// проверяется — вызывающего (вход в демо) проверил API-слой. Тот же приём,
// что у ImportScenes.
func (r *Room) SpawnPlayerToken(ctx context.Context, ownerID, characterID, label, image string) (bool, error) {
	if ownerID == "" {
		return false, nil
	}
	reply := make(chan bool, 1)
	select {
	case r.spawnToken <- spawnTokenReq{ownerID: ownerID, characterID: characterID, label: label, image: image, reply: reply}:
	case <-ctx.Done():
		return false, ctx.Err()
	}
	select {
	case placed := <-reply:
		return placed, nil
	case <-ctx.Done():
		return false, ctx.Err()
	}
}

// spawnPlayerToken — тело SpawnPlayerToken уже внутри горутины комнаты.
func (r *Room) spawnPlayerToken(req spawnTokenReq) bool {
	if r.scene == nil {
		return false
	}
	cell := r.scene.Grid.Size
	if cell <= 0 {
		cell = 48
	}
	// Тот же инвариант «один персонаж — один токен», что и у ДМ-драга (см.
	// applyMutation: "add_token"): повторный вход тем же гостем переносит
	// токен, а не плодит копии.
	id := newID()
	if req.characterID != "" {
		r.dropDuplicateCharacterTokens(req.characterID, id)
	}
	x, y := r.guestSpawnPoint(cell)
	label := req.label
	if label == "" {
		label = "Гость"
	}
	t := &domain.Token{
		ID:          id,
		X:           x,
		Y:           y,
		Color:       guestTokenColor,
		Label:       label,
		Size:        cell / 2,
		Image:       req.image,
		OwnerID:     req.ownerID,
		CharacterID: req.characterID,
	}
	// Факел — только на тёмной карте. Залитую светом целиком (GlobalLight)
	// он ничем не дополнит, а вот в подземелье без него гость увидел бы то
	// же самое, что и без токена, — чёрный экран (см. vision-plan.js: без
	// единого источника света игрок не видит НИЧЕГО).
	if r.scene.GlobalLight == "" {
		t.Light = &domain.TokenLight{Enabled: true, Bright: guestTorchBright, Dim: guestTorchDim}
	}
	r.scene.Tokens[t.ID] = t
	r.markDirty(r.currentSceneID)
	r.broadcastAll()
	return true
}

// guestSpawnPoint выбирает, куда поставить гостя.
//
// Точки входа у сцены нет (см. domain.SceneState) и заводить её ради демо
// не хочется — вместо этого отталкиваемся от того, что автор карты уже
// расставил сам. Якорь — сначала любой источник света (гость сразу видит,
// как свет работает, а не стоит в темноте со своим факелом), затем любой
// видимый токен (там точно проходимое место, а не стена), и лишь потом
// середина карты. От якоря отходим по спирали, пока не найдётся клетка, где
// никто не стоит, — иначе десять гостей слиплись бы в одну фишку.
func (r *Room) guestSpawnPoint(cell float64) (float64, float64) {
	ax, ay := r.scene.Width/2, r.scene.Height/2
	best := 0 // 0 — середина карты, 1 — видимый токен, 2 — источник света
	for _, t := range r.scene.Tokens {
		if t.Hidden {
			continue
		}
		rank := 1
		if t.Light != nil && t.Light.Enabled && (t.Light.Bright > 0 || t.Light.Dim > 0) {
			rank = 2
		}
		if rank > best {
			best, ax, ay = rank, t.X, t.Y
		}
	}

	// Спираль по клеткам вокруг якоря: (1,0), (0,1), (-1,0)… с ростом радиуса.
	for radius := 1; radius <= 6; radius++ {
		for _, d := range ringOffsets {
			x := ax + d[0]*float64(radius)*cell
			y := ay + d[1]*float64(radius)*cell
			if x < cell/2 || y < cell/2 || x > r.scene.Width-cell/2 || y > r.scene.Height-cell/2 {
				continue // за краем карты
			}
			if r.spotTaken(x, y, cell) {
				continue
			}
			return x, y
		}
	}
	return ax, ay // карта плотно забита — пусть встанет на якорь, разойдутся руками
}

// ringOffsets — восемь направлений вокруг якоря, по часовой стрелке от
// «вправо». Диагонали нормированы, чтобы отход по ним был той же длины, что
// и по прямым.
var ringOffsets = [8][2]float64{
	{1, 0}, {diag, diag}, {0, 1}, {-diag, diag},
	{-1, 0}, {-diag, -diag}, {0, -1}, {diag, -diag},
}

var diag = math.Sqrt2 / 2

// spotTaken — стоит ли уже кто-то ближе чем в клетке от точки.
func (r *Room) spotTaken(x, y, cell float64) bool {
	for _, t := range r.scene.Tokens {
		if math.Hypot(t.X-x, t.Y-y) < cell {
			return true
		}
	}
	return false
}

// ---- уход гостя ----
//
// Обратная сторона SpawnPlayerToken: фишку гостю ставит сервер, значит и
// убирать её со стола — тоже ему. Гость демо не «выходит из игры» в том
// смысле, в каком это делает игрок постоянного стола: его аккаунт исчезает
// целиком (см. app.GuestKeeper), и оставшаяся на карте фишка ничьей не
// становится — она просто мешает следующим.

// dropTokensReq — заявка на уборку фишек ушедшего, см. RemoveOwnerTokens.
type dropTokensReq struct {
	ownerID string
	reply   chan int
}

// RemoveOwnerTokens убирает со ВСЕХ сцен комнаты фишки, принадлежащие
// ownerID, и раздаёт обновление оставшимся за столом. Возвращает, сколько
// убрал.
//
// По всем сценам, а не только по активной, по той же причине, что и
// dropDuplicateCharacterTokens: гость мог отметиться на карте, которую ДМ
// с тех пор переключил, — иначе фишка всплыла бы при возврате на неё.
func (r *Room) RemoveOwnerTokens(ctx context.Context, ownerID string) (int, error) {
	if ownerID == "" {
		return 0, nil
	}
	reply := make(chan int, 1)
	select {
	case r.dropTokens <- dropTokensReq{ownerID: ownerID, reply: reply}:
	case <-ctx.Done():
		return 0, ctx.Err()
	}
	select {
	case removed := <-reply:
		return removed, nil
	case <-ctx.Done():
		return 0, ctx.Err()
	}
}

// removeOwnerTokens — тело RemoveOwnerTokens уже внутри горутины комнаты.
func (r *Room) removeOwnerTokens(ownerID string) int {
	removed := 0
	for sceneID, s := range r.scenes {
		for id, t := range s.Tokens {
			if t.OwnerID != ownerID {
				continue
			}
			delete(s.Tokens, id)
			r.markDirty(sceneID)
			removed++
		}
	}
	if removed > 0 {
		r.broadcastAll()
	}
	return removed
}
