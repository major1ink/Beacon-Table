package service

import (
	"context"
	"strings"

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
	// Create кладёт заметку в папку folder ("" — корень, см.
	// domain.Note.Folder): дерево папок — часть библиотеки заметок, а не
	// только импорта (у пакетов Foundry журналы тоже разложены по папкам,
	// см. FoundryService).
	Create(ctx context.Context, folder, content string) (*domain.Note, error)
	Update(ctx context.Context, id, content string) (*domain.Note, error)
	// Move переносит заметку в другую папку, не трогая текст и id.
	Move(ctx context.Context, id, folder string) (*domain.Note, error)
	Delete(ctx context.Context, id string) error

	// Folders — все папки библиотеки, включая пустые.
	Folders(ctx context.Context) ([]string, error)
	CreateFolder(ctx context.Context, folder string) error
	// DeleteFolder удаляет папку вместе со всеми заметками внутри —
	// предупредить ДМ обязан UI (см. web/src/pages/dm.js).
	DeleteFolder(ctx context.Context, folder string) error
	RenameFolder(ctx context.Context, from, to string) error
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

// maxNoteFolderDepth/maxNoteFolderSegment — санитарные пределы дерева папок.
// Не правило, а защита от бесконечной вложенности из чужого импорта и от
// имён, которые не переживёт файловая система (папки — настоящие каталоги на
// диске, см. notefile).
const (
	maxNoteFolderDepth   = 8
	maxNoteFolderSegment = 80
)

// validateNoteFolder — нормализация пути папки: лишние слэши/пробелы долой,
// "." и ".." запрещены (репозиторий отклонил бы их и сам, но человеку нужно
// понятное сообщение, а не "недопустимое имя папки" из глубины). Возвращает
// канонический posix-путь; "" — корень библиотеки, это валидно.
func validateNoteFolder(folder string) (string, error) {
	folder = strings.TrimSpace(strings.ReplaceAll(folder, "\\", "/"))
	folder = strings.Trim(folder, "/")
	if folder == "" {
		return "", nil
	}
	parts := strings.Split(folder, "/")
	clean := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue // "Глава 1//NPC" — просто лишний слэш, не ошибка
		}
		if p == "." || p == ".." || strings.ContainsAny(p, `:*?"<>|`) {
			return "", &domain.ValidationError{Msg: "в имени папки нельзя использовать . .. : * ? \" < > |"}
		}
		if len([]rune(p)) > maxNoteFolderSegment {
			return "", &domain.ValidationError{Msg: "слишком длинное имя папки (максимум 80 символов)"}
		}
		clean = append(clean, p)
	}
	if len(clean) > maxNoteFolderDepth {
		return "", &domain.ValidationError{Msg: "слишком глубокая вложенность папок (максимум 8 уровней)"}
	}
	return strings.Join(clean, "/"), nil
}

func (s *noteService) List(ctx context.Context) ([]*domain.Note, error) {
	return s.notes.List(ctx)
}

func (s *noteService) Get(ctx context.Context, id string) (*domain.Note, error) {
	return s.notes.Get(ctx, id)
}

func (s *noteService) Create(ctx context.Context, folder, content string) (*domain.Note, error) {
	if err := validateNoteContent(content); err != nil {
		return nil, err
	}
	folder, err := validateNoteFolder(folder)
	if err != nil {
		return nil, err
	}
	id := newID()
	if err := s.notes.Create(ctx, id, folder, content); err != nil {
		return nil, err
	}
	return s.notes.Get(ctx, id)
}

func (s *noteService) Move(ctx context.Context, id, folder string) (*domain.Note, error) {
	folder, err := validateNoteFolder(folder)
	if err != nil {
		return nil, err
	}
	found, err := s.notes.Move(ctx, id, folder)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, domain.ErrNotFound
	}
	return s.notes.Get(ctx, id)
}

func (s *noteService) Folders(ctx context.Context) ([]string, error) {
	return s.notes.Folders(ctx)
}

func (s *noteService) CreateFolder(ctx context.Context, folder string) error {
	folder, err := validateNoteFolder(folder)
	if err != nil {
		return err
	}
	if folder == "" {
		return &domain.ValidationError{Msg: "имя папки обязательно"}
	}
	return s.notes.CreateFolder(ctx, folder)
}

func (s *noteService) DeleteFolder(ctx context.Context, folder string) error {
	folder, err := validateNoteFolder(folder)
	if err != nil {
		return err
	}
	if folder == "" {
		return &domain.ValidationError{Msg: "нельзя удалить корень библиотеки"}
	}
	return s.notes.DeleteFolder(ctx, folder)
}

func (s *noteService) RenameFolder(ctx context.Context, from, to string) error {
	from, err := validateNoteFolder(from)
	if err != nil {
		return err
	}
	to, err = validateNoteFolder(to)
	if err != nil {
		return err
	}
	if from == "" || to == "" {
		return &domain.ValidationError{Msg: "имя папки обязательно"}
	}
	if err := s.notes.RenameFolder(ctx, from, to); err != nil {
		// Ошибки переименования — «папка уже есть», «внутрь самой себя» —
		// это ответ человеку, а не сбой сервера (см. notefile.RenameFolder).
		return &domain.ValidationError{Msg: err.Error()}
	}
	return nil
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
