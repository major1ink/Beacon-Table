package service

import (
	"context"
	"testing"
	"time"

	"beacon-table/internal/domain"
	"beacon-table/internal/excalidraw"
	"beacon-table/internal/repository/boardfile"
)

// fakeBoardClient — подключение к доске в тестах: складывает всё, что ему
// прислали, в канал.
type fakeBoardClient struct {
	id      string
	name    string
	canEdit bool
	got     chan map[string]any
	closed  bool
}

func newFakeBoardClient(id, name string, canEdit bool) *fakeBoardClient {
	return &fakeBoardClient{id: id, name: name, canEdit: canEdit, got: make(chan map[string]any, 32)}
}

func (c *fakeBoardClient) Send(v any) {
	m, _ := v.(map[string]any)
	select {
	case c.got <- m:
	default:
	}
}
func (c *fakeBoardClient) Close()              { c.closed = true }
func (c *fakeBoardClient) AccountID() string   { return c.id }
func (c *fakeBoardClient) AccountName() string { return c.name }
func (c *fakeBoardClient) CanEdit() bool       { return c.canEdit }

// waitFor ждёт сообщение нужного типа. Актор работает в своей горутине, так
// что «ничего не пришло» надо отличать от «ещё не пришло».
func (c *fakeBoardClient) waitFor(t *testing.T, typ string) map[string]any {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case m := <-c.got:
			if m["type"] == typ {
				return m
			}
		case <-deadline:
			t.Fatalf("не дождались сообщения %q для %s", typ, c.id)
			return nil
		}
	}
}

// quiet проверяет, что сообщения такого типа НЕ приходило.
func (c *fakeBoardClient) quiet(t *testing.T, typ string) {
	t.Helper()
	deadline := time.After(200 * time.Millisecond)
	for {
		select {
		case m := <-c.got:
			if m["type"] == typ {
				t.Fatalf("пришло лишнее сообщение %q для %s", typ, c.id)
			}
		case <-deadline:
			return
		}
	}
}

func elem(id string, version, nonce int64, x float64) *excalidraw.Element {
	return &excalidraw.Element{ID: id, Type: excalidraw.TypeRectangle, X: x, Version: version, VersionNonce: nonce}
}

func boardHubWith(t *testing.T, elements ...*excalidraw.Element) (*BoardHub, string) {
	t.Helper()
	dir := t.TempDir()
	store := boardfile.NewStore(dir)
	svc := NewBoardService(store)
	b, err := svc.Create(context.Background(), gwen, BoardDraft{Name: "Схема"})
	if err != nil {
		t.Fatal(err)
	}
	if len(elements) > 0 {
		doc := excalidraw.NewDocument()
		doc.Scene.Elements = elements
		if _, err := store.SetScene(context.Background(), b.ID, doc); err != nil {
			t.Fatal(err)
		}
	}
	return NewBoardHub(store), b.ID
}

// Правка одного долетает до соседа и не возвращается автору эхом.
func TestBoardRoomRelaysChanges(t *testing.T) {
	hub, id := boardHubWith(t)
	defer hub.Shutdown()

	a := newFakeBoardClient("acc-a", "Гвен", true)
	b := newFakeBoardClient("acc-b", "Том", true)
	sa, err := hub.Open(context.Background(), id, a)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := hub.Open(context.Background(), id, b); err != nil {
		t.Fatal(err)
	}
	a.waitFor(t, "board_snapshot")
	b.waitFor(t, "board_snapshot")

	sa.Dispatch(BoardMsg{Type: "board_change", Elements: []*excalidraw.Element{elem("r1", 1, 10, 5)}})

	got := b.waitFor(t, "board_change")
	els, _ := got["elements"].([]*excalidraw.Element)
	if len(els) != 1 || els[0].ID != "r1" {
		t.Fatalf("сосед не получил правку: %+v", got)
	}
	a.quiet(t, "board_change")
}

// Кто не вправе править — не правит, даже если прислал сообщение сам.
func TestBoardRoomIgnoresReadOnlyClient(t *testing.T) {
	hub, id := boardHubWith(t)
	defer hub.Shutdown()

	viewer := newFakeBoardClient("acc-v", "Зритель", false)
	editor := newFakeBoardClient("acc-e", "Автор", true)
	sv, err := hub.Open(context.Background(), id, viewer)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := hub.Open(context.Background(), id, editor); err != nil {
		t.Fatal(err)
	}
	viewer.waitFor(t, "board_snapshot")
	editor.waitFor(t, "board_snapshot")

	sv.Dispatch(BoardMsg{Type: "board_change", Elements: []*excalidraw.Element{elem("r1", 1, 10, 5)}})
	editor.quiet(t, "board_change")
}

