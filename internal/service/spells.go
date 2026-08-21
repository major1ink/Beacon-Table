package service

import (
	"context"
	"strings"
	"time"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository"
)

// maxSpellLongText/maxSpellShortText — те же санитарные пределы, что и у
// Monster (см. bestiary.go): не игровое правило, а защита от случайно
// вставленного гигантского текста в поле карточки.
const (
	maxSpellLongText  = 20000 // описание — импортированный HTML бывает длинным
	maxSpellShortText = 300   // время накладывания/дистанция/спасбросок и т.п.
	maxSpellTags      = 30
	// maxSpellStatuses — сколько состояний максимум может накладывать одно
	// заклинание (см. domain.SpellStatusRef). Не правило, а тот же санитарный
	// предел, что и у тегов: в реальном экспорте Foundry их единицы.
	maxSpellStatuses = 12
)

// SpellService — общая на весь стол библиотека карточек заклинаний (см.
// domain.Spell, internal/repository/spellfile) — тот же use case, что и
// BestiaryService, но доступна не только ДМ: и ДМ, и игроки создают/
// импортируют/правят карточки (см. requireAccount в spell_handlers.go).
type SpellService interface {
	List(ctx context.Context) ([]*domain.Spell, error)
	Get(ctx context.Context, id string) (*domain.Spell, error)
	// Create принимает Name — создаёт пустую карточку и сразу отдаёт её на
	// редактирование/импорт (как BestiaryService.Create).
	Create(ctx context.Context, name string) (*domain.Spell, error)
	// Update перезаписывает карточку целиком — ID/UpdatedAt сервис
	// проставляет сам, клиентские значения игнорирует.
	Update(ctx context.Context, id string, s domain.Spell) (*domain.Spell, error)
	Delete(ctx context.Context, id string) error
}

type spellService struct {
	spells repository.SpellRepository
}

func NewSpellService(spells repository.SpellRepository) SpellService {
	return &spellService{spells: spells}
}

func validateSpellName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 120 {
		return "", &domain.ValidationError{Msg: "имя заклинания обязательно (до 120 символов)"}
	}
	return name, nil
}

// sanitizeSpell — клампит текстовые поля/теги так же, как sanitizeMonster
// клампит статблок: молча, без ошибки — обычный клиент/импорт никогда
// специально не бьёт по этим лимитам.
func sanitizeSpell(s domain.Spell) domain.Spell {
	s.Source = clampRunes(s.Source, maxSpellShortText)
	s.School = clampRunes(s.School, maxSpellShortText)
	s.CastTime = clampRunes(s.CastTime, maxSpellShortText)
	s.Range = clampRunes(s.Range, maxSpellShortText)
	s.MaterialNote = clampRunes(s.MaterialNote, maxSpellLongText)
	s.Duration = clampRunes(s.Duration, maxSpellShortText)
	s.SavingThrow = clampRunes(s.SavingThrow, maxSpellShortText)
	s.Damage = clampRunes(s.Damage, maxSpellLongText)
	s.Classes = clampRunes(s.Classes, maxSpellLongText)
	s.Description = clampRunes(s.Description, maxSpellLongText)
	if len(s.Tags) > maxSpellTags {
		s.Tags = s.Tags[:maxSpellTags]
	}
	for i := range s.Tags {
		s.Tags[i] = clampRunes(strings.TrimSpace(s.Tags[i]), 60)
	}
	if s.Level < 0 {
		s.Level = 0
	}
	if s.Level > 9 {
		s.Level = 9
	}
	// Statuses (см. domain.SpellStatusRef) — список «что накладывает».
	// Slug приводим к каноничному виду тем же нормализатором, что и карточка
	// состояния (см. conditions.go: NormalizeConditionSlug): иначе "Prone",
	// набранный руками, не сойдётся с "prone" из импорта Foundry. Записи без
	// slug'а выбрасываем — ссылаться им не на что.
	if len(s.Statuses) > maxSpellStatuses {
		s.Statuses = s.Statuses[:maxSpellStatuses]
	}
	refs := make([]domain.SpellStatusRef, 0, len(s.Statuses))
	for _, ref := range s.Statuses {
		ref.Slug = NormalizeConditionSlug(ref.Slug)
		if ref.Slug == "" {
			continue
		}
		ref.Name = clampRunes(strings.TrimSpace(ref.Name), maxSpellShortText)
		ref.Note = clampRunes(strings.TrimSpace(ref.Note), maxSpellShortText)
		if ref.Rounds < 0 {
			ref.Rounds = 0
		}
		if ref.Rounds > maxStatusRounds {
			ref.Rounds = maxStatusRounds
		}
		refs = append(refs, ref)
	}
	s.Statuses = refs
	return s
}

func (s *spellService) List(ctx context.Context) ([]*domain.Spell, error) {
	return s.spells.List(ctx)
}

func (s *spellService) Get(ctx context.Context, id string) (*domain.Spell, error) {
	return s.spells.Get(ctx, id)
}

func (s *spellService) Create(ctx context.Context, name string) (*domain.Spell, error) {
	name, err := validateSpellName(name)
	if err != nil {
		return nil, err
	}
	sp := domain.NewSpell(newID(), name)
	sp.UpdatedAt = time.Now()
	if err := s.spells.Create(ctx, sp.ID, sp); err != nil {
		return nil, err
	}
	return sp, nil
}

func (s *spellService) Update(ctx context.Context, id string, sp domain.Spell) (*domain.Spell, error) {
	name, err := validateSpellName(sp.Name)
	if err != nil {
		return nil, err
	}
	sp.Name = name
	sp = sanitizeSpell(sp)
	sp.ID = id
	sp.UpdatedAt = time.Now()
	found, err := s.spells.Update(ctx, id, &sp)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, domain.ErrNotFound
	}
	return &sp, nil
}

func (s *spellService) Delete(ctx context.Context, id string) error {
	return s.spells.Delete(ctx, id)
}
