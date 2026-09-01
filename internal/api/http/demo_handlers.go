package http

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"beacon-table/internal/app"
	"beacon-table/internal/domain"
)

// maxDemoGuests — сколько гостей демо живёт одновременно (обеих ролей
// вместе). Аккаунт заводится по одному нажатию, без всякого участия
// человека, поэтому предел нужен: иначе один скрипт набьёт базу за минуту.
// Отвечаем 429, а не молча перестаём пускать.
const maxDemoGuests = 10

// handleDemoStatus — GET /api/demo: включён ли демо-режим. Страница входа
// спрашивает это, чтобы решить, показывать ли кнопки «Посмотреть демо».
// Без авторизации — её и спрашивают до входа.
func (a *API) handleDemoStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"enabled": a.DemoMode})
}

// handleDemoGuest — POST /api/demo/guest: завести гостя и сразу его впустить.
//
// Тело — {"role":"dm"|"player"}; пусто (и любое неизвестное значение) —
// "dm", как было до появления второй роли.
//
//   - "dm" — гость получает права ДМ ВНУТРИ стола (см.
//     domain.AccountRoleDemo): двигает токены, рисует стены, ставит свет,
//     правит бестиарий. Сервером он не распоряжается: аккаунты, миры,
//     настройки и импорт из интернета закрыты гейтом requireOwner.
//   - "player" — гость садится по эту сторону ширмы (см.
//     domain.AccountRoleDemoPlayer): ему выдаётся персонаж и токен на карте,
//     дальше он видит стол ровно так, как видит игрок — с туманом войны и
//     светом. Без этого демо показывало бы только половину продукта: у ДМ
//     карта открыта целиком, и зачем считается вся геометрия света и стен,
//     по ней не видно.
func (a *API) handleDemoGuest(w http.ResponseWriter, r *http.Request) {
	if !a.DemoMode {
		writeErr(w, http.StatusNotFound, "демо-режим выключен")
		return
	}
	var req struct{ Role string }
	// Тело необязательно: старый клиент (и curl) шлёт пустой POST — это
	// гость-ДМ, как раньше. Ошибку разбора поэтому игнорируем.
	_ = json.NewDecoder(r.Body).Decode(&req)
	role := domain.AccountRoleDemo
	if req.Role == "player" {
		role = domain.AccountRoleDemoPlayer
	}

	world := a.Companies.Current()
	if world == nil {
		writeErr(w, http.StatusServiceUnavailable, "демо-стол сейчас не запущен, зайдите через минуту")
		return
	}

	token, acc, err := a.Auth.CreateGuest(r.Context(), world.Company.ID, role, maxDemoGuests)
	if err != nil {
		if errors.Is(err, domain.ErrConflict) {
			writeErr(w, http.StatusTooManyRequests, "сейчас за столом слишком много гостей — попробуйте через несколько минут")
			return
		}
		writeErr(w, http.StatusInternalServerError, "не удалось открыть демо")
		return
	}

	if role == domain.AccountRoleDemoPlayer {
		a.seatDemoPlayer(r, world, acc)
	}

	a.setSessionCookie(w, token)
	chars, err := a.myCharacters(r.Context(), acc)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, a.meResponseJSON(acc, chars))
}

// seatDemoPlayer усаживает гостя-игрока за стол: выдаёт персонажа и ставит
// его токен на активную сцену.
//
// Ни то, ни другое не является причиной отказать во входе: пустой стол без
// заготовок или сцена, которую прямо сейчас переключают, — не повод
// показать посетителю ошибку вместо демо. Поэтому промахи только пишутся в
// журнал: гость войдёт, просто заведёт персонажа руками (панель «Мои
// персонажи»), а токен ему поставит гость-ДМ.
func (a *API) seatDemoPlayer(r *http.Request, world *app.ActiveWorld, acc *domain.Account) {
	ctx := r.Context()
	char := a.claimDemoCharacter(r, world, acc)
	if char == nil {
		return
	}
	if _, err := world.Room.SpawnPlayerToken(ctx, acc.ID, char.ID, char.Name, char.AvatarURL); err != nil {
		slog.Warn("гостю-игроку не удалось поставить токен", "гость", acc.Username, "err", err)
	}
}

// claimDemoCharacter — персонаж для гостя-игрока: сначала свободная
// заготовка из пула мира (см. service.PregenService — у демо-мира они
// заведены заранее, вместе с листом и артом), и только если пул пуст или
// весь разобран — пустой персонаж с именем гостя.
//
// Заготовку перехватывает соседний гость ровно так же, как это делает живой
// игрок кнопкой «Взять» (Claim возвращает ErrForbidden), поэтому идём по
// списку, пока какая-нибудь не достанется.
func (a *API) claimDemoCharacter(r *http.Request, world *app.ActiveWorld, acc *domain.Account) *domain.Character {
	ctx := r.Context()
	free, err := world.Pregens.Available(ctx)
	if err != nil {
		slog.Warn("не удалось получить заготовки персонажей для гостя-игрока", "err", err)
	}
	// По порядку: занятые заготовки из Available уже исключены, так что
	// следующему гостю достанется следующая по списку, а не та же самая.
	// Гонку двух одновременных входов ловит сам Claim (ErrForbidden) — тогда
	// просто пробуем дальше по списку.
	for _, p := range free {
		char, err := world.Pregens.Claim(ctx, p.ID, acc.ID)
		if err == nil {
			return char
		}
		if !errors.Is(err, domain.ErrForbidden) {
			slog.Warn("не удалось выдать гостю-игроку заготовку персонажа", "заготовка", p.Name, "err", err)
			break
		}
	}

	char, err := world.Characters.Create(ctx, acc.ID, acc.Username, "")
	if err != nil {
		slog.Warn("не удалось завести персонажа гостю-игроку", "гость", acc.Username, "err", err)
		return nil
	}
	return char
}
