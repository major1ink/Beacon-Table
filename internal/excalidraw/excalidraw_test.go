package excalidraw

import (
	"encoding/json"
	"strings"
	"testing"
)

// compressedVector — сцена ниже, сжатая lz-string compressToBase64.
//
// Взята не из живого ваулта (там чужие кампании, им не место в репозитории), а
// собрана эталонной реализацией lz-string. Проверка «наш распаковщик читает
// настоящие файлы плагина» делалась отдельно, прогоном по каталогу
// .excalidraw.md из реального ваулта: десять файлов, 508 элементов шести
// типов, все разобрались и пережили round-trip без единого неизвестного поля.
// Держать те файлы в тестах нельзя, поэтому здесь короткий вектор того же
// формата.
const compressedVector = "N4IgLgngDgpiBcIYA8DGBDANgSwCYCd0B3EAGhADcZ8BnbAewDsEAmcm+gV31TkTBg0wZJJhgBbGIzA0EAbVB4EIdAEYRkWMvwxUYdIwDmYkcgSryEVuSJ4wACwQBmcvZjZD94fAAsAXwBdcnQoKABlfQEEUApsGCIAIXRUAGtDfC5GXABhekx6fGUAYgAzMvKQP3IS7DFZeGA/PyA=="

const vectorJSON = `{"type":"excalidraw","version":2,"source":"test","elements":[{"id":"a1","type":"rectangle","x":1,"y":2,"width":3,"height":4}],"appState":{"viewBackgroundColor":"#ffffff"},"files":{}}`

func TestDecompressFromBase64(t *testing.T) {
	got, err := DecompressFromBase64(compressedVector)
	if err != nil {
		t.Fatalf("распаковка: %v", err)
	}
	if got != vectorJSON {
		t.Errorf("распаковалось не то:\n%s", got)
	}
}

func TestDecompressRejectsGarbage(t *testing.T) {
	// Обрезанный поток обязан вернуть ошибку, а не молча отдать полрисунка:
	// «половина доски» хуже, чем честный отказ импорта.
	if _, err := DecompressFromBase64(compressedVector[:20]); err == nil {
		t.Error("обрезанные данные разжались без ошибки")
	}
}

// mdWith собирает файл-конверт с указанным блоком рисунка.
func mdWith(fence, payload string) string {
	return "---\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n---\n" +
		"\n# Excalidraw Data\n\n## Text Elements\n\n%%\n## Drawing\n" +
		"```" + fence + "\n" + payload + "\n```\n%%\n"
}

func TestParseCompressedDocument(t *testing.T) {
	doc, err := ParseDocument(mdWith("compressed-json", compressedVector))
	if err != nil {
		t.Fatal(err)
	}
	if !doc.Compressed {
		t.Error("файл со сжатым блоком не помечен как сжатый")
	}
	if len(doc.Scene.Elements) != 1 || doc.Scene.Elements[0].ID != "a1" {
		t.Fatalf("элементы разобрались неверно: %+v", doc.Scene.Elements)
	}
	if !strings.Contains(doc.Frontmatter, "excalidraw-plugin: parsed") {
		t.Errorf("шапка потерялась: %q", doc.Frontmatter)
	}
}

func TestParsePlainJSONFence(t *testing.T) {
	doc, err := ParseDocument(mdWith("json", vectorJSON))
	if err != nil {
		t.Fatal(err)
	}
	if doc.Compressed {
		t.Error("несжатый блок помечен как сжатый")
	}
	if doc.Scene.Elements[0].Type != TypeRectangle {
		t.Errorf("тип элемента = %q", doc.Scene.Elements[0].Type)
	}
}