// Порядок прихода правок не должен решать: побеждает больший version, при
// равном — больший versionNonce. Именно так сводит правки сам Excalidraw.
func TestBoardRoomKeepsNewerElement(t *testing.T) {
	hub, id := boardHubWith(t, elem("r1", 5, 100, 0))
	defer hub.Shutdown()

	a := newFakeBoardClient("acc-a", "Гвен", true)
	b := newFakeBoardClient("acc-b", "Том", true)
	sa, err := hub.Open(context.Background(), id, a)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := hub.Open(context.Background(), id, b); err != nil {
		t.Fatal(err)
	}
	a.waitFor(t, "board_snapshot")
	b.waitFor(t, "board_snapshot")

	// Устаревшая правка не проходит и соседу не уезжает.
	sa.Dispatch(BoardMsg{Type: "board_change", Elements: []*excalidraw.Element{elem("r1", 4, 999, 42)}})
	b.quiet(t, "board_change")

	// Та же версия, но больший nonce — проходит.
	sa.Dispatch(BoardMsg{Type: "board_change", Elements: []*excalidraw.Element{elem("r1", 5, 101, 7)}})
	got := b.waitFor(t, "board_change")
	els, _ := got["elements"].([]*excalidraw.Element)
	if len(els) != 1 || els[0].X != 7 {
		t.Fatalf("более новая правка не принята: %+v", got)
	}
}

// Курсор соседа доходит и подписан отправителем, а не тем, что он прислал.
func TestBoardRoomRelaysCursor(t *testing.T) {
	hub, id := boardHubWith(t)
	defer hub.Shutdown()

	a := newFakeBoardClient("acc-a", "Гвен", true)
	b := newFakeBoardClient("acc-b", "Том", true)
	sa, err := hub.Open(context.Background(), id, a)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := hub.Open(context.Background(), id, b); err != nil {
		t.Fatal(err)
	}
	a.waitFor(t, "board_snapshot")
	b.waitFor(t, "board_snapshot")

	sa.Dispatch(BoardMsg{Type: "board_cursor", X: 10, Y: 20})
	got := b.waitFor(t, "board_cursor")
	if got["id"] != "acc-a" || got["name"] != "Гвен" || got["x"] != float64(10) {
		t.Fatalf("курсор пришёл не тем: %+v", got)
	}
}

