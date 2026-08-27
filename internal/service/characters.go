package service

import (
	"context"
	"strings"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository"
)

// maxInventoryNotes — санитарный предел заметки записи инвентаря персонажа,
// тот же принцип, что и у остальных сервисов (см. maxMonsterLongText в
// bestiary.go) — защита от случайно вставленного гигантского текста, не
// игровое правило.
const maxInventoryNotes = 2000

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
	// Добавления "из каталога с нуля" здесь нарочно нет — игрок пополняет
	// свой инвентарь только тем, что выдал ДМ (хаб лута) или что удалось
	// забрать с трупа, оба пути пишут через
	// CharacterRepository.AddInventoryEntry в обход этого сервиса (см.
	// service.Room: handleHubTakeItem/handleLootTakeItem).
	//
	// UpdateInventoryItem клампит quantity сверху текущим значением записи —
	// игроку этим методом можно только уменьшить количество (потратил,
	// выбросил) или поправить notes, не приписать себе лишнее; дошло до
	// нуля — запись целиком удаляется (см. RemoveInventoryItem), а не висит
	// строкой "×0". Смена equipped — отдельная ветка (см. реализацию):
	// расщепляет/сливает стопку по одной штуке через
	// CharacterRepository.SetInventoryEquipped, а не флаг всей записи;
	// quantity/notes из запроса в этом случае
	// игнорируются.
	UpdateInventoryItem(ctx context.Context, id, accountID, entryID string, quantity int, equipped bool, notes string) error
	RemoveInventoryItem(ctx context.Context, id, accountID, entryID string) error
}

type characterService struct {
	characters repository.CharacterRepository
}

func NewCharacterService(characters repository.CharacterRepository) CharacterService {
	return &characterService{characters: characters}
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

func (s *characterService) UpdateInventoryItem(ctx context.Context, id, accountID, entryID string, quantity int, equipped bool, notes string) error {
	if _, err := s.Get(ctx, id, accountID); err != nil {
		return err
	}
	existing, err := s.characters.ListInventory(ctx, id)
	if err != nil {
		return err
	}
	var current *domain.InventoryEntry
	for _, e := range existing {
		if e.ID == entryID {
			current = e
			break
		}
	}
	if current == nil {
		return domain.ErrNotFound
	}

	// Надел/снял — особый путь: расщепляет или сливает стопку по одной штуке
	// (см. CharacterRepository.SetInventoryEquipped), а не просто щёлкает
	// флаг на всей записи. quantity из запроса тут игнорируется — клиент
	// всегда шлёт старое суммарное количество стопки (character-sheet.js:
	// кнопка "надето" патчит только equipped), которое после расщепления/
	// слияния уже не имеет отношения к этой записи.
	if equipped != current.Equipped {
		found, err := s.characters.SetInventoryEquipped(ctx, id, accountID, entryID, newID(), equipped)
		if err != nil {
			return err
		}
		if !found {
			return domain.ErrNotFound
		}
		return nil
	}

	if quantity < 0 {
		quantity = 0
	}
	// Только уменьшение — см. комментарий у CharacterService выше. Текущее
	// количество записи — потолок для запроса, превышение молча подрезается,
	// а не отклоняет весь вызов (notes всё равно должны сохраниться).
	if quantity > current.Quantity {
		quantity = current.Quantity
	}
	// Дошло до нуля — предмет весь потрачен/выброшен, запись убирается из
	// инвентаря целиком, а не висит пустой строкой "×0".
	if quantity == 0 {
		found, err := s.characters.RemoveInventoryEntry(ctx, id, accountID, entryID)
		if err != nil {
			return err
		}
		if !found {
			return domain.ErrNotFound
		}
		return nil
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
