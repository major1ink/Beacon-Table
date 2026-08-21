package service

import (
	"context"
	"regexp"
	"strings"
	"time"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository"
)

// maxCondition*/maxConditionTags — те же санитарные пределы, что у
// Item/Monster/Reference (см. references.go): не игровое правило, а защита
// от случайно вставленного гигантского текста в поле карточки.
const (
	maxConditionLongText  = 20000 // Description
	maxConditionText      = 2000  // Mechanics — расшифровка changes[] из Foundry бывает длинной
	maxConditionShortText = 300   // Source/ImageURL
	maxConditionTags      = 30
	maxConditionRiders    = 12
	// maxConditionLevels — потолок уровней многоуровневого состояния.
	// Истощение по правилам 6, запас — на самодельные шкалы ДМ; смысл
	// ограничения тот же, что у остальных клампов, — не пустить в UI
	// карточку с тысячей лампочек.
	maxConditionLevels = 20
	// maxStatusRounds — потолок длительности метки в раундах (примерно
	// сутки игрового времени). Тоже не правило, а защита от опечатки в поле
	// ввода, из-за которой метка «висит» условно вечно.
	maxStatusRounds = 10000
)

// conditionSlugChars — что остаётся от Slug после нормализации: латиница,
// цифры, дефис. Slug — машинный ключ (мост к кодам Foundry, ключ ссылки у
// AppliedStatus/SpellStatusRef и у Riders, см. domain.Condition), поэтому
// пробелы/кириллицу/регистр приводим к предсказуемому виду, а не храним как
// ввели: иначе "Prone" из одной карточки и "prone" из импорта Foundry не
// сойдутся.
var conditionSlugChars = regexp.MustCompile(`[^a-z0-9-]+`)

// ConditionService — общая на весь стол библиотека карточек состояний (см.
// domain.Condition, internal/repository/conditionfile) — тот же use case,
// что и ReferenceService: доступна не только ДМ (см. requireAccount в
// condition_handlers.go), потому что игроку нужно читать описание того, что
// на нём висит.
type ConditionService interface {
	List(ctx context.Context) ([]*domain.Condition, error)
	Get(ctx context.Context, id string) (*domain.Condition, error)
	// BySlug — карточка по машинному ключу (domain.Condition.Slug), nil если
	// такой нет. Нужна Room-у, чтобы при наложении метки сделать снимок
	// имени/иконки/цвета, не доверяя их клиенту (см. Room.handleApplyStatus).
	// Уникальность slug'а нигде не обеспечивается — при дублях побеждает
	// первая в алфавитном порядке имени (порядок List), см. domain.Condition.
	BySlug(ctx context.Context, slug string) (*domain.Condition, error)
	// Create принимает Name — создаёт пустую карточку и сразу отдаёт её на
	// редактирование/импорт (как ReferenceService.Create).
	Create(ctx context.Context, name string) (*domain.Condition, error)
	// Update перезаписывает карточку целиком — ID/UpdatedAt/System сервис
	// проставляет сам, клиентские значения игнорирует.
	Update(ctx context.Context, id string, c domain.Condition) (*domain.Condition, error)
	Delete(ctx context.Context, id string) error
}

type conditionService struct {
	conditions repository.ConditionRepository
}

func NewConditionService(conditions repository.ConditionRepository) ConditionService {
	return &conditionService{conditions: conditions}
}

func validateConditionName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 120 {
		return "", &domain.ValidationError{Msg: "имя состояния обязательно (до 120 символов)"}
	}
	return name, nil
}

// NormalizeConditionSlug — приведение машинного ключа к каноничному виду
// (нижний регистр, пробелы/подчёркивания в дефис, всё остальное вырезано).
// Экспортируется, потому что тем же ключом ходят команды наложения метки в
// Room (см. handleApplyStatus): клиент присылает slug строкой, и «Prone» из
// ручного ввода должно найти ту же карточку, что "prone" из импорта Foundry.
func NormalizeConditionSlug(slug string) string {
	s := strings.ToLower(strings.TrimSpace(slug))
	s = strings.NewReplacer(" ", "-", "_", "-", ".", "-").Replace(s)
	s = conditionSlugChars.ReplaceAllString(s, "")
	s = strings.Trim(s, "-")
	return clampRunes(s, 60)
}

