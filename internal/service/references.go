package service

import (
	"context"
	"strings"
	"time"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository"
)

// maxReferenceLongText/maxReferenceShortText — те же санитарные пределы, что
// и у Item/Monster (см. bestiary.go/items.go): не игровое правило, а защита
// от случайно вставленного гигантского текста в поле карточки.
const (
	maxReferenceLongText  = 20000 // Description — полный текст класса/архетипа/черты бывает длинным
	maxReferenceShortText = 300   // Source/Kind/ParentName/ImageURL
	maxReferenceTags      = 30
)

// ReferenceService — общая на весь стол библиотека карточек справочника
// (классы/архетипы/происхождения/виды/черты — см. domain.Reference.Kind,
// internal/repository/referencefile) — тот же use case, что и ItemService:
// доступна не только ДМ, и ДМ, и игроки создают/импортируют/правят (см.
// requireAccount в reference_handlers.go).
type ReferenceService interface {
	List(ctx context.Context) ([]*domain.Reference, error)
	Get(ctx context.Context, id string) (*domain.Reference, error)
	// Create принимает Name — создаёт пустую карточку и сразу отдаёт её на
	// редактирование/импорт (как ItemService.Create).
	Create(ctx context.Context, name string) (*domain.Reference, error)
	// Update перезаписывает карточку целиком — ID/UpdatedAt сервис
	// проставляет сам, клиентские значения игнорирует.
	Update(ctx context.Context, id string, ref domain.Reference) (*domain.Reference, error)
	Delete(ctx context.Context, id string) error
}

type referenceService struct {
	references repository.ReferenceRepository
}

func NewReferenceService(references repository.ReferenceRepository) ReferenceService {
	return &referenceService{references: references}
}

func validateReferenceName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 120 {
		return "", &domain.ValidationError{Msg: "имя записи справочника обязательно (до 120 символов)"}
	}
	return name, nil
}

// sanitizeReference — клампит текстовые поля/теги так же, как sanitizeItem
// клампит карточку предмета: молча, без ошибки — обычный клиент/импорт
// никогда специально не бьёт по этим лимитам.
func sanitizeReference(ref domain.Reference) domain.Reference {
	ref.ImageURL = clampRunes(ref.ImageURL, maxReferenceShortText)
	ref.Source = clampRunes(ref.Source, maxReferenceShortText)
	ref.Kind = clampRunes(ref.Kind, maxReferenceShortText)
	ref.ParentName = clampRunes(ref.ParentName, maxReferenceShortText)
	ref.Description = clampRunes(ref.Description, maxReferenceLongText)
	if len(ref.Tags) > maxReferenceTags {
		ref.Tags = ref.Tags[:maxReferenceTags]
	}
	for i := range ref.Tags {
		ref.Tags[i] = clampRunes(strings.TrimSpace(ref.Tags[i]), 60)
	}
	return ref
}

func (s *referenceService) List(ctx context.Context) ([]*domain.Reference, error) {
	return s.references.List(ctx)
}

func (s *referenceService) Get(ctx context.Context, id string) (*domain.Reference, error) {
	return s.references.Get(ctx, id)
}

func (s *referenceService) Create(ctx context.Context, name string) (*domain.Reference, error) {
	name, err := validateReferenceName(name)
	if err != nil {
		return nil, err
	}
	ref := domain.NewReference(newID(), name)
	ref.UpdatedAt = time.Now()
	if err := s.references.Create(ctx, ref.ID, ref); err != nil {
		return nil, err
	}
	return ref, nil
}

func (s *referenceService) Update(ctx context.Context, id string, ref domain.Reference) (*domain.Reference, error) {
	name, err := validateReferenceName(ref.Name)
	if err != nil {
		return nil, err
	}
	ref.Name = name
	ref = sanitizeReference(ref)
	ref.ID = id
	ref.UpdatedAt = time.Now()
	found, err := s.references.Update(ctx, id, &ref)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, domain.ErrNotFound
	}
	return &ref, nil
}

func (s *referenceService) Delete(ctx context.Context, id string) error {
	return s.references.Delete(ctx, id)
}
