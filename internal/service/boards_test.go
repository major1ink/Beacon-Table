package service

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"beacon-table/internal/domain"
	"beacon-table/internal/excalidraw"
	"beacon-table/internal/repository/boardfile"
)

// Тесты идут через настоящее файловое хранилище (boardfile во временном
// каталоге), а не через фейк: у досок вся не-тривиальная часть — это права,
// и подменять хранилище значило бы проверять их поверх выдуманного
// поведения. Заодно на каждом прогоне проверяется, что шапка файла
// переживает запись и чтение.

func boardsSvc(t *testing.T) BoardService {
	t.Helper()
	return NewBoardService(boardfile.NewStore(t.TempDir()))
}

// gwen/tom/dm объявлены в journal_test.go — пакет тот же, и права у досок с
// журналом общие, так что и подопытные те же. guest нужен только тут: игрок,
// которому не выдано вообще ничего.
var guest = domain.JournalViewer{ID: "acc-guest", Name: "Гость"}

func TestBoardPersonalIsInvisibleToOthers(t *testing.T) {
	ctx := context.Background()
	s := boardsSvc(t)

	// Личная доска: уровень по умолчанию закрыт, персональных выдач нет.
	b, err := s.Create(ctx, gwen, BoardDraft{Name: "Мои связи NPC", Default: domain.JournalNone})
	if err != nil {
		t.Fatal(err)
	}
	if b.OwnerID != "acc-gwen" || b.OwnerName != "Гвен" {
		t.Errorf("автор = %q/%q, ожидался acc-gwen/Гвен", b.OwnerID, b.OwnerName)
	}

	// Автор её видит, посторонний игрок — нет, ДМ видит всё.
	for _, c := range []struct {
		v    domain.JournalViewer
		want int
	}{{gwen, 1}, {tom, 0}, {dm, 1}} {
		list, err := s.List(ctx, c.v)
		if err != nil {
			t.Fatal(err)
		}
		if len(list) != c.want {
			t.Errorf("%s видит %d досок, ожидалось %d", c.v.Name, len(list), c.want)
		}
	}

	// Постороннему — именно «не найдено», а не «нет прав»: иначе ответ сам
	// сообщал бы, что такая доска существует.
	if _, err := s.Get(ctx, tom, b.ID); err != domain.ErrNotFound {
		t.Errorf("Get чужой личной доски = %v, ожидался ErrNotFound", err)
	}
}

func TestBoardSharedIsVisibleToTable(t *testing.T) {
	ctx := context.Background()
	s := boardsSvc(t)

	b, err := s.Create(ctx, gwen, BoardDraft{Name: "Схема расследования", Default: domain.JournalObserver})
	if err != nil {
		t.Fatal(err)
	}
	if !b.IsShared() {
		t.Error("доска с default=observer должна считаться общей")
	}
	got, err := s.Get(ctx, tom, b.ID)
	if err != nil {
		t.Fatalf("общая доска не видна другому игроку: %v", err)
	}
	// Видит, но не правит: observer — это чтение.
	if got.CanEdit(tom) {
		t.Error("observer не должен получать право правки")
	}
	if !got.CanEdit(gwen) {
		t.Error("автор должен править свою доску")
	}
}

