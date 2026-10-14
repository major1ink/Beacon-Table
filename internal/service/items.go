package service

import (
	"context"
	"strings"
	"time"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository"
)

// maxItemLongText/maxItemShortText — те же санитарные пределы, что и у
// Spell/Monster (см. spells.go/bestiary.go): не игровое правило, а защита от
// случайно вставленного гигантского текста в поле карточки.
// ItemService — общая на весь стол библиотека карточек предметов (см.
// domain.Item, internal/repository/itemfile) — тот же use case, что и
// SpellService: доступна не только ДМ, и ДМ, и игроки создают/импортируют/
// правят карточки (см. requireAccount в item_handlers.go).
type ItemService interface {
	List(ctx context.Context) ([]*domain.Item, error)
	Get(ctx context.Context, id string) (*domain.Item, error)
	// Create принимает Name — создаёт пустую карточку и сразу отдаёт её на
	// редактирование/импорт (как SpellService.Create).
	Create(ctx context.Context, name string) (*domain.Item, error)
	// Update перезаписывает карточку целиком — ID/UpdatedAt сервис
	// проставляет сам, клиентские значения игнорирует.
	Update(ctx context.Context, id string, it domain.Item) (*domain.Item, error)
	Delete(ctx context.Context, id string) error
}

type itemService struct {
	items repository.ItemRepository
}

func NewItemService(items repository.ItemRepository) ItemService {
	return &itemService{items: items}
}

func validateItemName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 120 {
		return "", &domain.ValidationError{Msg: "имя предмета обязательно (до 120 символов)"}
	}
	return name, nil
}

// sanitizeItem — общие пределы карточки (строки, списки, теги, незнакомые ключи — см. cardlimits.go),
// модификаторы и неотрицательный вес. Молча, без ошибки.
func sanitizeItem(it domain.Item) domain.Item {
	clampCard(&it)
	it.Tags = sanitizeTags(it.Tags)
	it.Extra = clampExtra(it.Extra)
	// Modifiers — что предмет даёт, пока надет (см. domain.Modifier); тот же
	// санитайзер, что и у карточки состояния.
	it.Modifiers = sanitizeModifiers(it.Modifiers)
	it.WeightValue = max(it.WeightValue, 0)
	return it
}

func (s *itemService) List(ctx context.Context) ([]*domain.Item, error) {
	return s.items.List(ctx)
}

func (s *itemService) Get(ctx context.Context, id string) (*domain.Item, error) {
	return s.items.Get(ctx, id)
}

func (s *itemService) Create(ctx context.Context, name string) (*domain.Item, error) {
	name, err := validateItemName(name)
	if err != nil {
		return nil, err
	}
	it := domain.NewItem(newID(), name)
	it.UpdatedAt = time.Now()
	if err := s.items.Create(ctx, it.ID, it); err != nil {
		return nil, err
	}
	return it, nil
}

func (s *itemService) Update(ctx context.Context, id string, it domain.Item) (*domain.Item, error) {
	name, err := validateItemName(it.Name)
	if err != nil {
		return nil, err
	}
	it.Name = name
	it = sanitizeItem(it)
	it.ID = id
	it.UpdatedAt = time.Now()
	found, err := s.items.Update(ctx, id, &it)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, domain.ErrNotFound
	}
	return &it, nil
}

func (s *itemService) Delete(ctx context.Context, id string) error {
	return s.items.Delete(ctx, id)
}
