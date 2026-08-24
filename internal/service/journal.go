package service

import (
	"context"
	"strings"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository"
)

// maxJournalAccessEntries — санитарный предел числа персональных выдач на
// одну запись: за столом игроков единицы, а не тысячи, и раздутая шапка
// файла — признак не журнала, а мусора со стороны клиента.
const maxJournalAccessEntries = 64

// JournalService — журнал стола: общая на весь стол библиотека записей, в
// которой каждый пишет своё и сам решает, кому это видно и кому это можно
// править (см. domain.JournalEntry — модель прав фаундривская). В отличие от
// NoteService (личная вики ДМ, доступна только ему), сюда ходят и игроки —
// поэтому КАЖДЫЙ метод принимает domain.JournalViewer и сам проверяет права:
// authorization журнала живёт здесь, а не в HTTP-слое, где есть только
// «admin/не admin», и не в репозитории, который про права ничего не решает.
//
// ДМ видит и правит всё (GM в Foundry), автор — всегда владелец своей
// записи, остальным достаётся то, что автор выдал (Default/Access).
type JournalService interface {
	// List — записи, которые viewer'у хотя бы видно (>= JournalLimited), без
	// текста; у тех, где ему не положено читать, текст не поедет и в Get.
	List(ctx context.Context, v domain.JournalViewer) ([]*domain.JournalEntry, error)
	// Get — одна запись целиком. Если viewer'у положено только видеть её
	// (JournalLimited), Content пустой — это не ошибка, а фаундривское
	// «знаешь, что запись есть, но не что в ней».
	Get(ctx context.Context, v domain.JournalViewer, id string) (*domain.JournalEntry, error)
	// Create заводит запись от лица viewer'а: он становится её автором.
	Create(ctx context.Context, v domain.JournalViewer, draft JournalDraft) (*domain.JournalEntry, error)
	// Update меняет текст — нужен уровень JournalOwner (автор, ДМ или тот,
	// кому автор дал править).
	Update(ctx context.Context, v domain.JournalViewer, id, content string) (*domain.JournalEntry, error)
	// SetAccess переписывает раздачу прав — только автор и ДМ (см.
	// domain.JournalEntry.CanManage).
	SetAccess(ctx context.Context, v domain.JournalViewer, id string, def domain.JournalAccess, access map[string]domain.JournalAccess) (*domain.JournalEntry, error)
	// Move переносит запись в другую папку — только автор и ДМ.
	Move(ctx context.Context, v domain.JournalViewer, id, folder string) (*domain.JournalEntry, error)
	// Delete удаляет запись — только автор и ДМ.
	Delete(ctx context.Context, v domain.JournalViewer, id string) error

	// Folders — дерево папок журнала общее на весь стол (включая пустые):
	// папка сама по себе ничего не прячет, прячут права записей внутри.
	Folders(ctx context.Context) ([]string, error)
	CreateFolder(ctx context.Context, v domain.JournalViewer, folder string) error
	// DeleteFolder удаляет папку СО ВСЕМИ записями внутри — поэтому игроку
	// разрешено только если все записи в ней его собственные (иначе он одним
	// кликом сносил бы чужие); ДМ — всегда.
	DeleteFolder(ctx context.Context, v domain.JournalViewer, folder string) error
	RenameFolder(ctx context.Context, v domain.JournalViewer, from, to string) error
}

// JournalDraft — что клиент присылает на создание записи. Отдельный тип, а
// не пять аргументов подряд: права приезжают сразу с текстом (игрок ставит
// видимость в той же форме, где пишет заметку), и порядок строковых
// аргументов иначе легко перепутать.
type JournalDraft struct {
	Folder  string
	Content string
	Default domain.JournalAccess
	Access  map[string]domain.JournalAccess
}

type journalService struct {
	entries repository.JournalRepository
}

func NewJournalService(entries repository.JournalRepository) JournalService {
	return &journalService{entries: entries}
}

func validateJournalContent(content string) error {
	if len(content) > maxNoteContentBytes {
		return &domain.ValidationError{Msg: "запись журнала слишком большая (максимум 1 МБ)"}
	}
	return nil
}

// normalizeAccess — приводит присланную клиентом раздачу прав к тому, что
// имеет смысл хранить: неизвестные уровни отвергаем (а не молча считаем
// «none» — иначе опечатка в клиенте тихо ОТКРЫВАЛА бы запись по Default),
// пустые id и явные "none" выкидываем (отсутствие выдачи — это и есть none).
func normalizeAccess(def domain.JournalAccess, access map[string]domain.JournalAccess) (domain.JournalAccess, map[string]domain.JournalAccess, error) {
	if def == "" {
		def = domain.JournalNone
	}
	if !def.Valid() {
		return "", nil, &domain.ValidationError{Msg: "неизвестный уровень доступа по умолчанию"}
	}
	out := make(map[string]domain.JournalAccess, len(access))
	for id, level := range access {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if !level.Valid() {
			return "", nil, &domain.ValidationError{Msg: "неизвестный уровень доступа"}
		}
		if level == domain.JournalNone {
			continue
		}
		out[id] = level
	}
	if len(out) > maxJournalAccessEntries {
		return "", nil, &domain.ValidationError{Msg: "слишком много персональных прав на одну запись"}
	}
	return def, out, nil
}

func (s *journalService) List(ctx context.Context, v domain.JournalViewer) ([]*domain.JournalEntry, error) {
	all, err := s.entries.List(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]*domain.JournalEntry, 0, len(all))
	for _, e := range all {
		if e.CanSee(v) {
			out = append(out, e)
		}
	}
	return out, nil
}