func TestParseHandlesCRLF(t *testing.T) {
	// В живом ваулте нашёлся файл с CRLF, и на нём разбор, ожидающий только
	// "\n", молча не находил рисунка вовсе — то есть импорт сказал бы
	// «в файле нет рисунка» о совершенно нормальном файле.
	crlf := strings.ReplaceAll(mdWith("json", vectorJSON), "\n", "\r\n")
	doc, err := ParseDocument(crlf)
	if err != nil {
		t.Fatalf("файл с CRLF не разобрался: %v", err)
	}
	if len(doc.Scene.Elements) != 1 {
		t.Errorf("элементов %d, ожидался один", len(doc.Scene.Elements))
	}
}

func TestParseBareExcalidrawJSON(t *testing.T) {
	// Голый .excalidraw без markdown-конверта — тоже валидный экспорт.
	doc, err := ParseDocument("  \n" + vectorJSON)
	if err != nil {
		t.Fatal(err)
	}
	if len(doc.Scene.Elements) != 1 {
		t.Errorf("элементов %d, ожидался один", len(doc.Scene.Elements))
	}
}

func TestParseEmbeddedFiles(t *testing.T) {
	md := "---\ntags: [excalidraw]\n---\n\n# Excalidraw Data\n\n" +
		"## Embedded Files\n" +
		"9c9ad8d5b209a8da9d6bb97adddc8a90d5b76a2c: [[Древо общий вид.png]]\n\n" +
		"7f4b225fe76e048c812ef78f105208cd713e2c68: [[Библиотека.png]]\n\n" +
		"%%\n## Drawing\n```json\n" + vectorJSON + "\n```\n%%\n"
	doc, err := ParseDocument(md)
	if err != nil {
		t.Fatal(err)
	}
	if len(doc.EmbeddedFiles) != 2 {
		t.Fatalf("картинок %d, ожидалось 2: %+v", len(doc.EmbeddedFiles), doc.EmbeddedFiles)
	}
	if doc.EmbeddedFiles[0].Link != "[[Древо общий вид.png]]" {
		t.Errorf("ссылка = %q", doc.EmbeddedFiles[0].Link)
	}
}

func TestParseRejectsNonExcalidraw(t *testing.T) {
	for _, raw := range []string{
		`{"type":"drawio","version":2,"elements":[]}`,
		"---\ntags: [note]\n---\n\nПросто заметка без рисунка.\n",
	} {
		if _, err := ParseDocument(raw); err == nil {
			t.Errorf("чужой файл разобрался как доска: %q", raw[:20])
		}
	}
}

// TestUnknownFieldsSurviveRoundTrip — главный инвариант импорта: то, чего мы
// не знаем, обязано вернуться в файл нетронутым. Иначе элемент, добавленный
// в ваулте версией плагина новее нашей, молча исчезал бы при первой же
// перезаписи доски за столом.
func TestUnknownFieldsSurviveRoundTrip(t *testing.T) {
	src := `{"type":"excalidraw","version":2,"elements":[
		{"id":"e1","type":"rectangle","x":0,"y":0,"width":10,"height":10,
		 "totallyNewField":{"a":[1,2,3]},"anotherOne":"да"}
	],"appState":{"gridSize":20},"files":{}}`

	doc, err := ParseDocument(src)
	if err != nil {
		t.Fatal(err)
	}
	if len(doc.Scene.Elements[0].Extra) != 2 {
		t.Fatalf("неизвестные поля не сохранились: %+v", doc.Scene.Elements[0].Extra)
	}

	md, err := doc.Markdown("name: Тест")
	if err != nil {
		t.Fatal(err)
	}
	again, err := ParseDocument(md)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	raw, _ := json.Marshal(again.Scene.Elements[0])
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got["anotherOne"] != "да" {
		t.Errorf("поле anotherOne потерялось: %v", got["anotherOne"])
	}
	if _, ok := got["totallyNewField"]; !ok {
		t.Error("поле totallyNewField потерялось")
	}
	// appState тоже не наш — и тоже обязан доехать.
	if !strings.Contains(string(again.Scene.AppState), "gridSize") {
		t.Errorf("appState потерялся: %s", again.Scene.AppState)
	}
}

