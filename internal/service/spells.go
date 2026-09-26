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
// maxSpellStatuses — сколько состояний максимум может накладывать одно
// заклинание (см. domain.SpellStatusRef). Не правило, а тот же санитарный
// предел, что и у тегов: в реальном экспорте Foundry их единицы.
const maxSpellStatuses = 12

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

// sanitizeSpell — общие пределы карточки (строки, списки, теги, незнакомые ключи — см. cardlimits.go), вид
// атаки и состояния, которые заклинание накладывает. Молча, без ошибки.
func sanitizeSpell(s domain.Spell) domain.Spell {
	clampCard(&s)
	s.Tags = sanitizeTags(s.Tags)
	s.Extra = clampExtra(s.Extra)
	if !domain.ValidSpellAttack(s.Attack) {
		s.Attack = ""
	}
	s.Upcast = strings.TrimSpace(s.Upcast)
	s.Level = clampCount(s.Level, maxLevel)
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
		ref.Name = strings.TrimSpace(ref.Name)
		ref.Note = strings.TrimSpace(ref.Note)
		ref.Rounds = clampCount(ref.Rounds, maxStatusRounds)
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
