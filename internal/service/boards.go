package service

import (
	"context"
	"strings"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository"
)

// maxBoardName — предел длины имени доски. Не правило, а защита от строки на
// мегабайт со стороны клиента: имя целиком уезжает в шапку файла и в список.
const maxBoardName = 120

// maxBoardsPerTable — санитарный предел числа досок. Досок за столом
// единицы-десятки (схема расследования, связи NPC, наброски карты), тысяча —
// признак не работы, а зациклившегося клиента.
const maxBoardsPerTable = 200

// BoardService — доски стола: бесконечные холсты рядом с заметками, каждый со
// своим автором и раздачей прав (см. domain.Board). Доска с открытым
// уровнем по умолчанию — общая на стол, с закрытым — личная; и тех и других
// может быть сколько угодно одновременно.
//
// Как и у журнала, КАЖДЫЙ метод принимает domain.JournalViewer и сам
// проверяет права: authorization живёт здесь, а не в HTTP-слое, где есть
// только «admin/не admin», и не в репозитории, который про права ничего не
// решает.
type BoardService interface {
	// List — доски, которые viewer'у хотя бы видно (>= JournalLimited).
	List(ctx context.Context, v domain.JournalViewer) ([]*domain.Board, error)
	// Get — одна доска. Не найдена или не видна — ErrNotFound (см. Get у
	// журнала: «нет доступа» само по себе сообщало бы, что она существует).
	Get(ctx context.Context, v domain.JournalViewer, id string) (*domain.Board, error)
	// Create заводит доску от лица viewer'а: он становится её автором.
	Create(ctx context.Context, v domain.JournalViewer, draft BoardDraft) (*domain.Board, error)
	// Rename — только автор и ДМ (см. domain.Sharing.CanManage).
	Rename(ctx context.Context, v domain.JournalViewer, id, name string) (*domain.Board, error)
	// SetAccess переписывает раздачу прав — только автор и ДМ.
	SetAccess(ctx context.Context, v domain.JournalViewer, id string, def domain.JournalAccess, access map[string]domain.JournalAccess) (*domain.Board, error)
	// Delete удаляет доску — только автор и ДМ.
	Delete(ctx context.Context, v domain.JournalViewer, id string) error
}

// BoardDraft — что клиент присылает на создание доски. Отдельный тип, а не
// три аргумента подряд: права приезжают сразу с именем (кто заводит доску,
// тот в той же форме и решает, общая она или личная).
type BoardDraft struct {
	Name    string
	Default domain.JournalAccess
	Access  map[string]domain.JournalAccess
}

type boardService struct {
	boards repository.BoardRepository
}

func NewBoardService(boards repository.BoardRepository) BoardService {
	return &boardService{boards: boards}
}

// validateBoardName — имя обязательно и в одну строку: оно уезжает в шапку
// файла, где перевод строки сломал бы разбор соседних полей.
func validateBoardName(name string) (string, error) {
	name = strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(name, "\r", " "), "\n", " "))
	if name == "" {
		return "", &domain.ValidationError{Msg: "у доски должно быть название"}
	}
	if len([]rune(name)) > maxBoardName {
		return "", &domain.ValidationError{Msg: "слишком длинное название доски"}
	}
	return name, nil
}

func (s *boardService) List(ctx context.Context, v domain.JournalViewer) ([]*domain.Board, error) {
	all, err := s.boards.List(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]*domain.Board, 0, len(all))
	for _, b := range all {
		if b.CanSee(v) {
			out = append(out, b)
		}
	}
	return out, nil
}

func (s *boardService) Get(ctx context.Context, v domain.JournalViewer, id string) (*domain.Board, error) {
	b, err := s.boards.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if !b.CanSee(v) {
		return nil, domain.ErrNotFound
	}
	return b, nil
}

func (s *boardService) Create(ctx context.Context, v domain.JournalViewer, draft BoardDraft) (*domain.Board, error) {
	name, err := validateBoardName(draft.Name)
	if err != nil {
		return nil, err
	}
	def, access, err := normalizeAccess(draft.Default, draft.Access)
	if err != nil {
		return nil, err
	}
	existing, err := s.boards.List(ctx)
	if err != nil {
		return nil, err
	}
	if len(existing) >= maxBoardsPerTable {
		return nil, &domain.ValidationError{Msg: "слишком много досок за столом"}
	}
	b := &domain.Board{
		ID:   newID(),
		Name: name,
		Sharing: domain.Sharing{
			OwnerID:   v.ID,
			OwnerName: v.Name,
			Default:   def,
			Access:    access,
		},
	}
	if err := s.boards.Create(ctx, b); err != nil {
		return nil, err
	}
	return s.boards.Get(ctx, b.ID)
}

// manageable — «доска существует и viewer вправе ею распоряжаться», общая
// проверка для Rename/SetAccess/Delete (см. одноимённый метод у журнала).
func (s *boardService) manageable(ctx context.Context, v domain.JournalViewer, id string) error {
	b, err := s.boards.Get(ctx, id)
	if err != nil {
		return err
	}
	if !b.CanSee(v) {
		return domain.ErrNotFound
	}
	if !b.CanManage(v) {
		return domain.ErrForbidden
	}
	return nil
}

func (s *boardService) Rename(ctx context.Context, v domain.JournalViewer, id, name string) (*domain.Board, error) {
	if err := s.manageable(ctx, v, id); err != nil {
		return nil, err
	}
	name, err := validateBoardName(name)
	if err != nil {
		return nil, err
	}
	found, err := s.boards.Rename(ctx, id, name)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, domain.ErrNotFound
	}
	return s.Get(ctx, v, id)
}

func (s *boardService) SetAccess(ctx context.Context, v domain.JournalViewer, id string, def domain.JournalAccess, access map[string]domain.JournalAccess) (*domain.Board, error) {
	if err := s.manageable(ctx, v, id); err != nil {
		return nil, err
	}
	def, access, err := normalizeAccess(def, access)
	if err != nil {
		return nil, err
	}
	found, err := s.boards.SetAccess(ctx, id, def, access)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, domain.ErrNotFound
	}
	return s.Get(ctx, v, id)
}

func (s *boardService) Delete(ctx context.Context, v domain.JournalViewer, id string) error {
	if err := s.manageable(ctx, v, id); err != nil {
		return err
	}
	return s.boards.Delete(ctx, id)
}
