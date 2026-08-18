package service

import (
	"context"
	"strings"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository"
)

// maxInventoryNotes/maxInventoryEntries — санитарные пределы записи
// инвентаря персонажа, тот же принцип, что и у остальных сервисов (см.
// maxMonsterLongText в bestiary.go) — защита от случайно вставленного
// гигантского текста, не игровое правило.
const (
	maxInventoryNotes   = 2000
	maxInventoryEntries = 500
)

// CharacterService — CRUD персонажей игрока, ограниченный владельцем
// (accountID). Административный доступ ко ВСЕМ персонажам живёт отдельно в
// AdminService.ListAllCharacters — это уже другой use case с другими правами.
type CharacterService interface {
	List(ctx context.Context, accountID string) ([]*domain.Character, error)
	// Get — один персонаж, только если он принадлежит accountID (иначе
	// ErrNotFound, а не ErrForbidden — не подсказываем, что чужой id вообще
	// существует, как и Update/Delete ниже).
	Get(ctx context.Context, id, accountID string) (*domain.Character, error)
	Create(ctx context.Context, accountID, name, avatarURL string) (*domain.Character, error)
	Update(ctx context.Context, id, accountID, name, avatarURL string) error
	// UpdateSheet перезаписывает структурированный лист персонажа (D&D 2024,
	// см. domain.CharacterSheet) — отдельно от имени/аватара, редактируется
	// в своём окне (character-sheet.html).
	UpdateSheet(ctx context.Context, id, accountID string, sheet domain.CharacterSheet) error
	Delete(ctx context.Context, id, accountID string) error

	// ---- инвентарь (domain.InventoryEntry) — своя SQL sub-collection, НЕ
	// часть Sheet (см. repository.CharacterRepository и план фичи) ----

	ListInventory(ctx context.Context, id, accountID string) ([]*domain.InventoryEntry, error)
	// AddInventoryItem резолвит itemID через каталог предметов (ItemRepository)
	// и снимает с него Name/ImageURL/WeightLb в новую запись — как и у
	// остальных Create-подобных методов сервисов, quantity клампится до >=1.
	AddInventoryItem(ctx context.Context, id, accountID, itemID string, quantity int) (*domain.InventoryEntry, error)
	UpdateInventoryItem(ctx context.Context, id, accountID, entryID string, quantity int, equipped bool, notes string) error
	RemoveInventoryItem(ctx context.Context, id, accountID, entryID string) error
}

type characterService struct {
	characters repository.CharacterRepository
	items      repository.ItemRepository
}

func NewCharacterService(characters repository.CharacterRepository, items repository.ItemRepository) CharacterService {
	return &characterService{characters: characters, items: items}
}

func (s *characterService) List(ctx context.Context, accountID string) ([]*domain.Character, error) {
	return s.characters.ByAccount(ctx, accountID)
}

func (s *characterService) Get(ctx context.Context, id, accountID string) (*domain.Character, error) {
	c, err := s.characters.ByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if c.AccountID != accountID {
		return nil, domain.ErrNotFound
	}
	return c, nil
}

func (s *characterService) Create(ctx context.Context, accountID, name, avatarURL string) (*domain.Character, error) {
	name, err := validateCharacterName(name)
	if err != nil {
		return nil, err
	}
	c := &domain.Character{ID: newID(), AccountID: accountID, Name: name, AvatarURL: avatarURL, Sheet: domain.DefaultCharacterSheet()}
	if err := s.characters.Create(ctx, c); err != nil {
		return nil, err
	}
	return c, nil
}

func (s *characterService) Update(ctx context.Context, id, accountID, name, avatarURL string) error {
	name, err := validateCharacterName(name)
	if err != nil {
		return err
	}
	found, err := s.characters.Update(ctx, id, accountID, name, avatarURL)
	if err != nil {
		return err
	}
	if !found {
		return domain.ErrNotFound
	}
	return nil
}

func (s *characterService) UpdateSheet(ctx context.Context, id, accountID string, sheet domain.CharacterSheet) error {
	sheet = sanitizeSheet(sheet)
	found, err := s.characters.UpdateSheet(ctx, id, accountID, sheet)
	if err != nil {
		return err
	}
	if !found {
		return domain.ErrNotFound
	}
	return nil
}

func (s *characterService) Delete(ctx context.Context, id, accountID string) error {
	found, err := s.characters.Delete(ctx, id, accountID)
	if err != nil {
		return err
	}
	if !found {
		return domain.ErrNotFound
	}
	return nil
}

// ListInventory — проверяет владение персонажем тем же способом, что и Get,
// затем читает записи инвентаря.
func (s *characterService) ListInventory(ctx context.Context, id, accountID string) ([]*domain.InventoryEntry, error) {
	if _, err := s.Get(ctx, id, accountID); err != nil {
		return nil, err
	}
	return s.characters.ListInventory(ctx, id)
}

func (s *characterService) AddInventoryItem(ctx context.Context, id, accountID, itemID string, quantity int) (*domain.InventoryEntry, error) {
	if _, err := s.Get(ctx, id, accountID); err != nil {
		return nil, err
	}
	item, err := s.items.Get(ctx, itemID)
	if err != nil {
		return nil, err
	}
	if quantity < 1 {
		quantity = 1
	}
	// Потолок числа РАЗНЫХ записей инвентаря — апсерт по ItemID (см.
	// AddInventoryEntry) не даёт заспамить одним и тем же предметом, но
	// разных карточек каталога может быть добавлено сколько угодно без
	// этой проверки.
	if existing, err := s.characters.ListInventory(ctx, id); err == nil && len(existing) >= maxInventoryEntries {
		return nil, &domain.ValidationError{Msg: "инвентарь переполнен"}
	}
	entry := domain.InventoryEntry{
		ID: newID(), ItemID: item.ID, Name: item.Name, ImageURL: item.ImageURL,
		WeightLb: item.WeightLb, Quantity: quantity,
	}
	return s.characters.AddInventoryEntry(ctx, id, accountID, entry)
}

func (s *characterService) UpdateInventoryItem(ctx context.Context, id, accountID, entryID string, quantity int, equipped bool, notes string) error {
	if _, err := s.Get(ctx, id, accountID); err != nil {
		return err
	}
	if quantity < 0 {
		quantity = 0
	}
	notes = clampRunes(strings.TrimSpace(notes), maxInventoryNotes)
	found, err := s.characters.UpdateInventoryEntry(ctx, id, accountID, entryID, quantity, equipped, notes)
	if err != nil {
		return err
	}
	if !found {
		return domain.ErrNotFound
	}
	return nil
}

func (s *characterService) RemoveInventoryItem(ctx context.Context, id, accountID, entryID string) error {
	if _, err := s.Get(ctx, id, accountID); err != nil {
		return err
	}
	found, err := s.characters.RemoveInventoryEntry(ctx, id, accountID, entryID)
	if err != nil {
		return err
	}
	if !found {
		return domain.ErrNotFound
	}
	return nil
}
