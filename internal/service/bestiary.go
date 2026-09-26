package service

import (
	"context"
	"strings"
	"time"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository"
)

// maxMonsterLongText/maxMonsterShortText — те же санитарные пределы, что и у
// CharacterSheet (см. validate.go): не игровое правило, а защита от
// случайно вставленного гигантского текста/бинарника в поле статблока.
// BestiaryService — библиотека карточек монстров ДМ (см. domain.Monster,
// internal/repository/monsterfile) — тот же use case, что и NoteService, но
// для структурированных статблоков вместо markdown-заметок.
type BestiaryService interface {
	List(ctx context.Context) ([]*domain.Monster, error)
	Get(ctx context.Context, id string) (*domain.Monster, error)
	// Create принимает Name (остальные поля — DefaultMonster есть на клиенте
	// как domain.NewMonster на сервере — создаём пустую карточку и сразу
	// отдаём её на редактирование, как handleNoteCreate с пустым текстом).
	Create(ctx context.Context, name string) (*domain.Monster, error)
	// Update перезаписывает карточку целиком (как UpdateSheet у персонажа) —
	// ID/UpdatedAt сервис проставляет сам, клиентские значения игнорирует.
	Update(ctx context.Context, id string, m domain.Monster) (*domain.Monster, error)
	Delete(ctx context.Context, id string) error
}

type bestiaryService struct {
	monsters repository.MonsterRepository
}

func NewBestiaryService(monsters repository.MonsterRepository) BestiaryService {
	return &bestiaryService{monsters: monsters}
}

func validateMonsterName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 120 {
		return "", &domain.ValidationError{Msg: "имя монстра обязательно (до 120 символов)"}
	}
	return name, nil
}

// sanitizeMonster — общие пределы карточки (строки, списки, теги, незнакомые ключи — см. cardlimits.go) и
// правила ядра: КД, хиты, количество и вес добычи не меньше нуля. Молча, без
// ошибки — обычный клиент никогда специально не бьёт по этим лимитам.
func sanitizeMonster(m domain.Monster) domain.Monster {
	clampCard(&m)
	m.Tags = sanitizeTags(m.Tags)
	m.Extra = clampExtra(m.Extra)
	for i := range m.Spells {
		m.Spells[i].Name = strings.TrimSpace(m.Spells[i].Name)
		m.Spells[i].Level = clampCount(m.Spells[i].Level, maxLevel)
	}
	m.AC = max(m.AC, 0)
	m.HP = max(m.HP, 0)
	m.ProficiencyBonus = max(m.ProficiencyBonus, 0)
	for i := range m.Inventory {
		m.Inventory[i].Name = strings.TrimSpace(m.Inventory[i].Name)
		m.Inventory[i].Quantity = max(m.Inventory[i].Quantity, 0)
		m.Inventory[i].WeightValue = max(m.Inventory[i].WeightValue, 0)
	}
	return m
}

func (s *bestiaryService) List(ctx context.Context) ([]*domain.Monster, error) {
	return s.monsters.List(ctx)
}

func (s *bestiaryService) Get(ctx context.Context, id string) (*domain.Monster, error) {
	return s.monsters.Get(ctx, id)
}

func (s *bestiaryService) Create(ctx context.Context, name string) (*domain.Monster, error) {
	name, err := validateMonsterName(name)
	if err != nil {
		return nil, err
	}
	m := domain.NewMonster(newID(), name)
	m.UpdatedAt = time.Now()
	if err := s.monsters.Create(ctx, m.ID, m); err != nil {
		return nil, err
	}
	return m, nil
}

func (s *bestiaryService) Update(ctx context.Context, id string, m domain.Monster) (*domain.Monster, error) {
	name, err := validateMonsterName(m.Name)
	if err != nil {
		return nil, err
	}
	m.Name = name
	m = sanitizeMonster(m)
	m.ID = id
	m.UpdatedAt = time.Now()
	found, err := s.monsters.Update(ctx, id, &m)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, domain.ErrNotFound
	}
	return &m, nil
}

func (s *bestiaryService) Delete(ctx context.Context, id string) error {
	return s.monsters.Delete(ctx, id)
}
