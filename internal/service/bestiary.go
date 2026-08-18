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
const (
	maxMonsterLongText  = 20000 // блоки способностей (Traits/Actions/.../Description) — статблоки с логовом бывают длинными
	maxMonsterShortText = 300   // размер/тип/скорость/сопротивления и т.п.
	maxMonsterTags      = 30
	maxMonsterSpells    = 100
	maxMonsterInventory = 200
)

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

// sanitizeMonster — клампит текстовые поля/теги так же, как sanitizeSheet
// клампит лист персонажа: молча, без ошибки — обычный клиент никогда
// специально не бьёт по этим лимитам.
func sanitizeMonster(m domain.Monster) domain.Monster {
	m.ImageURL = clampRunes(m.ImageURL, maxMonsterShortText)
	m.Size = clampRunes(m.Size, maxMonsterShortText)
	m.Type = clampRunes(m.Type, maxMonsterShortText)
	m.Alignment = clampRunes(m.Alignment, maxMonsterShortText)
	m.ACNote = clampRunes(m.ACNote, maxMonsterShortText)
	m.HitDice = clampRunes(m.HitDice, maxMonsterShortText)
	m.Speed = clampRunes(m.Speed, maxMonsterShortText)
	m.SavingThrows = clampRunes(m.SavingThrows, maxMonsterLongText)
	m.Skills = clampRunes(m.Skills, maxMonsterLongText)
	m.DamageVulnerabilities = clampRunes(m.DamageVulnerabilities, maxMonsterLongText)
	m.DamageResistances = clampRunes(m.DamageResistances, maxMonsterLongText)
	m.DamageImmunities = clampRunes(m.DamageImmunities, maxMonsterLongText)
	m.ConditionImmunities = clampRunes(m.ConditionImmunities, maxMonsterLongText)
	m.Senses = clampRunes(m.Senses, maxMonsterLongText)
	m.Languages = clampRunes(m.Languages, maxMonsterLongText)
	m.CR = clampRunes(m.CR, maxMonsterShortText)
	m.Traits = clampRunes(m.Traits, maxMonsterLongText)
	m.Actions = clampRunes(m.Actions, maxMonsterLongText)
	m.BonusActions = clampRunes(m.BonusActions, maxMonsterLongText)
	m.Reactions = clampRunes(m.Reactions, maxMonsterLongText)
	m.LegendaryActionsIntro = clampRunes(m.LegendaryActionsIntro, maxMonsterLongText)
	m.LegendaryActions = clampRunes(m.LegendaryActions, maxMonsterLongText)
	m.LairActions = clampRunes(m.LairActions, maxMonsterLongText)
	m.Description = clampRunes(m.Description, maxMonsterLongText)
	if len(m.Tags) > maxMonsterTags {
		m.Tags = m.Tags[:maxMonsterTags]
	}
	for i := range m.Tags {
		m.Tags[i] = clampRunes(strings.TrimSpace(m.Tags[i]), 60)
	}
	if len(m.Spells) > maxMonsterSpells {
		m.Spells = m.Spells[:maxMonsterSpells]
	}
	for i := range m.Spells {
		m.Spells[i].Name = clampRunes(strings.TrimSpace(m.Spells[i].Name), 120)
		if m.Spells[i].Level < 0 {
			m.Spells[i].Level = 0
		}
		if m.Spells[i].Level > 9 {
			m.Spells[i].Level = 9
		}
	}
	if m.AC < 0 {
		m.AC = 0
	}
	if m.HP < 0 {
		m.HP = 0
	}
	if m.ProficiencyBonus < 0 {
		m.ProficiencyBonus = 0
	}
	if len(m.Inventory) > maxMonsterInventory {
		m.Inventory = m.Inventory[:maxMonsterInventory]
	}
	for i := range m.Inventory {
		m.Inventory[i].Name = clampRunes(strings.TrimSpace(m.Inventory[i].Name), 120)
		m.Inventory[i].ImageURL = clampRunes(m.Inventory[i].ImageURL, maxMonsterShortText)
		m.Inventory[i].Notes = clampRunes(m.Inventory[i].Notes, maxMonsterLongText)
		if m.Inventory[i].Quantity < 0 {
			m.Inventory[i].Quantity = 0
		}
		if m.Inventory[i].WeightLb < 0 {
			m.Inventory[i].WeightLb = 0
		}
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