func TestMarkdownWritesTextElementsForSearch(t *testing.T) {
	src := `{"type":"excalidraw","version":2,"elements":[
		{"id":"t1","type":"text","x":0,"y":0,"width":10,"height":10,
		 "text":"Здесь\nловушка","rawText":"Здесь ловушка","originalText":"Здесь ловушка"}
	],"files":{}}`
	doc, err := ParseDocument(src)
	if err != nil {
		t.Fatal(err)
	}
	md, err := doc.Markdown("tags: [excalidraw]")
	if err != nil {
		t.Fatal(err)
	}
	// Раздел нужен, чтобы Obsidian индексировал текст доски — без него
	// доска перестаёт находиться поиском по ваулту.
	if !strings.Contains(md, "## Text Elements") {
		t.Error("раздел Text Elements не записан")
	}
	if !strings.Contains(md, "Здесь ловушка ^t1") {
		t.Errorf("подпись не выложена в markdown:\n%s", md)
	}
	if !strings.Contains(md, "```json") {
		t.Error("рисунок записан не обычным json-блоком")
	}
}

// rawText возвращается только у подписей, которых не касались.
func TestCarryOverPluginFields(t *testing.T) {
	old := &Scene{Elements: []*Element{
		{ID: "a", Type: TypeText, OriginalText: "Холод", RawText: "[[Холод, что пришёл с юга]]"},
		{ID: "b", Type: TypeText, OriginalText: "Азорн", RawText: "[[Азорн]]"},
		{ID: "c", Type: TypeRectangle},
	}}
	next := &Scene{Elements: []*Element{
		// не менялась
		{ID: "a", Type: TypeText, OriginalText: "Холод"},
		// переписали
		{ID: "b", Type: TypeText, OriginalText: "Кто-то другой"},
		{ID: "c", Type: TypeRectangle},
		// новая
		{ID: "d", Type: TypeText, OriginalText: "Свежая подпись"},
	}}
	CarryOverPluginFields(old, next)

	if got := next.Elements[0].RawText; got != "[[Холод, что пришёл с юга]]" {
		t.Errorf("rawText неизменённой подписи не вернулся: %q", got)
	}
	if got := next.Elements[1].RawText; got != "" {
		t.Errorf("rawText переписанной подписи подставился: %q", got)
	}
	if got := next.Elements[3].RawText; got != "" {
		t.Errorf("у новой подписи взялся чужой rawText: %q", got)
	}
	// Пустые сцены.
	CarryOverPluginFields(nil, next)
	CarryOverPluginFields(old, nil)
}

// Адрес картинки доски содержит имя файла как есть — с пробелами и
// кириллицей. Строка раздела обязана пережить и запись, и чтение: иначе
// картинка молча пропадает с доски, а файл при этом на месте.
func TestEmbeddedFileLinkWithSpaces(t *testing.T) {
	doc := NewDocument()
	doc.EmbeddedFiles = []EmbeddedFile{
		{FileID: "sha1aaa", Link: "/uploads/companies/w1/boards/1788-Тронный зал.png"},
		{FileID: "sha1bbb", Link: "[[Схема боя.png]]"},
	}
	md, err := doc.Markdown("name: Доска\n")
	if err != nil {
		t.Fatal(err)
	}
	back, err := ParseDocument(md)
	if err != nil {
		t.Fatal(err)
	}
	if len(back.EmbeddedFiles) != 2 {
		t.Fatalf("строк раздела осталось %d, ожидалось 2: %+v", len(back.EmbeddedFiles), back.EmbeddedFiles)
	}
	links := map[string]string{}
	for _, f := range back.EmbeddedFiles {
		links[f.FileID] = f.Link
	}
	if links["sha1aaa"] != "/uploads/companies/w1/boards/1788-Тронный зал.png" {
		t.Errorf("адрес с пробелом прочитан как %q", links["sha1aaa"])
	}
	if links["sha1bbb"] != "[[Схема боя.png]]" {
		t.Errorf("ссылка ваулта с пробелом прочитана как %q", links["sha1bbb"])
	}
}
