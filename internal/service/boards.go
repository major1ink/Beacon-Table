package service

import (
	"context"
	"strings"

	"beacon-table/internal/domain"
	"beacon-table/internal/excalidraw"
	"beacon-table/internal/repository"
)

// maxBoardName — предел длины имени доски. Не правило, а защита от строки на
// мегабайт со стороны клиента: имя целиком уезжает в шапку файла и в список.
const maxBoardName = 120

// maxBoardsPerTable — санитарный предел числа досок. Досок за столом
// единицы-десятки (схема расследования, связи NPC, наброски карты), тысяча —
// признак не работы, а зациклившегося клиента.
const maxBoardsPerTable = 200

// maxBoardImportBytes / maxBoardElements — пределы импорта. Не правило, а
// защита от того, чтобы одним файлом положить стол: самый большой файл в
// живом ваулте, на котором это проверялось, — 90 КБ и 154 элемента.
const (
	maxBoardImportBytes = 16 << 20 // 16 МБ: с вшитыми картинками файл бывает толстым
	maxBoardElements    = 20000
)

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
	// Import заводит доску из файла Excalidraw (.excalidraw.md из ваулта
	// Obsidian либо голый .excalidraw). Права — как у Create: импортирующий
	// становится автором, доска заводится закрытой.
	//
	// images — уже загруженные в стол картинки, «имя файла в ваулте» → адрес:
	// в самой доске лежат только имена, а файлы приезжают отдельно (см.
	// handleBoardImport).
	Import(ctx context.Context, v domain.JournalViewer, name string, raw []byte, images map[string]string) (*BoardImport, error)
	// Scene — холст доски; нужен уровень чтения.
	Scene(ctx context.Context, v domain.JournalViewer, id string) (*excalidraw.Document, error)
	// Rename — только автор и ДМ (см. domain.Sharing.CanManage).
	Rename(ctx context.Context, v domain.JournalViewer, id, name string) (*domain.Board, error)
	// SetAccess переписывает раздачу прав — только автор и ДМ.
	SetAccess(ctx context.Context, v domain.JournalViewer, id string, def domain.JournalAccess, access map[string]domain.JournalAccess) (*domain.Board, error)
	// Delete удаляет доску — только автор и ДМ.
	Delete(ctx context.Context, v domain.JournalViewer, id string) error
}

// BoardImport — итог импорта. Кроме самой доски рассказывает, чего ей не
// хватило: молчаливый частичный импорт хуже честного «эту картинку не нашёл».
type BoardImport struct {
	Board *domain.Board
	// Notes — названия записей журнала, на которые ссылается доска. Сами
	// записи импорт не заводит: связь у нас по названию, и уже имеющиеся
	// подхватятся сами (см. web/src/board/links.js).
	Notes []string
	// MissingImages — картинки, которые доска называет, а файлов не дали.
	MissingImages []string
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
	return s.create(ctx, v, draft, nil)
}

// create — общее тело Create и Import: разница только в начальном холсте.
func (s *boardService) create(ctx context.Context, v domain.JournalViewer, draft BoardDraft, doc *excalidraw.Document) (*domain.Board, error) {
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
	if err := s.boards.Create(ctx, b, doc); err != nil {
		return nil, err
	}
	return s.boards.Get(ctx, b.ID)
}

// Import — доска из чужого файла Excalidraw. Отличается от Create ровно
// одним: холст берётся не пустой, а из файла. Имя, если его не задали,
// берётся из имени файла — так импорт десятка досок не требует придумывать
// названия заново.
func (s *boardService) Import(ctx context.Context, v domain.JournalViewer, name string, raw []byte, images map[string]string) (*BoardImport, error) {
	if len(raw) > maxBoardImportBytes {
		return nil, &domain.ValidationError{Msg: "файл слишком большой"}
	}
	doc, err := excalidraw.ParseDocument(string(raw))
	if err != nil {
		// Ошибка разбора — это сообщение пользователю («в файле нет блока
		// рисунка»), а не внутренний сбой: он выбрал не тот файл.
		return nil, &domain.ValidationError{Msg: err.Error()}
	}
	if len(doc.Scene.Elements) > maxBoardElements {
		return nil, &domain.ValidationError{Msg: "на доске слишком много элементов"}
	}
	missing := relinkImages(doc, images)
	b, err := s.create(ctx, v, BoardDraft{Name: name, Default: domain.JournalNone}, doc)
	if err != nil {
		return nil, err
	}
	return &BoardImport{Board: b, Notes: doc.Scene.NoteLinks(), MissingImages: missing}, nil
}

// relinkImages переписывает ссылки на картинки ваулта на адреса в загрузках
// стола и возвращает имена тех, для которых файла не дали. Файла у стола нет
// и не будет: ваулт ему недоступен, картинки приносит тот, кто импортирует.
func relinkImages(doc *excalidraw.Document, images map[string]string) []string {
	var missing []string
	for i, f := range doc.EmbeddedFiles {
		name := f.FileName()
		if name == "" {
			continue // уже наш адрес, а не ссылка ваулта
		}
		if url, ok := images[name]; ok {
			doc.EmbeddedFiles[i].Link = url
			continue
		}
		missing = append(missing, name)
	}
	return missing
}

func (s *boardService) Scene(ctx context.Context, v domain.JournalViewer, id string) (*excalidraw.Document, error) {
	b, err := s.boards.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if !b.CanSee(v) {
		return nil, domain.ErrNotFound
	}
	if !b.CanRead(v) {
		// «Только название» — видит доску в списке, но не её содержимое.
		return nil, domain.ErrForbidden
	}
	return s.boards.Scene(ctx, id)
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
