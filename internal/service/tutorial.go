package service

import (
	"context"
	"fmt"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository"
)

// tutorialStateKey — ключ в repository.ServerStateRepository, под которым
// лежит состояние режима обучения.
const tutorialStateKey = "tutorial"

// TutorialService — включён ли режим обучения ведущего (пошаговый тур по
// столу, см. web/src/tutorial.js). Глобальный, как BroadcastService: к
// запущенному миру не привязан.
type TutorialService interface {
	// State — одно из domain.Tutorial*; пусто, пока ведущего не спросили.
	State(ctx context.Context) (string, error)
	SetState(ctx context.Context, state string) error
}

type tutorialService struct {
	state repository.ServerStateRepository
}

// NewTutorialService собирает TutorialService поверх KV глобальных настроек.
func NewTutorialService(state repository.ServerStateRepository) TutorialService {
	return &tutorialService{state: state}
}

func (s *tutorialService) State(ctx context.Context) (string, error) {
	v, err := s.state.Get(ctx, tutorialStateKey)
	if err != nil {
		return "", err
	}
	if !domain.ValidTutorialState(v) {
		// Испорченное значение — не повод ломать экран миров: считаем, что
		// не спрашивали.
		return domain.TutorialUnset, nil
	}
	return v, nil
}

func (s *tutorialService) SetState(ctx context.Context, state string) error {
	if !domain.ValidTutorialState(state) {
		return fmt.Errorf("%w: неизвестное состояние обучения %q", domain.ErrValidation, state)
	}
	return s.state.Set(ctx, tutorialStateKey, state)
}