func (s *journalService) Get(ctx context.Context, v domain.JournalViewer, id string) (*domain.JournalEntry, error) {
	e, err := s.entries.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if !e.CanSee(v) {
		// Именно ErrNotFound, а не ErrForbidden: «нет доступа» само по себе
		// сообщало бы, что такая запись существует.
		return nil, domain.ErrNotFound
	}
	if !e.CanRead(v) {
		e.Content = "" // JournalLimited — заголовок и автор, без текста
	}
	return e, nil
}

func (s *journalService) Create(ctx context.Context, v domain.JournalViewer, draft JournalDraft) (*domain.JournalEntry, error) {
	if err := validateJournalContent(draft.Content); err != nil {
		return nil, err
	}
	folder, err := validateNoteFolder(draft.Folder)
	if err != nil {
		return nil, err
	}
	def, access, err := normalizeAccess(draft.Default, draft.Access)
	if err != nil {
		return nil, err
	}
	e := &domain.JournalEntry{
		ID:        newID(),
		Folder:    folder,
		Content:   draft.Content,
		OwnerID:   v.ID,
		OwnerName: v.Name,
		Default:   def,
		Access:    access,
	}
	if err := s.entries.Create(ctx, e); err != nil {
		return nil, err
	}
	return s.entries.Get(ctx, e.ID)
}

// manageable — общая проверка «запись существует и viewer вправе ею
// распоряжаться» для SetAccess/Move/Delete.
func (s *journalService) manageable(ctx context.Context, v domain.JournalViewer, id string) (*domain.JournalEntry, error) {
	e, err := s.entries.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if !e.CanSee(v) {
		return nil, domain.ErrNotFound // см. Get: не подтверждаем существование
	}
	if !e.CanManage(v) {
		return nil, domain.ErrForbidden
	}
	return e, nil
}

func (s *journalService) Update(ctx context.Context, v domain.JournalViewer, id, content string) (*domain.JournalEntry, error) {
	if err := validateJournalContent(content); err != nil {
		return nil, err
	}
	e, err := s.entries.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if !e.CanSee(v) {
		return nil, domain.ErrNotFound
	}
	if !e.CanEdit(v) {
		return nil, domain.ErrForbidden
	}
	found, err := s.entries.Update(ctx, id, content)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, domain.ErrNotFound
	}
	return s.Get(ctx, v, id)
}

func (s *journalService) SetAccess(ctx context.Context, v domain.JournalViewer, id string, def domain.JournalAccess, access map[string]domain.JournalAccess) (*domain.JournalEntry, error) {
	if _, err := s.manageable(ctx, v, id); err != nil {
		return nil, err
	}
	def, access, err := normalizeAccess(def, access)
	if err != nil {
		return nil, err
	}
	found, err := s.entries.SetAccess(ctx, id, def, access)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, domain.ErrNotFound
	}
	return s.Get(ctx, v, id)
}

func (s *journalService) Move(ctx context.Context, v domain.JournalViewer, id, folder string) (*domain.JournalEntry, error) {
	if _, err := s.manageable(ctx, v, id); err != nil {
		return nil, err
	}
	folder, err := validateNoteFolder(folder)
	if err != nil {
		return nil, err
	}
	found, err := s.entries.Move(ctx, id, folder)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, domain.ErrNotFound
	}
	return s.Get(ctx, v, id)
}

func (s *journalService) Delete(ctx context.Context, v domain.JournalViewer, id string) error {
	if _, err := s.manageable(ctx, v, id); err != nil {
		return err
	}
	return s.entries.Delete(ctx, id)
}

func (s *journalService) Folders(ctx context.Context) ([]string, error) {
	return s.entries.Folders(ctx)
}

func (s *journalService) CreateFolder(ctx context.Context, v domain.JournalViewer, folder string) error {
	folder, err := validateNoteFolder(folder)
	if err != nil {
		return err
	}
	if folder == "" {
		return &domain.ValidationError{Msg: "имя папки обязательно"}
	}
	return s.entries.CreateFolder(ctx, folder)
}

func (s *journalService) DeleteFolder(ctx context.Context, v domain.JournalViewer, folder string) error {
	folder, err := validateNoteFolder(folder)
	if err != nil {
		return err
	}
	if folder == "" {
		return &domain.ValidationError{Msg: "нельзя удалить корень журнала"}
	}
	if !v.IsDM {
		// Игрок сносит папку только вместе со своими же записями — чужая
		// запись внутри превращает это в удаление чужого (см. DeleteFolder
		// в интерфейсе).
		all, err := s.entries.List(ctx)
		if err != nil {
			return err
		}
		for _, e := range all {
			if !inFolder(e.Folder, folder) {
				continue
			}
			if !e.CanManage(v) {
				return &domain.ValidationError{Msg: "в папке есть чужие записи — её может удалить только ДМ"}
			}
		}
	}
	return s.entries.DeleteFolder(ctx, folder)
}

func (s *journalService) RenameFolder(ctx context.Context, v domain.JournalViewer, from, to string) error {
	if !v.IsDM {
		// Переименование задевает чужие записи в той же папке — общее дерево
		// перекраивает только ДМ (создать свою папку игрок по-прежнему может).
		return domain.ErrForbidden
	}
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
	if err := s.entries.RenameFolder(ctx, from, to); err != nil {
		return &domain.ValidationError{Msg: err.Error()}
	}
	return nil
}

// inFolder — лежит ли запись в папке folder или в любой вложенной в неё.
func inFolder(entryFolder, folder string) bool {
	return entryFolder == folder || strings.HasPrefix(entryFolder, folder+"/")
}