// Ушедший последним дописывает доску на диск: правка не должна пропасть
// оттого, что окно закрыли раньше автосохранения.
func TestBoardRoomFlushesOnLastLeave(t *testing.T) {
	dir := t.TempDir()
	store := boardfile.NewStore(dir)
	svc := NewBoardService(store)
	b, err := svc.Create(context.Background(), gwen, BoardDraft{Name: "Схема"})
	if err != nil {
		t.Fatal(err)
	}
	hub := NewBoardHub(store)
	defer hub.Shutdown()

	c := newFakeBoardClient("acc-a", "Гвен", true)
	s, err := hub.Open(context.Background(), b.ID, c)
	if err != nil {
		t.Fatal(err)
	}
	c.waitFor(t, "board_snapshot")
	s.Dispatch(BoardMsg{Type: "board_change", Elements: []*excalidraw.Element{elem("r1", 1, 10, 5)}})
	// Дожидаемся, пока актор разберёт сообщение: Leave идёт тем же каналом
	// не гарантированно позже, поэтому синхронизируемся по курсору.
	s.Dispatch(BoardMsg{Type: "board_cursor"})
	s.Leave()

	doc, err := svc.Scene(context.Background(), gwen, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(doc.Scene.Elements) != 1 || doc.Scene.Elements[0].ID != "r1" {
		t.Fatalf("правка не сохранилась при закрытии: %+v", doc.Scene.Elements)
	}
}

// Новый подключившийся получает холст целиком, включая чужие правки, ещё не
// доехавшие до диска.
func TestBoardRoomSnapshotHasLiveEdits(t *testing.T) {
	hub, id := boardHubWith(t, elem("r0", 1, 1, 0))
	defer hub.Shutdown()

	a := newFakeBoardClient("acc-a", "Гвен", true)
	sa, err := hub.Open(context.Background(), id, a)
	if err != nil {
		t.Fatal(err)
	}
	a.waitFor(t, "board_snapshot")
	sa.Dispatch(BoardMsg{Type: "board_change", Elements: []*excalidraw.Element{elem("r1", 1, 10, 5)}})

	b := newFakeBoardClient("acc-b", "Том", false)
	if _, err := hub.Open(context.Background(), id, b); err != nil {
		t.Fatal(err)
	}
	got := b.waitFor(t, "board_snapshot")
	els, _ := got["elements"].([]*excalidraw.Element)
	if len(els) != 2 {
		t.Fatalf("в снимке не все элементы: %+v", els)
	}
	if got["canEdit"] != false {
		t.Errorf("наблюдателю обещали правку: %+v", got)
	}
}

// Доска, которую закрыли все, поднимается заново с диска — и с теми
// правками, что успели записаться.
func TestBoardHubReopensClosedBoard(t *testing.T) {
	hub, id := boardHubWith(t)
	defer hub.Shutdown()

	a := newFakeBoardClient("acc-a", "Гвен", true)
	sa, err := hub.Open(context.Background(), id, a)
	if err != nil {
		t.Fatal(err)
	}
	a.waitFor(t, "board_snapshot")
	sa.Dispatch(BoardMsg{Type: "board_change", Elements: []*excalidraw.Element{elem("r1", 1, 10, 5)}})
	sa.Dispatch(BoardMsg{Type: "board_cursor"})
	sa.Leave()

	b := newFakeBoardClient("acc-b", "Том", true)
	if _, err := hub.Open(context.Background(), id, b); err != nil {
		t.Fatal(err)
	}
	got := b.waitFor(t, "board_snapshot")
	els, _ := got["elements"].([]*excalidraw.Element)
	if len(els) != 1 || els[0].ID != "r1" {
		t.Fatalf("доска поднялась без правок: %+v", els)
	}
}

// Несуществующая доска — ошибка, а не пустая комната.
func TestBoardHubRejectsUnknownBoard(t *testing.T) {
	hub, _ := boardHubWith(t)
	defer hub.Shutdown()

	c := newFakeBoardClient("acc-a", "Гвен", true)
	if _, err := hub.Open(context.Background(), "нет-такой", c); err != domain.ErrNotFound {
		t.Fatalf("Open несуществующей доски = %v, ожидался ErrNotFound", err)
	}
}

// Картинка: доска хранит только соответствие fileId → адрес, сам файл лежит
// в загрузках стола.
func TestBoardRoomRelaysAndKeepsFiles(t *testing.T) {
	dir := t.TempDir()
	store := boardfile.NewStore(dir)
	svc := NewBoardService(store)
	b, err := svc.Create(context.Background(), gwen, BoardDraft{Name: "Схема"})
	if err != nil {
		t.Fatal(err)
	}
	hub := NewBoardHub(store)
	defer hub.Shutdown()

	a := newFakeBoardClient("acc-a", "Гвен", true)
	other := newFakeBoardClient("acc-b", "Том", true)
	sa, err := hub.Open(context.Background(), b.ID, a)
	if err != nil {
		t.Fatal(err)
	}
	so, err := hub.Open(context.Background(), b.ID, other)
	if err != nil {
		t.Fatal(err)
	}
	a.waitFor(t, "board_snapshot")
	other.waitFor(t, "board_snapshot")

	sa.Dispatch(BoardMsg{Type: "board_files", Files: []BoardFile{{FileID: "f1", URL: "/uploads/boards/1-map.png"}}})
	got := other.waitFor(t, "board_files")
	files, _ := got["files"].([]BoardFile)
	if len(files) != 1 || files[0].FileID != "f1" {
		t.Fatalf("сосед не получил картинку: %+v", got)
	}

	// На диск доска пишется, когда её закрыл последний, — уводим обоих.
	sa.Dispatch(BoardMsg{Type: "board_cursor"})
	sa.Leave()
	so.Leave()

	doc, err := svc.Scene(context.Background(), gwen, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(doc.EmbeddedFiles) != 1 || doc.EmbeddedFiles[0].Link != "/uploads/boards/1-map.png" {
		t.Fatalf("картинка не сохранилась в файле доски: %+v", doc.EmbeddedFiles)
	}
	// Свежеподключившийся получает список в снимке.
	c := newFakeBoardClient("acc-c", "Гость", false)
	if _, err := hub.Open(context.Background(), b.ID, c); err != nil {
		t.Fatal(err)
	}
	snap := c.waitFor(t, "board_snapshot")
	if list, _ := snap["files"].([]BoardFile); len(list) != 1 {
		t.Fatalf("в снимке нет картинок: %+v", snap["files"])
	}
}

// Адрес принимаем только внутри стола: иначе доска стала бы способом заставить
// чужой браузер сходить на посторонний сайт.
func TestBoardRoomRejectsForeignFileURL(t *testing.T) {
	hub, id := boardHubWith(t)
	defer hub.Shutdown()

	a := newFakeBoardClient("acc-a", "Гвен", true)
	other := newFakeBoardClient("acc-b", "Том", true)
	sa, err := hub.Open(context.Background(), id, a)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := hub.Open(context.Background(), id, other); err != nil {
		t.Fatal(err)
	}
	a.waitFor(t, "board_snapshot")
	other.waitFor(t, "board_snapshot")

	for _, bad := range []string{
		"https://example.com/x.png",
		"//example.com/x.png",
		"/uploads/../../etc/passwd",
		"data:image/png;base64,AAAA",
	} {
		sa.Dispatch(BoardMsg{Type: "board_files", Files: []BoardFile{{FileID: "f", URL: bad}}})
	}
	other.quiet(t, "board_files")
}

// Наблюдателю картинки не добавить.
func TestBoardRoomIgnoresFilesFromReadOnly(t *testing.T) {
	hub, id := boardHubWith(t)
	defer hub.Shutdown()

	viewer := newFakeBoardClient("acc-v", "Зритель", false)
	editor := newFakeBoardClient("acc-e", "Автор", true)
	sv, err := hub.Open(context.Background(), id, viewer)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := hub.Open(context.Background(), id, editor); err != nil {
		t.Fatal(err)
	}
	viewer.waitFor(t, "board_snapshot")
	editor.waitFor(t, "board_snapshot")

	sv.Dispatch(BoardMsg{Type: "board_files", Files: []BoardFile{{FileID: "f1", URL: "/uploads/boards/x.png"}}})
	editor.quiet(t, "board_files")
}
