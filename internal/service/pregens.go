package service

import (
	"context"
	"strings"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository"
)

// PregenService — пул «готовых персонажей» мира (см. domain.Pregen).
// Импорт приключения Foundry складывает сюда актёров type "character"
// (см. foundry.TargetPregens); игрок берёт свободного, ДМ назначает аккаунту
// или возвращает в пул.
//
// «Захват» (Claim) — единственное место, где пул встречается с обычными
// персонажами: он СОЗДАЁТ запись domain.Character через
// CharacterRepository (тот сам штампует company_id/system и маршалит лист),
// принадлежащую игроку. Дальше это его персонаж; пул-запись остаётся
// шаблоном с пометкой занятости.
type PregenService interface {
	// List — весь пул (для панели ДМ).
	List(ctx context.Context) ([]*domain.Pregen, error)
	// Available — свободные пре-гены (для игрока).
	Available(ctx context.Context) ([]*domain.Pregen, error)
	Get(ctx context.Context, id string) (*domain.Pregen, error)

	// Import/Update — покарточное заведение из экрана импорта Foundry (только
	// ДМ, тот же приём, что createMonster/updateMonster: сначала пустая
	// карточка по имени, потом полная перезапись).
	Import(ctx context.Context, name string) (*domain.Pregen, error)
	Update(ctx context.Context, id, name, avatarURL, source string, sheet domain.CharacterSheet) (*domain.Pregen, error)

	// Claim — игрок берёт (или ДМ назначает) пре-гена аккаунту accountID.
	// Создаёт персонажа с перенесённым листом и возвращает его. Повторный
	// вызов тем же аккаунтом идемпотентен (возвращает уже созданного).
	// domain.ErrForbidden — пре-ген уже занят другим аккаунтом.
	Claim(ctx context.Context, pregenID, accountID string) (*domain.Character, error)
	// Release — отвязать заготовку от игрока: УДАЛИТЬ созданного при захвате
	// персонажа (Claim.ClaimedCharacterID) и снять пометку занятости, вернув
	// заготовку в пул свободных. Раньше персонаж оставался у игрока, а
	// заготовка числилась свободной — двусмысленное «и назначен, и не
	// назначен» (см. панель «Персонажи» ДМ). Если персонажа уже нет — просто
	// снимает пометку.
	Release(ctx context.Context, pregenID string) error
	// Delete — убрать пре-гена из пула.
	Delete(ctx context.Context, pregenID string) error
	// FreeByAccount — освободить всё, что держал занятым удаляемый аккаунт
	// (вызывается из handleAdminAccountDelete — персонажи уходят каскадом,
	// а пул-записи FK не имеют).
	FreeByAccount(ctx context.Context, accountID string) error
}

type pregenService struct {
	pregens    repository.PregenRepository
	characters repository.CharacterRepository
}

func NewPregenService(pregens repository.PregenRepository, characters repository.CharacterRepository) PregenService {
	return &pregenService{pregens: pregens, characters: characters}
}

func (s *pregenService) List(ctx context.Context) ([]*domain.Pregen, error) {
	return s.pregens.List(ctx)
}

func (s *pregenService) Available(ctx context.Context) ([]*domain.Pregen, error) {
	return s.pregens.Available(ctx)
}

func (s *pregenService) Get(ctx context.Context, id string) (*domain.Pregen, error) {
	return s.pregens.ByID(ctx, id)
}

func (s *pregenService) Import(ctx context.Context, name string) (*domain.Pregen, error) {
	name, err := validateCharacterName(name)
	if err != nil {
		return nil, err
	}
	p := &domain.Pregen{ID: newID(), Name: name, Sheet: domain.DefaultCharacterSheet()}
	if err := s.pregens.Create(ctx, p); err != nil {
		return nil, err
	}
	return p, nil
}

func (s *pregenService) Update(ctx context.Context, id, name, avatarURL, source string, sheet domain.CharacterSheet) (*domain.Pregen, error) {
	name, err := validateCharacterName(name)
	if err != nil {
		return nil, err
	}
	avatarURL = clampRunes(strings.TrimSpace(avatarURL), maxSheetShortText)
	source = clampRunes(strings.TrimSpace(source), maxSheetShortText)
	sheet = sanitizeSheet(sheet)
	found, err := s.pregens.Update(ctx, id, name, avatarURL, source, sheet)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, domain.ErrNotFound
	}
	return s.pregens.ByID(ctx, id)
}

func (s *pregenService) Claim(ctx context.Context, pregenID, accountID string) (*domain.Character, error) {
	p, err := s.pregens.ByID(ctx, pregenID)
	if err != nil {
		return nil, err
	}
	if p.ClaimedBy != "" && p.ClaimedBy != accountID {
		return nil, domain.ErrForbidden
	}
	// Уже брал этот же аккаунт — вернуть созданного тогда персонажа (если он
	// ещё жив; игрок мог его удалить — тогда заведём заново ниже).
	if p.ClaimedBy == accountID && p.ClaimedCharacterID != "" {
		if c, err := s.characters.ByID(ctx, p.ClaimedCharacterID); err == nil && c.AccountID == accountID {
			return c, nil
		}
	}

	c := &domain.Character{
		ID:        newID(),
		AccountID: accountID,
		Name:      p.Name,
		AvatarURL: p.AvatarURL,
		Sheet:     sanitizeSheet(p.Sheet),
	}
	if err := s.characters.Create(ctx, c); err != nil {
		return nil, err
	}
	ok, err := s.pregens.SetClaim(ctx, pregenID, accountID, c.ID)
	if err != nil {
		_, _ = s.characters.Delete(ctx, c.ID, accountID)
		return nil, err
	}
	if !ok {
		// Кто-то перехватил пре-гена между ByID и SetClaim — откатываем
		// только что созданного персонажа.
		_, _ = s.characters.Delete(ctx, c.ID, accountID)
		return nil, domain.ErrForbidden
	}
	return c, nil
}

func (s *pregenService) Release(ctx context.Context, pregenID string) error {
	p, err := s.pregens.ByID(ctx, pregenID)
	if err != nil {
		return err
	}
	// Персонаж, созданный при захвате, уходит вместе с откреплением — иначе
	// остаётся «осиротевший» персонаж у игрока при формально свободной
	// заготовке. Если игрок уже удалил его сам — Delete вернёт found=false,
	// это не ошибка.
	if p.ClaimedCharacterID != "" && p.ClaimedBy != "" {
		if _, err := s.characters.Delete(ctx, p.ClaimedCharacterID, p.ClaimedBy); err != nil {
			return err
		}
	}
	found, err := s.pregens.ClearClaim(ctx, pregenID)
	if err != nil {
		return err
	}
	if !found {
		return domain.ErrNotFound
	}
	return nil
}

func (s *pregenService) FreeByAccount(ctx context.Context, accountID string) error {
	return s.pregens.FreeByAccount(ctx, accountID)
}

func (s *pregenService) Delete(ctx context.Context, pregenID string) error {
	found, err := s.pregens.Delete(ctx, pregenID)
	if err != nil {
		return err
	}
	if !found {
		return domain.ErrNotFound
	}
	return nil
}

// compile-time проверка, что интерфейс реализован.
var _ PregenService = (*pregenService)(nil)
