package service

import (
	"context"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository"
)

// maxNoteContentBytes — санитарный предел размера заметки: не ограничение по
// смыслу (текстовые заметки ДМ реалистично на порядки меньше), а защита от
// случайно вставленного бинарника/огромного вставленного текста.
const maxNoteContentBytes = 1 << 20 // 1 МБ

// NoteService — библиотека заметок ДМ: настоящие .md-файлы (см.
// internal/repository/notefile), которые можно связывать между собой
// вики-ссылками [[...]] (резолвятся на клиенте, см. web/src/notes/markdown.js)
// и закреплять на карте значком (см. domain.NoteMarker).
type NoteService interface {
	List(ctx context.Context) ([]*domain.Note, error)
	Get(ctx context.Context, id string) (*domain.Note, error)
	Create(ctx context.Context, content string) (*domain.Note, error)
	Update(ctx context.Context, id, content string) (*domain.Note, error)
	Delete(ctx context.Context, id string) error
}

type noteService struct {
	notes repository.NoteRepository
}

func NewNoteService(notes repository.NoteRepository) NoteService {
	return &noteService{notes: notes}
}

func validateNoteContent(content string) error {
	if len(content) > maxNoteContentBytes {
		return &domain.ValidationError{Msg: "заметка слишком большая (максимум 1 МБ)"}
	}
	return nil
}

func (s *noteService) List(ctx context.Context) ([]*domain.Note, error) {
	return s.notes.List(ctx)
}

func (s *noteService) Get(ctx context.Context, id string) (*domain.Note, error) {
	return s.notes.Get(ctx, id)
}

func (s *noteService) Create(ctx context.Context, content string) (*domain.Note, error) {
	if err := validateNoteContent(content); err != nil {
		return nil, err
	}
	id := newID()
	if err := s.notes.Create(ctx, id, content); err != nil {
		return nil, err
	}
	return s.notes.Get(ctx, id)
}

func (s *noteService) Update(ctx context.Context, id, content string) (*domain.Note, error) {
	if err := validateNoteContent(content); err != nil {
		return nil, err
	}
	found, err := s.notes.Update(ctx, id, content)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, domain.ErrNotFound
	}
	return s.notes.Get(ctx, id)
}

func (s *noteService) Delete(ctx context.Context, id string) error {
	return s.notes.Delete(ctx, id)
}