func TestBoardPointwiseGrant(t *testing.T) {
	ctx := context.Background()
	s := boardsSvc(t)

	b, err := s.Create(ctx, gwen, BoardDraft{
		Name:    "Наброски карты мира",
		Default: domain.JournalNone,
		Access:  map[string]domain.JournalAccess{"acc-tom": domain.JournalOwner},
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.Get(ctx, tom, b.ID)
	if err != nil {
		t.Fatalf("точечная выдача не сработала: %v", err)
	}
	if !got.CanEdit(tom) {
		t.Error("выданный owner должен править")
	}
	// «Дал поправить» не значит «дал раздавать ключи».
	if got.CanManage(tom) {
		t.Error("выданный owner не должен распоряжаться правами")
	}
	if _, err := s.Rename(ctx, tom, b.ID, "Переименовал"); err != domain.ErrForbidden {
		t.Errorf("Rename чужой доски = %v, ожидался ErrForbidden", err)
	}
	if _, err := s.Get(ctx, guest, b.ID); err != domain.ErrNotFound {
		t.Errorf("посторонний видит доску: %v", err)
	}
}

func TestBoardRenameAndDeleteOnlyByOwnerOrDM(t *testing.T) {
	ctx := context.Background()
	s := boardsSvc(t)

	b, err := s.Create(ctx, gwen, BoardDraft{Name: "Черновик", Default: domain.JournalObserver})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Rename(ctx, tom, b.ID, "Чужими руками"); err != domain.ErrForbidden {
		t.Errorf("Rename игроком-читателем = %v, ожидался ErrForbidden", err)
	}
	renamed, err := s.Rename(ctx, gwen, b.ID, "  Схема   ")
	if err != nil {
		t.Fatal(err)
	}
	if renamed.Name != "Схема" {
		t.Errorf("имя = %q, ожидалось обрезанное «Схема»", renamed.Name)
	}
	// Права после переименования не потерялись — шапка переписывается целиком.
	if !renamed.IsShared() {
		t.Error("переименование сбросило раздачу прав")
	}

	if err := s.Delete(ctx, tom, b.ID); err != domain.ErrForbidden {
		t.Errorf("Delete игроком-читателем = %v, ожидался ErrForbidden", err)
	}
	if err := s.Delete(ctx, dm, b.ID); err != nil {
		t.Fatalf("ДМ не смог удалить доску: %v", err)
	}
	if _, err := s.Get(ctx, dm, b.ID); err != domain.ErrNotFound {
		t.Errorf("доска пережила удаление: %v", err)
	}
}

func TestBoardSetAccessOpensAndCloses(t *testing.T) {
	ctx := context.Background()
	s := boardsSvc(t)

	b, err := s.Create(ctx, gwen, BoardDraft{Name: "Тайное", Default: domain.JournalNone})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetAccess(ctx, gwen, b.ID, domain.JournalObserver, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get(ctx, tom, b.ID); err != nil {
		t.Fatalf("после открытия доска не видна столу: %v", err)
	}
	// И обратно: закрыли — снова невидима.
	if _, err := s.SetAccess(ctx, gwen, b.ID, domain.JournalNone, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get(ctx, tom, b.ID); err != domain.ErrNotFound {
		t.Errorf("после закрытия доска всё ещё видна: %v", err)
	}
}

func TestBoardNameValidation(t *testing.T) {
	ctx := context.Background()
	s := boardsSvc(t)

	for _, name := range []string{"", "   ", "\n\t "} {
		if _, err := s.Create(ctx, gwen, BoardDraft{Name: name}); err == nil {
			t.Errorf("доска с именем %q создалась", name)
		}
	}
	// Перевод строки в имени сломал бы разбор шапки файла — его вычищаем.
	b, err := s.Create(ctx, gwen, BoardDraft{Name: "Схема\nрасследования"})
	if err != nil {
		t.Fatal(err)
	}
	if b.Name != "Схема расследования" {
		t.Errorf("имя = %q, ожидалось без переводов строки", b.Name)
	}
}

// ---- импорт из Excalidraw ----

// excalidrawFile — минимальный, но настоящий по форме файл плагина: шапка,
// раздел подписей и рисунок несжатым блоком. Сжатый вариант проверяется в
// internal/excalidraw (там же, где живёт распаковка), тут важно другое —
// что импорт заводит доску и не теряет содержимое.
const excalidrawFile = "---\n" +
	"excalidraw-plugin: parsed\ntags: [excalidraw]\n" +
	"---\n\n# Excalidraw Data\n\n## Text Elements\nЗдесь ловушка ^t1\n\n" +
	"%%\n## Drawing\n```json\n" +
	`{"type":"excalidraw","version":2,"elements":[` +
	`{"id":"r1","type":"rectangle","x":10,"y":20,"width":30,"height":40,"strokeColor":"#2f9e44","чужоеПоле":1},` +
	`{"id":"t1","type":"text","x":0,"y":0,"width":5,"height":5,"text":"Здесь ловушка","rawText":"Здесь ловушка"}` +
	`],"appState":{"viewBackgroundColor":"#fffce8"},"files":{}}` +
	"\n```\n%%\n"

func TestBoardImportKeepsSceneAndOwnership(t *testing.T) {
	ctx := context.Background()
	s := boardsSvc(t)

	b, err := s.Import(ctx, gwen, "Сессия 55", []byte(excalidrawFile))
	if err != nil {
		t.Fatalf("импорт: %v", err)
	}
	if b.Name != "Сессия 55" {
		t.Errorf("имя = %q", b.Name)
	}
	// Импортировавший становится автором, доска заводится закрытой: открыть
	// столу чужой рисунок должен человек, а не импорт.
	if b.OwnerID != "acc-gwen" {
		t.Errorf("автор = %q, ожидался acc-gwen", b.OwnerID)
	}
	if b.IsShared() {
		t.Error("импортированная доска не должна быть сразу общей")
	}

	doc, err := s.Scene(ctx, gwen, b.ID)
	if err != nil {
		t.Fatalf("холст: %v", err)
	}
	if len(doc.Scene.Elements) != 2 {
		t.Fatalf("элементов %d, ожидалось 2", len(doc.Scene.Elements))
	}
	if doc.Scene.Elements[0].StrokeColor != "#2f9e44" {
		t.Errorf("цвет не доехал: %q", doc.Scene.Elements[0].StrokeColor)
	}
	// Незнакомое поле обязано пережить запись на диск и чтение обратно —
	// иначе импорт из версии плагина новее нашей терял бы данные молча.
	if len(doc.Scene.Elements[0].Extra) != 1 {
		t.Errorf("чужое поле потерялось: %+v", doc.Scene.Elements[0].Extra)
	}
	if !strings.Contains(string(doc.Scene.AppState), "fffce8") {
		t.Errorf("appState потерялся: %s", doc.Scene.AppState)
	}
}

func TestBoardImportRejectsForeignFile(t *testing.T) {
	ctx := context.Background()
	s := boardsSvc(t)

	for _, raw := range []string{
		"---\ntags: [note]\n---\n\nПросто заметка.\n",
		`{"type":"drawio","version":2,"elements":[]}`,
	} {
		if _, err := s.Import(ctx, gwen, "Не доска", []byte(raw)); err == nil {
			t.Errorf("чужой файл импортировался: %q", raw[:16])
		}
	}
}

func TestBoardSceneRespectsAccess(t *testing.T) {
	ctx := context.Background()
	s := boardsSvc(t)

	b, err := s.Import(ctx, gwen, "Тайная схема", []byte(excalidrawFile))
	if err != nil {
		t.Fatal(err)
	}
	// Чужому доски вообще нет.
	if _, err := s.Scene(ctx, tom, b.ID); err != domain.ErrNotFound {
		t.Errorf("Scene чужой доски = %v, ожидался ErrNotFound", err)
	}
	// «Только название» — доска в списке есть, а холста не видно.
	if _, err := s.SetAccess(ctx, gwen, b.ID, domain.JournalLimited, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get(ctx, tom, b.ID); err != nil {
		t.Fatalf("доска с limited не видна в списке: %v", err)
	}
	if _, err := s.Scene(ctx, tom, b.ID); err != domain.ErrForbidden {
		t.Errorf("Scene при limited = %v, ожидался ErrForbidden", err)
	}
}

// TestBoardFileIsExcalidrawFile — файл доски должен открываться плагином в
// ваулте: и наши ключи, и служебные ключи плагина в одной шапке.
func TestBoardFileIsExcalidrawFile(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s := NewBoardService(boardfile.NewStore(dir))

	b, err := s.Create(ctx, gwen, BoardDraft{Name: "Пустая"})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, b.ID+".md"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"excalidraw-plugin: parsed", "tags: [excalidraw]", "name: Пустая", "# Excalidraw Data", "```json"} {
		if !strings.Contains(string(raw), want) {
			t.Errorf("в файле доски нет %q:\n%s", want, raw)
		}
	}
	// Даже пустая доска — валидный файл Excalidraw, а не заготовка.
	if _, err := excalidraw.ParseDocument(string(raw)); err != nil {
		t.Errorf("файл пустой доски не разбирается как Excalidraw: %v", err)
	}
}