// sanitizeCondition — клампит текстовые поля/теги/уровни так же, как
// sanitizeReference клампит карточку справочника: молча, без ошибки.
func sanitizeCondition(c domain.Condition) domain.Condition {
	c.Slug = NormalizeConditionSlug(c.Slug)
	c.Source = clampRunes(c.Source, maxConditionShortText)
	c.ImageURL = clampRunes(c.ImageURL, maxConditionShortText)
	c.Color = clampRunes(c.Color, 32)
	// Icon — один глиф-эмодзи (см. domain.Condition.Icon). Режем по рунам, а
	// не по байтам: эмодзи многобайтовый, и составные (с модификаторами кожи/
	// ZWJ-склейки вроде 🧝‍♀️) занимают несколько рун — 8 хватает любому
	// разумному варианту и всё равно отсекает вставленный целиком абзац.
	c.Icon = clampRunes(strings.TrimSpace(c.Icon), 8)
	c.Description = clampRunes(c.Description, maxConditionLongText)
	c.Mechanics = clampRunes(c.Mechanics, maxConditionText)
	c.Modifiers = sanitizeModifiers(c.Modifiers)
	if c.Levels < 0 {
		c.Levels = 0
	}
	if c.Levels > maxConditionLevels {
		c.Levels = maxConditionLevels
	}
	if c.DefaultRounds < 0 {
		c.DefaultRounds = 0
	}
	if c.DefaultRounds > maxStatusRounds {
		c.DefaultRounds = maxStatusRounds
	}
	if len(c.Riders) > maxConditionRiders {
		c.Riders = c.Riders[:maxConditionRiders]
	}
	riders := make([]string, 0, len(c.Riders))
	seen := make(map[string]bool, len(c.Riders))
	for _, r := range c.Riders {
		r = NormalizeConditionSlug(r)
		// Пустое — не ссылка; собственный slug в своих же rider'ах —
		// гарантированная петля (см. domain.Condition.Riders); дубль —
		// лишний чип в конструкторе и лишний проход при наложении.
		if r == "" || r == c.Slug || seen[r] {
			continue
		}
		seen[r] = true
		riders = append(riders, r)
	}
	c.Riders = riders
	if len(c.Tags) > maxConditionTags {
		c.Tags = c.Tags[:maxConditionTags]
	}
	for i := range c.Tags {
		c.Tags[i] = clampRunes(strings.TrimSpace(c.Tags[i]), 60)
	}
	return c
}

func (s *conditionService) List(ctx context.Context) ([]*domain.Condition, error) {
	return s.conditions.List(ctx)
}

func (s *conditionService) Get(ctx context.Context, id string) (*domain.Condition, error) {
	return s.conditions.Get(ctx, id)
}

func (s *conditionService) BySlug(ctx context.Context, slug string) (*domain.Condition, error) {
	slug = NormalizeConditionSlug(slug)
	if slug == "" {
		return nil, domain.ErrNotFound
	}
	list, err := s.conditions.List(ctx)
	if err != nil {
		return nil, err
	}
	for _, c := range list {
		if NormalizeConditionSlug(c.Slug) == slug {
			return c, nil
		}
	}
	return nil, domain.ErrNotFound
}

func (s *conditionService) Create(ctx context.Context, name string) (*domain.Condition, error) {
	name, err := validateConditionName(name)
	if err != nil {
		return nil, err
	}
	c := domain.NewCondition(newID(), name)
	// Slug из имени НЕ выводим: имя русское, а slug должен быть латинским
	// кодом, совпадающим с кодом Foundry ("blinded" у «Ослепления») —
	// угадать его из имени нельзя, это осознанный ввод ДМ в конструкторе
	// (см. web/src/pages/conditions.js). Пустой slug — валидное состояние
	// карточки: она просто не участвует в сопоставлении с импортом.
	c.UpdatedAt = time.Now()
	if err := s.conditions.Create(ctx, c.ID, c); err != nil {
		return nil, err
	}
	return c, nil
}

func (s *conditionService) Update(ctx context.Context, id string, c domain.Condition) (*domain.Condition, error) {
	name, err := validateConditionName(c.Name)
	if err != nil {
		return nil, err
	}
	c.Name = name
	c = sanitizeCondition(c)
	c.ID = id
	c.UpdatedAt = time.Now()
	found, err := s.conditions.Update(ctx, id, &c)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, domain.ErrNotFound
	}
	return &c, nil
}

func (s *conditionService) Delete(ctx context.Context, id string) error {
	return s.conditions.Delete(ctx, id)
}
