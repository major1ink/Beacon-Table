package foundry

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/syndtr/goleveldb/leveldb"

	"beacon-table/internal/domain"
)

func TestSplitPackKey(t *testing.T) {
	cases := []struct {
		key   string
		colls []string
		ids   []string
		ok    bool
	}{
		{"!items!abc", []string{"items"}, []string{"abc"}, true},
		{"!actors.items!act1.itm1", []string{"actors", "items"}, []string{"act1", "itm1"}, true},
		{"!actors.items.effects!act1.itm1.eff1", []string{"actors", "items", "effects"}, []string{"act1", "itm1", "eff1"}, true},
		{"!folders!f1", []string{"folders"}, []string{"f1"}, true},
		// Пути коллекций и идентификаторов разной длины — служебная запись.
		{"!actors.items!act1", nil, nil, false},
		{"items!abc", nil, nil, false},
		{"!items!", nil, nil, false},
	}
	for _, c := range cases {
		colls, ids, ok := splitPackKey(c.key)
		if ok != c.ok {
			t.Fatalf("%s: ok=%v, ожидали %v", c.key, ok, c.ok)
		}
		if !ok {
			continue
		}
		if strings.Join(colls, ".") != strings.Join(c.colls, ".") || strings.Join(ids, ".") != strings.Join(c.ids, ".") {
			t.Fatalf("%s: разобрали %v/%v, ожидали %v/%v", c.key, colls, ids, c.colls, c.ids)
		}
	}
}

// TestAttachEmbedded — вложенные документы LevelDB-пака (предметы актёра,
// эффекты предмета) должны собраться обратно в родителя: клиентские мапперы
// читают именно вложенные массивы (см. monster-import.js: raw.items).
func TestAttachEmbedded(t *testing.T) {
	actor := Doc{"_id": "act1", "name": "Гоблин"}
	// Пути — те же, что дал бы splitPackKey для ключей
	// "!actors.items!act1.itm1" и "!actors.items.effects!act1.itm1.eff1",
	// без первого сегмента (он адресует самого актёра).
	attachEmbedded(actor, embeddedPath([]string{"items"}, []string{"itm1"}), Doc{"_id": "itm1", "name": "Ятаган"})
	attachEmbedded(actor, embeddedPath([]string{"items", "effects"}, []string{"itm1", "eff1"}), Doc{"_id": "eff1", "name": "Яд"})

	items := asSlice(actor["items"])
	if len(items) != 1 {
		t.Fatalf("предметов у актёра %d, ожидали 1", len(items))
	}
	item := asMap(items[0])
	if asString(item["name"]) != "Ятаган" {
		t.Fatalf("не тот предмет: %v", item["name"])
	}
	effects := asSlice(item["effects"])
	if len(effects) != 1 || asString(asMap(effects[0])["name"]) != "Яд" {
		t.Fatalf("эффект предмета не приехал: %v", item["effects"])
	}
}

func TestReadNeDB(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "spells.db")
	lines := strings.Join([]string{
		`{"_id":"a","name":"Огненный шар","type":"spell"}`,
		`{"_id":"b","name":"Свет","type":"spell"}`,
		`{"_id":"b","name":"Свет (правка)","type":"spell"}`,
		`{"_id":"a","$$deleted":true}`,
		``,
	}, "\n")
	if err := os.WriteFile(path, []byte(lines), 0o600); err != nil {
		t.Fatal(err)
	}

	docs, err := readNeDB(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(docs) != 1 {
		t.Fatalf("документов %d, ожидали 1 (удалённый + дубль схлопнуты): %v", len(docs), docs)
	}
	if asString(docs[0]["name"]) != "Свет (правка)" {
		t.Fatalf("победила не последняя версия документа: %v", docs[0]["name"])
	}
}

// TestReadLevelDB — формат паков Foundry v11+. Пак для теста пишем сами
// (в CI негде взять чужой модуль), но ключи — ровно те, что кладёт Foundry:
// "!actors!ID" у документа и "!actors.items!ACTORID.ITEMID" у вложенного.
func TestReadLevelDB(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "actors")
	db, err := leveldb.OpenFile(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	put := func(key, value string) {
		if err := db.Put([]byte(key), []byte(value), nil); err != nil {
			t.Fatal(err)
		}
	}
	put("!actors!a1", `{"_id":"a1","name":"Гоблин","type":"npc"}`)
	// Сцена в v11+ разложена по коллекциям так же, как актёр: стены и свет
	// лежат отдельными записями и без сборки до MapScene не доедут.
	put("!scenes!sc1", `{"_id":"sc1","name":"Таверна","width":1000,"height":800,"padding":0,"grid":{"type":1,"size":100}}`)
	put("!scenes.walls!sc1.w1", `{"_id":"w1","c":[0,0,100,0]}`)
	put("!scenes.lights!sc1.l1", `{"_id":"l1","x":50,"y":50,"config":{"bright":10,"dim":20}}`)
	put("!actors.items!a1.i1", `{"_id":"i1","name":"Ятаган","type":"weapon"}`)
	put("!actors!a2", `{"_id":"a2","name":"Орк","type":"npc"}`)
	put("!folders!f1", `{"_id":"f1","name":"Папка","type":"Actor","sorting":"a"}`)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	raw, err := readLevelDB(dir)
	if err != nil {
		t.Fatal(err)
	}
	// Папка приезжает из пака обычной записью и отделяется от содержимого по
	// служебному ключу "!folders!…" (см. splitFolders).
	docs, folders := splitFolders(raw)
	if len(docs) != 3 {
		t.Fatalf("документов %d, ожидали 3 (папка — не документ): %v", len(docs), docs)
	}
	if got := folders.Path("f1"); got != "Папка" {
		t.Fatalf("папка пака не прочиталась: %q", got)
	}
	byName := map[string]Doc{}
	for _, d := range docs {
		byName[asString(d["name"])] = d
	}
	goblin, ok := byName["Гоблин"]
	if !ok {
		t.Fatalf("гоблин не прочитался: %v", docs)
	}
	items := asSlice(goblin["items"])
	if len(items) != 1 || asString(asMap(items[0])["name"]) != "Ятаган" {
		t.Fatalf("вложенный предмет не собрался в актёра: %v", goblin["items"])
	}

	// Собранная из россыпи сцена должна доехать до domain.SceneState целиком.
	scene, ok := byName["Таверна"]
	if !ok {
		t.Fatalf("сцена не прочиталась: %v", docs)
	}
	_, assets := testModule(t)
	mapped := MapScene(context.Background(), scene, assets, nil)
	if len(mapped.Walls) != 1 {
		t.Fatalf("стена не собралась в сцену: %+v", mapped.Walls)
	}
	if len(mapped.Tokens) != 1 {
		t.Fatalf("источник света не собрался в сцену: %+v", mapped.Tokens)
	}
}

func TestReadJSONDirAndFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "one.json"), []byte(`{"name":"Один","type":"weapon"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "many.json"), []byte(`[{"name":"Два"},{"name":"Три"}]`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "readme.txt"), []byte("не документ"), 0o600); err != nil {
		t.Fatal(err)
	}

	docs, err := readJSONDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(docs) != 3 {
		t.Fatalf("документов %d, ожидали 3: %v", len(docs), docs)
	}
}

func TestClassify(t *testing.T) {
	cases := []struct {
		name     string
		doc      Doc
		packType string
		want     string
	}{
		{"заклинание из пака предметов", Doc{"type": "spell"}, "Item", TargetSpells},
		{"меч", Doc{"type": "weapon"}, "Item", TargetItems},
		{"класс", Doc{"type": "class"}, "Item", TargetReferences},
		{"помещение бастиона", Doc{"type": "facility"}, "Item", TargetReferences},
		{"предыстория", Doc{"type": "background"}, "Item", TargetReferences},
		{"NPC", Doc{"type": "npc"}, "Actor", TargetMonsters},
		{"транспорт едет в бестиарий как статблок", Doc{"type": "vehicle"}, "Actor", TargetMonsters},
		{"готовый персонаж приключения — в пул, не в бестиарий", Doc{"type": "character"}, "Actor", TargetPregens},
		{"группа актёров не статблок", Doc{"type": "group"}, "Actor", TargetSkipped},
		{"журнал", Doc{"pages": []any{map[string]any{}}}, "JournalEntry", TargetNotes},
		{"таблица", Doc{"results": []any{}}, "RollTable", TargetSkipped},
		{"эффект", Doc{"changes": []any{}, "duration": map[string]any{}}, "", TargetConditions},
		{"сцена по форме документа", Doc{"walls": []any{}, "width": 100}, "", TargetScenes},
	}
	for _, c := range cases {
		if got := Classify(c.doc, c.packType); got != c.want {
			t.Errorf("%s: получили %q, ожидали %q", c.name, got, c.want)
		}
	}
}

// TestExpandAdventure — пак Adventure это коробка с готовым приключением:
// разворачиваем её в документы по разделам, а не тащим как одну запись.
func TestExpandAdventure(t *testing.T) {
	adventure := Doc{
		"name": "Шахта",
		"actors": []any{
			map[string]any{"type": "npc", "name": "Гоблин"},
			map[string]any{"type": "character", "name": "Шила"},
		},
		"items":  []any{map[string]any{"type": "spell", "name": "Свет"}},
		"scenes": []any{map[string]any{"name": "Вход", "walls": []any{}}},
	}
	entries := Expand([]Doc{adventure}, "Adventure")
	got := map[string]int{}
	for _, e := range entries {
		got[e.Target]++
	}
	if got[TargetMonsters] != 1 || got[TargetSpells] != 1 || got[TargetScenes] != 1 || got[TargetPregens] != 1 {
		t.Fatalf("приключение развернулось не туда: %v", got)
	}
}

func TestSafeJoin(t *testing.T) {
	dir := filepath.Join("a", "b")
	if _, ok := safeJoin(dir, "../../etc/passwd"); ok {
		t.Fatal("выход за пределы каталога должен отклоняться")
	}
	if _, ok := safeJoin(dir, "packs/../../../x"); ok {
		t.Fatal("выход через середину пути должен отклоняться")
	}
	got, ok := safeJoin(dir, "packs/items.db")
	if !ok || got != filepath.Join(dir, "packs", "items.db") {
		t.Fatalf("нормальный путь не собрался: %q ok=%v", got, ok)
	}
}

// memStore — AssetStore для тестов: ничего не пишет, просто помнит, что у
// него просили сохранить.
type memStore struct {
	saved []string
}

func (m *memStore) Save(_ context.Context, kind, folder, filename string, r io.Reader) (string, error) {
	if _, err := io.Copy(io.Discard, r); err != nil {
		return "", err
	}
	m.saved = append(m.saved, kind+"/"+filename)
	return "/uploads/" + kind + "/" + folder + "/" + filename, nil
}

// testModule — распакованный "модуль" на диске с одним файлом-картинкой.
func testModule(t *testing.T) (*memStore, *Assets) {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "icons"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "icons", "goblin.webp"), []byte("png"), 0o600); err != nil {
		t.Fatal(err)
	}
	mod := &Module{Manifest: &Manifest{ID: "my-module"}, Dir: dir, Root: dir}
	store := &memStore{}
	return store, NewAssets(mod, store, "foundry/my-module")
}

func TestAssetsURL(t *testing.T) {
	store, assets := testModule(t)
	ctx := context.Background()

	// Путь от корня данных Foundry — файл лежит внутри модуля.
	url := assets.URL(ctx, domain.AssetKindTokens, "modules/my-module/icons/goblin.webp")
	if !strings.HasPrefix(url, "/uploads/tokens/") {
		t.Fatalf("картинка не перенеслась: %q", url)
	}
	// Второй раз тот же файл — из кэша, без повторного сохранения.
	if again := assets.URL(ctx, domain.AssetKindTokens, "modules/my-module/icons/goblin.webp"); again != url {
		t.Fatalf("кэш ссылок не сработал: %q != %q", again, url)
	}
	if len(store.saved) != 1 {
		t.Fatalf("файл сохранён %d раз(а), ожидали 1", len(store.saved))
	}
	// Иконки самого Foundry в архиве модуля не лежат — ссылки на них
	// просто пропадают, это норма (см. Assets.Missing).
	if got := assets.URL(ctx, domain.AssetKindTokens, "icons/svg/mystery-man.svg"); got != "" {
		t.Fatalf("несуществующий файл дал ссылку %q", got)
	}
	if assets.Missing != 1 {
		t.Fatalf("не посчитали потерянную ссылку: %d", assets.Missing)
	}
	// Внешние ссылки не трогаем.
	if got := assets.URL(ctx, domain.AssetKindTokens, "https://example.com/x.png"); got != "https://example.com/x.png" {
		t.Fatalf("внешняя ссылка изменилась: %q", got)
	}
}

func TestRewriteDoc(t *testing.T) {
	_, assets := testModule(t)
	doc := Doc{
		"name": "Гоблин",
		"img":  "modules/my-module/icons/goblin.webp",
		"prototypeToken": map[string]any{
			"texture": map[string]any{"src": "modules/my-module/icons/goblin.webp"},
		},
	}
	assets.RewriteDoc(context.Background(), doc)
	if !strings.HasPrefix(asString(doc["img"]), "/uploads/tokens/") {
		t.Fatalf("img не переписан: %v", doc["img"])
	}
	if !strings.HasPrefix(digString(doc, "prototypeToken", "texture", "src"), "/uploads/tokens/") {
		t.Fatalf("арт токена не переписан: %v", doc["prototypeToken"])
	}
}

// TestMapScene — главное в переносе сцены: геометрия. Координаты Foundry
// отсчитываются от края ПОЛЕЙ холста (padding), у нас полей нет.
func TestMapScene(t *testing.T) {
	_, assets := testModule(t)
	doc := Doc{
		"name":    "Таверна",
		"width":   1000,
		"height":  800,
		"padding": 0.25,
		"grid":    map[string]any{"type": 1, "size": 100, "distance": 5, "units": "фт", "color": "#111111", "alpha": 0.3},
		"walls": []any{
			map[string]any{"c": []any{300, 200, 400, 200}},
			map[string]any{"c": []any{500, 200, 500, 300}, "door": 1, "ds": 1},
			map[string]any{"c": []any{600, 200, 700, 200}, "door": 2},
			map[string]any{"c": []any{800, 200, 900, 200}, "sight": 0, "light": 20},
			map[string]any{"c": []any{800, 400, 900, 400}, "sight": 10, "light": 10},
		},
		"lights": []any{
			map[string]any{"x": 400, "y": 400, "config": map[string]any{"bright": 10, "dim": 20}},
		},
		"tokens": []any{
			map[string]any{"x": 300, "y": 300, "width": 1, "height": 1, "name": "Бармен", "hidden": true, "actorId": "actor-barman"},
		},
	}

	s := MapScene(context.Background(), doc, assets, nil)
	// offset = ceil(0.25*1000/100)*100 = 300 по X, ceil(0.25*800/100)*100 = 200 по Y.
	if s.Width != 1000 || s.Height != 800 {
		t.Fatalf("размер холста %vx%v", s.Width, s.Height)
	}
	if s.Grid.Size != 100 || s.Grid.UnitsPerCell != 5 || s.Grid.Unit != "фт" {
		t.Fatalf("сетка перенеслась неверно: %+v", s.Grid)
	}
	if len(s.Walls) != 5 {
		t.Fatalf("стен %d, ожидали 5", len(s.Walls))
	}
	var plain, door, secret, window, terrain *domain.Wall
	for _, w := range s.Walls {
		switch {
		case w.Door == "door":
			door = w
		case w.Door == "secret":
			secret = w
		case w.Window && w.LightThrough:
			terrain = w
		case w.Window:
			window = w
		default:
			plain = w
		}
	}
	if plain == nil || plain.X1 != 0 || plain.Y1 != 0 || plain.X2 != 100 {
		t.Fatalf("глухая стена не сдвинулась на padding: %+v", plain)
	}
	if plain.Window || plain.LightThrough {
		t.Fatalf("стена без sight/light должна остаться глухой: %+v", plain)
	}
	if door == nil || door.DoorState != "open" {
		t.Fatalf("дверь перенеслась неверно: %+v", door)
	}
	if secret == nil || secret.DoorState != "closed" {
		t.Fatalf("секретная дверь перенеслась неверно: %+v", secret)
	}
	// Окно (Sight: None при Light: Normal) — видно сквозь, но свет держит.
	if window == nil || window.Door != "" || window.LightThrough {
		t.Fatalf("окно перенеслось неверно: %+v", window)
	}
	// «Местность» (Sight/Light: Limited) — не глухая стена: раньше оба поля
	// проваливались мимо разбора и сегмент вставал сплошной тенью.
	if terrain == nil || terrain.Door != "" {
		t.Fatalf("Sight/Light: Limited перенеслось неверно: %+v", terrain)
	}

	var light, token *domain.Token
	for _, tk := range s.Tokens {
		if tk.LightOnly {
			light = tk
		} else {
			token = tk
		}
	}
	if light == nil || light.Light == nil || light.Light.Bright != 10 || light.Light.Dim != 20 {
		t.Fatalf("источник света не стал токеном света: %+v", light)
	}
	if light.X != 100 || light.Y != 200 {
		t.Fatalf("свет встал не туда: %v,%v", light.X, light.Y)
	}
	// Токен: x=300-300+50 = 50, y=300-200+50 = 150 (у Foundry координата —
	// левый верхний угол, у нас центр).
	if token == nil || token.X != 50 || token.Y != 150 || !token.Hidden || token.Label != "Бармен" {
		t.Fatalf("токен перенёсся неверно: %+v", token)
	}
	// Якорь для отложенного связывания со статблоком (см.
	// domain.Token.FoundryActorID): сам MonsterID тут ещё пуст — актёры
	// приезжают отдельным паком, и связывает их уже
	// service.FoundryService.LinkSceneTokens.
	if token.FoundryActorID != "actor-barman" {
		t.Fatalf("id актёра не сохранился: %q", token.FoundryActorID)
	}
	if token.MonsterID != "" {
		t.Fatalf("статблок не может быть известен на этапе разбора сцены: %q", token.MonsterID)
	}
}

// TestMapSceneNoteMarkers — значки Foundry на карте (notes[]) переносятся в
// domain.NoteMarker, если индекс модуля знает запись, на которую они ведут;
// настоящий id заметки на этом этапе неизвестен (её заводит клиент), поэтому
// кладём «якорь» — имя записи, папку и раздел.
func TestMapSceneNoteMarkers(t *testing.T) {
	_, assets := testModule(t)
	ix := &LinkIndex{targets: map[string]LinkTarget{
		"entry1": {Kind: "note", Name: "Приключение", Folder: "Модуль/Приключение"},
		"page1":  {Kind: "note", Name: "Приключение", Folder: "Модуль/Приключение", Section: "Мёртвые пауки"},
	}}
	doc := Doc{
		"name": "Пещера", "width": 1000, "height": 800,
		"notes": []any{
			// ведёт на конкретную страницу — открываем заметку на её разделе
			map[string]any{"entryId": "entry1", "pageId": "page1", "x": 400, "y": 300},
			// ведёт на запись целиком (страницы нет)
			map[string]any{"entryId": "entry1", "x": 100, "y": 100, "text": "Своя подпись"},
			// ведёт в никуда (документ мира/другого модуля) — пропускаем
			map[string]any{"entryId": "zzz", "x": 0, "y": 0},
		},
	}
	s := MapScene(context.Background(), doc, assets, ix)
	if len(s.NoteMarkers) != 2 {
		t.Fatalf("значков %d, ожидали 2", len(s.NoteMarkers))
	}
	var page, entry *domain.NoteMarker
	for _, nm := range s.NoteMarkers {
		if nm.Section != "" {
			page = nm
		} else {
			entry = nm
		}
	}
	if page == nil || page.Label != "Мёртвые пауки" || page.Section != "Мёртвые пауки" ||
		page.FoundryEntry != "Приключение" || page.FoundryFolder != "Модуль/Приключение" ||
		page.X != 400 || page.Y != 300 || page.NoteID != "" {
		t.Fatalf("значок на страницу перенёсся неверно: %+v", page)
	}
	if entry == nil || entry.Label != "Своя подпись" || entry.Section != "" || entry.FoundryEntry != "Приключение" {
		t.Fatalf("значок на запись перенёсся неверно: %+v", entry)
	}
}

// TestMapSceneNoteMarkersNoIndex — без индекса значки просто не переносятся
// (nil ix — легальный вызов для не-adventure сцен).
func TestMapSceneNoteMarkersNoIndex(t *testing.T) {
	_, assets := testModule(t)
	doc := Doc{"name": "Пещера", "width": 100, "height": 100, "notes": []any{map[string]any{"entryId": "e", "x": 1, "y": 1}}}
	if s := MapScene(context.Background(), doc, assets, nil); len(s.NoteMarkers) != 0 {
		t.Fatalf("без индекса значков быть не должно: %d", len(s.NoteMarkers))
	}
}

func TestMapJournal(t *testing.T) {
	_, assets := testModule(t)
	doc := Doc{
		"name": "Легенды",
		"pages": []any{
			map[string]any{"name": "Пролог", "type": "text", "text": map[string]any{"content": "<p>Давным-давно</p>"}},
			map[string]any{"name": "Карта", "type": "image", "src": "modules/my-module/icons/goblin.webp"},
		},
	}
	journal := MapJournal(context.Background(), doc, "Мой модуль/Лор", assets)
	if journal.Title != "Легенды" || journal.Folder != "Мой модуль/Лор" {
		t.Fatalf("заголовок/папка заметки не те: %+v", journal)
	}
	content := journal.Content
	if !strings.HasPrefix(content, "# Легенды\n") {
		t.Fatalf("заголовок заметки не первой строкой: %q", content)
	}
	if !strings.Contains(content, "## Пролог") || !strings.Contains(content, "<p>Давным-давно</p>") {
		t.Fatalf("текст страницы потерялся: %q", content)
	}
	if !strings.Contains(content, "](/uploads/notes/") {
		t.Fatalf("картинка страницы не перенеслась: %q", content)
	}
}

// TestMapJournalCallouts — заметные врезки модуля/системы dnd5e («читать
// вслух», советы Мастеру) получают наши классы, которые стилизует
// .note-render (фон + полоса слева); чужой CSS системы у нас не грузится.
func TestMapJournalCallouts(t *testing.T) {
	_, assets := testModule(t)
	doc := Doc{
		"name":  "Сцена 1",
		"pages": []any{map[string]any{"name": "Вход", "type": "text", "text": map[string]any{"content": `<section class="fvtt narrative"><p>Зачитайте это игрокам.</p></section><section class="fvtt advice ag-advice"><article><p>А это совет Мастеру.</p></article></section><aside class="notable"><p>Сбоку.</p></aside>`}}},
	}
	content := MapJournal(context.Background(), doc, "", assets).Content
	if !strings.Contains(content, `<section class="beacon-readaloud"><p>Зачитайте это игрокам.</p>`) {
		t.Fatalf("врезка «читать вслух» не переведена: %q", content)
	}
	if strings.Contains(content, "fvtt narrative") || strings.Contains(content, "fvtt advice") || strings.Contains(content, `"notable"`) {
		t.Fatalf("классы системы остались в тексте: %q", content)
	}
	if !strings.Contains(content, `<section class="beacon-dm-note"><article>`) || !strings.Contains(content, `<aside class="beacon-dm-note"><p>Сбоку.`) {
		t.Fatalf("врезки-советы не переведены: %q", content)
	}
}

// TestMapJournalMissingImage — страница-иллюстрация, файла которой в архиве
// нет (модуль ссылается на арт, которого не распространяет). Пустой раздел с
// одним заголовком выглядел бы как поломка импорта — в тексте должно быть
// видно, чего не хватает.
func TestMapJournalMissingImage(t *testing.T) {
	_, assets := testModule(t)
	doc := Doc{
		"name":  "Иллюстрации",
		"pages": []any{map[string]any{"name": "Обложка", "type": "image", "src": "modules/other/art/cover.webp"}},
	}
	content := MapJournal(context.Background(), doc, "", assets).Content
	if !strings.Contains(content, "## Обложка") {
		t.Fatalf("заголовок раздела потерялся: %q", content)
	}
	if !strings.Contains(content, "иллюстрация не перенесена") || !strings.Contains(content, "art/cover.webp") {
		t.Fatalf("нет следа от ненайденного файла: %q", content)
	}
}

// TestMapJournalVideoPDF — страницы видео/PDF проигрываются прямо в
// заметке (<video>/<iframe> на перенесённый файл), а не оседают голой
// ссылкой на скачивание.
func TestMapJournalVideoPDF(t *testing.T) {
	_, assets := testModule(t)
	doc := Doc{
		"name": "Приложения",
		"pages": []any{
			map[string]any{"name": "Ролик", "type": "video", "src": "modules/my-module/icons/goblin.webp"},
			map[string]any{"name": "Раздатка", "type": "pdf", "src": "modules/my-module/icons/goblin.webp"},
		},
	}
	content := MapJournal(context.Background(), doc, "", assets).Content
	if !strings.Contains(content, "<video") || !strings.Contains(content, "<source src=\"/uploads/notes/") {
		t.Fatalf("видео не проигрывается инлайн: %q", content)
	}
	if !strings.Contains(content, "<iframe src=\"/uploads/notes/") {
		t.Fatalf("PDF не встроен инлайн: %q", content)
	}
	if !strings.Contains(content, "[Открыть PDF в отдельной вкладке](/uploads/notes/") {
		t.Fatalf("нет запасной ссылки на PDF: %q", content)
	}
}

// TestMapJournalMissingVideo — тот же случай, что MissingImage, но для
// видео: файла в архиве нет, заметка должна сказать об этом текстом, а не
// оставить битый <video> без src.
func TestMapJournalMissingVideo(t *testing.T) {
	_, assets := testModule(t)
	doc := Doc{
		"name":  "Приложения",
		"pages": []any{map[string]any{"name": "Ролик", "type": "video", "src": "modules/other/cutscene.mp4"}},
	}
	content := MapJournal(context.Background(), doc, "", assets).Content
	if strings.Contains(content, "<video") {
		t.Fatalf("тег видео вставился без файла: %q", content)
	}
	if !strings.Contains(content, "видео не перенесено") || !strings.Contains(content, "cutscene.mp4") {
		t.Fatalf("нет следа от ненайденного видео: %q", content)
	}
}

// TestAssetsLocateFallback — путь в документе не всегда совпадает с тем, что
// в архиве: другой регистр или файл переехал в другую подпапку при сборке.
// Ищем по индексу архива, иначе картинки теряются на ровном месте.
func TestAssetsLocateFallback(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "assets", "art"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "assets", "art", "Обложка.webp"), []byte("webp"), 0o600); err != nil {
		t.Fatal(err)
	}
	mod := &Module{Manifest: &Manifest{ID: "m"}, Dir: dir, Root: dir}
	assets := NewAssets(mod, &memStore{}, "foundry/m")
	ctx := context.Background()

	// Другой регистр в пути.
	if got := assets.URL(ctx, domain.AssetKindNotes, "modules/m/Assets/Art/Обложка.webp"); got == "" {
		t.Fatal("файл с другим регистром пути не нашёлся")
	}
	// Файл лежит не там, где написано, но имя в архиве единственное.
	if got := assets.URL(ctx, domain.AssetKindNotes, "modules/m/images/Обложка.webp"); got == "" {
		t.Fatal("файл не нашёлся по имени")
	}
	// Чего в архиве нет — того нет, чужую картинку подставлять нельзя.
	if got := assets.URL(ctx, domain.AssetKindNotes, "modules/m/art/Карта.webp"); got != "" {
		t.Fatalf("подставился посторонний файл: %q", got)
	}
}

// TestPackFolders — папки компендиума (документы "!folders!…") не должны
// попадать в содержимое пака, а должны собираться в дерево путей: журнал из
// вложенной папки ложится в такую же папку библиотеки заметок.
func TestPackFolders(t *testing.T) {
	docs := []Doc{
		{"_key": "!folders!f1", "_id": "f1", "name": "Глава 1", "type": "JournalEntry", "sorting": "a"},
		{"_key": "!folders!f2", "_id": "f2", "name": "NPC", "type": "JournalEntry", "sorting": "a", "folder": "f1"},
		{"_key": "!journal!j1", "_id": "j1", "name": "Трактирщик", "folder": "f2", "pages": []any{}},
	}
	content, folders := splitFolders(docs)
	if len(content) != 1 || asString(content[0]["name"]) != "Трактирщик" {
		t.Fatalf("папки не отделились от содержимого: %v", content)
	}
	if got := folders.Path("f2"); got != "Глава 1/NPC" {
		t.Fatalf("путь вложенной папки: %q", got)
	}
	if got := folders.Path(DocFolderID(content[0])); got != "Глава 1/NPC" {
		t.Fatalf("папка документа: %q", got)
	}
	if got := NoteFolder("Мой модуль", "Лор", "Глава 1/NPC"); got != "Мой модуль/Лор/Глава 1/NPC" {
		t.Fatalf("папка библиотеки заметок: %q", got)
	}
	// Слэш в имени папки модуля не должен превращаться во вложенность.
	if got := NoteFolder("Мод/уль", "Лор", ""); got != "Мод-уль/Лор" {
		t.Fatalf("слэш в имени не обезврежен: %q", got)
	}
}

// TestNoteFolderDepthClamp — дерево глубже предела библиотеки заметок не
// теряется, а схлопывается в последнюю папку.
func TestNoteFolderDepthClamp(t *testing.T) {
	got := NoteFolder("Модуль", "Пак", "a/b/c/d/e/f/g/h")
	parts := strings.Split(got, "/")
	if len(parts) != maxFolderDepth {
		t.Fatalf("уровней %d, ожидали %d: %q", len(parts), maxFolderDepth, got)
	}
	if !strings.Contains(parts[len(parts)-1], "f — g — h") {
		t.Fatalf("хвост пути потерялся: %q", got)
	}
}

// TestLinkIndexRewrite — перекрёстные ссылки модуля: @UUID/@Embed внутри
// текстов должны становиться ссылками Beacon Table на те же документы, а не
// оставаться макросами Foundry в абзаце.
func TestLinkIndexRewrite(t *testing.T) {
	ix := &LinkIndex{targets: map[string]LinkTarget{
		"jrnA":  {Kind: "note", Name: "Приложение D: правила", Folder: "Модуль/Правила/Приложения"},
		"pageB": {Kind: "note", Name: "Приложение D: правила", Folder: "Модуль/Правила/Приложения", Section: "Перемещение через существ"},
		"spl1":  {Kind: "spell", Name: "Огненный шар"},
		"itm1":  {Kind: "item", Name: `Меч "Клык"`},
		"scn1":  {Kind: "scene", Name: "Пещера"},
		"pl1":   {Kind: "playlist", Name: "Бой с гоблинами"},
		"tbl1":  {Name: "Таблица случайностей"}, // переносить некуда — останется текст
	}}

	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			"ссылка на журнал со своей подписью",
			`см. @UUID[Compendium.mod.phb.JournalEntry.jrnA]{правила боя}`,
			`см. <a class="catalog-ref" data-kind="note" data-name="Приложение D: правила" data-folder="Модуль/Правила/Приложения">правила боя</a>`,
		},
		{
			"вставка страницы без подписи берёт имя раздела",
			`@Embed[Compendium.mod.phb.JournalEntry.jrnA.JournalEntryPage.pageB inline]`,
			`<a class="catalog-ref" data-kind="note" data-name="Приложение D: правила" data-folder="Модуль/Правила/Приложения" data-section="Перемещение через существ">Перемещение через существ</a>`,
		},
		{
			"старый формат ссылки на компендиум",
			`@Compendium[mod.spells.spl1]{Огненный шар}`,
			`<a class="catalog-ref" data-kind="spell" data-name="Огненный шар">Огненный шар</a>`,
		},
		{
			"кавычки в имени экранируются",
			`@UUID[Compendium.mod.items.Item.itm1]`,
			`<a class="catalog-ref" data-kind="item" data-name="Меч &#34;Клык&#34;">Меч &#34;Клык&#34;</a>`,
		},
		{
			"ссылка на сцену — переключатель карты стола (kind=scene)",
			`карта: @UUID[Compendium.mod.scenes.Scene.scn1]`,
			`карта: <a class="catalog-ref" data-kind="scene" data-name="Пещера">Пещера</a>`,
		},
		{
			"ссылка на плейлист (kind=playlist)",
			`включите @UUID[Compendium.mod.music.Playlist.pl1]{плейлистом}`,
			`включите <a class="catalog-ref" data-kind="playlist" data-name="Бой с гоблинами">плейлистом</a>`,
		},
		{
			"отдельный звук плейлиста переносить некуда — остаётся подпись",
			`@UUID[Compendium.mod.music.Playlist.pl1.PlaylistSound.snd9]{звук камней}`,
			`звук камней`,
		},
		{
			"цель есть, но переносить некуда — остаётся подпись",
			`бросьте по @UUID[Compendium.mod.tables.RollTable.tbl1]{таблице}`,
			`бросьте по таблице`,
		},
		{
			"чужой модуль — тоже только подпись, без макроса в тексте",
			`<p>см. @UUID[Compendium.other.pack.JournalEntry.zzz]{другой модуль}</p>`,
			`<p>см. другой модуль</p>`,
		},
		{"текста без макросов не касаемся", `<p>обычный абзац</p>`, `<p>обычный абзац</p>`},
	}
	for _, c := range cases {
		if got := ix.Rewrite(c.in); got != c.want {
			t.Errorf("%s:\n получили %q\n ожидали  %q", c.name, got, c.want)
		}
	}
}

// TestRewriteDocLinks — макросы лежат в разных полях схемы (описание
// предмета, текст эффекта, вложенный предмет актёра), поэтому обход
// документа рекурсивный.
func TestRewriteDocMacros(t *testing.T) {
	ix := &LinkIndex{targets: map[string]LinkTarget{"spl1": {Kind: "spell", Name: "Свет"}}}
	doc := Doc{
		"name":   "Жезл",
		"system": map[string]any{"description": map[string]any{"value": `даёт @UUID[Compendium.mod.spells.Item.spl1]{Свет}`}},
		"items": []any{
			map[string]any{"name": "Заряд", "system": map[string]any{"description": map[string]any{"value": `см. @UUID[Compendium.mod.spells.Item.spl1]`}}},
		},
	}
	RewriteDocMacros(doc, ix)

	if got := digString(doc, "system", "description", "value"); !strings.Contains(got, `data-kind="spell"`) {
		t.Fatalf("описание не переписано: %q", got)
	}
	nested := asMap(asSlice(doc["items"])[0])
	if got := digString(nested, "system", "description", "value"); !strings.Contains(got, `>Свет</a>`) {
		t.Fatalf("вложенный документ не переписан: %q", got)
	}
}

// TestRewriteDocMacrosLookupName — обогатитель [[lookup @name]] в описании
// способности существа подставляется именем самого существа (регрессия:
// карточка «Спрайт», способность «Проворное бегство» приносила в текст
// буквальное «lookup @name совершает действие …»).
func TestRewriteDocMacrosLookupName(t *testing.T) {
	doc := Doc{
		"name": "Спрайт",
		"items": []any{
			map[string]any{"name": "Проворное бегство", "system": map[string]any{"description": map[string]any{
				"value": `<p>[[lookup @name]] совершает действие Отступление или Засада.</p>`,
			}}},
		},
	}
	RewriteDocMacros(doc, &LinkIndex{targets: map[string]LinkTarget{}})

	nested := asMap(asSlice(doc["items"])[0])
	got := digString(nested, "system", "description", "value")
	if want := `<p>Спрайт совершает действие Отступление или Засада.</p>`; got != want {
		t.Fatalf("lookup @name не подставлен:\n получили %q\n ожидали  %q", got, want)
	}
}

// TestRewriteRolls — инлайн-броски Foundry. Формула должна остаться
// формулой (её делает кликабельной клиент, см. web/src/inline-rolls.js), а
// проверки и спасброски — стать человеческой фразой.
func TestRewriteRolls(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"обычный бросок", `нанеси [[/r 2d6 + 3]] урона`, `нанеси 2d6 + 3 урона`},
		{"бросок с подписью", `[[/r 1d8]]{урон молнией}`, `урон молнией (1d8)`},
		{"бросок без команды", `[[2d10]]`, `2d10`},
		{"флейвор после # отбрасывается", `[[/r 1d4 # яд]]`, `1d4`},
		{"скрытый бросок ДМ — та же формула", `[[/gmr 1d100]]`, `1d100`},
		{"спасбросок позиционно", `[[/save dex 15]]`, `спасбросок: Лов (СЛ 15)`},
		{"спасбросок именованными аргументами", `[[/save ability=con dc=13]]`, `спасбросок: Тел (СЛ 13)`},
		{"концентрация", `[[/concentration 10]]`, `спасбросок: концентрация (СЛ 10)`},
		{"проверка навыка", `[[/check skill=ste dc=12]]`, `проверка: Скрытность (СЛ 12)`},
		{"проверка характеристики", `[[/check str 20]]`, `проверка: Сил (СЛ 20)`},
		{"навык отдельной командой", `[[/skill acr]]`, `проверка: Акробатика`},
		{"урон с типом", `[[/damage 2d6 fire]]`, `2d6 (огонь)`},
		{"лечение", `[[/heal 2d4]]`, `2d4`},
		{"своя подпись важнее фразы", `[[/save dex 15]]{СЛ 15 Ловкость}`, `СЛ 15 Ловкость`},
		// Модули часто пишут «на [[/save con 15]] saving throw» — второе
		// «спасбросок» подряд не нужно, слово уже есть в самом тексте.
		{
			"текст сам называет бросок",
			`must succeed on a [[/save con 15]] saving throw or fall`,
			`must succeed on a Тел (СЛ 15) saving throw or fall`,
		},
		{
			"то же для проверки, через тег",
			`make a [[/check ste 12]]<strong> check</strong>`,
			`make a Скрытность (СЛ 12)<strong> check</strong>`,
		},
		{"экранированный амперсанд у &Reference", `состояние &amp;Reference[Prone]`, `состояние Prone`},
		{"незнакомая команда без подписи исчезает", `а[[/item Меч]]б`, `аб`},
		// [[lookup @name]] без данных документа (RewriteRolls вызывают и на
		// тексте журнала — там имени актёра нет): макрос сворачивается в свою
		// подпись, а не утекает словом «lookup» в текст.
		{"lookup без имени и подписи исчезает", `а[[lookup @name]]б`, `аб`},
		{"lookup без имени, но с подписью — остаётся подпись", `[[lookup @name]]{Существо} бежит`, `Существо бежит`},
		// Регрессия на реальных данных (см. data/references — "Покрытое ядом
		// оружие"): цель /item названа "Русское [English]" — из-за одиночной
		// пары [...] внутри макроса он раньше не матчился ВООБЩЕ (жадный
		// [^\]]+ упирался в "]" из "[Cunning Strike]" раньше двух закрывающих
		// "]]") и оставался в тексте нетронутым.
		{
			"вложенные [...] в цели /item (одно название на два языка)",
			`эффект [[/item Хитроумный удар [Cunning Strike] activity="Отравление"]]{Отравление} применён`,
			`эффект Отравление применён`,
		},
		{"ссылка на правило системы", `состояние &Reference[condition=prone]{Ничком}`, `состояние Ничком`},
		{"текст без макросов не трогаем", `просто 2d6 в тексте`, `просто 2d6 в тексте`},
	}
	for _, c := range cases {
		if got := RewriteRolls(c.in); got != c.want {
			t.Errorf("%s:\n получили %q\n ожидали  %q", c.name, got, c.want)
		}
	}
}

// TestBuildLinkIndex — индекс строится по всем пакам модуля: ссылка из
// правил на заклинание из соседнего компендиума должна резолвиться.
func TestBuildLinkIndex(t *testing.T) {
	dir := t.TempDir()
	write := func(rel, content string) {
		t.Helper()
		full := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("packs/_source/spells/light.json", `{"_key":"!items!spl1","_id":"spl1","name":"Свет","type":"spell","system":{}}`)
	write("packs/_source/lore/folder.json", `{"_key":"!folders!f1","_id":"f1","name":"Глава 1","type":"JournalEntry","sorting":"a"}`)
	write("packs/_source/lore/rules.json", `{"_key":"!journal!j1","_id":"j1","name":"Правила","folder":"f1","pages":[{"_id":"p1","name":"Перемещение","type":"text","text":{"content":"текст"}}]}`)

	mod := &Module{
		Dir:  dir,
		Root: dir,
		Manifest: &Manifest{ID: "mod", Title: "Мой модуль", Packs: []Pack{
			{Name: "spells", Label: "Заклинания", Path: "packs/_source/spells", Type: "Item"},
			{Name: "lore", Label: "Лор", Path: "packs/_source/lore", Type: "JournalEntry"},
		}},
	}
	ix := BuildLinkIndex(mod, "Мой модуль")

	got := ix.Rewrite(`@UUID[Compendium.mod.spells.Item.spl1]{свет} и @UUID[Compendium.mod.lore.JournalEntry.j1.JournalEntryPage.p1]`)
	if !strings.Contains(got, `data-kind="spell" data-name="Свет"`) {
		t.Fatalf("ссылка на заклинание из соседнего пака не собралась: %q", got)
	}
	if !strings.Contains(got, `data-folder="Мой модуль/Лор/Глава 1"`) || !strings.Contains(got, `>Перемещение</a>`) {
		t.Fatalf("ссылка на страницу журнала не собралась: %q", got)
	}
}

func TestRewriteHTML(t *testing.T) {
	_, assets := testModule(t)
	html := `<p><img src="modules/my-module/icons/goblin.webp"> и <img src='icons/svg/nope.svg'></p>`
	got := assets.RewriteHTML(context.Background(), domain.AssetKindNotes, html)
	if !strings.Contains(got, `src="/uploads/notes/`) {
		t.Fatalf("картинка в тексте не переписана: %q", got)
	}
	// Картинки, которой нет в архиве (ассет самого Foundry), в тексте
	// оставаться не должно — ни ссылкой, ни битым <img>.
	if strings.Contains(got, "nope.svg") || strings.Contains(got, "<img src='icons") {
		t.Fatalf("битый <img> не выкинут: %q", got)
	}
}

// TestRewriteHTMLDropsBrokenIconWrapper — декоративная иконка advice-блока
// ссылается на ассет самого Foundry ("icons/vtt-512.png"), которого в модуле
// нет: выкидываем и <img>, и опустевшую обёртку <figure>, иначе в тексте
// заметки торчит пустая рамка с крестиком.
func TestRewriteHTMLDropsBrokenIconWrapper(t *testing.T) {
	_, assets := testModule(t)
	html := `<section class="advice"><figure class="icon"><img src="icons/vtt-512.png" /></figure><article><h4>Совет</h4><p>текст</p></article></section>`
	got := assets.RewriteHTML(context.Background(), domain.AssetKindNotes, html)
	if strings.Contains(got, "<img") || strings.Contains(got, "<figure") {
		t.Fatalf("битая иконка и пустая обёртка не убраны: %q", got)
	}
	if !strings.Contains(got, "<h4>Совет</h4>") || !strings.Contains(got, "<p>текст</p>") {
		t.Fatalf("полезное содержимое блока пропало: %q", got)
	}
}

func TestMapPlaylist(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "tavern.ogg"), []byte("ogg"), 0o600); err != nil {
		t.Fatal(err)
	}
	mod := &Module{Manifest: &Manifest{ID: "m"}, Dir: dir, Root: dir}
	assets := NewAssets(mod, &memStore{}, "foundry/m")

	p := MapPlaylist(context.Background(), Doc{
		"name": "Таверна",
		"sounds": []any{
			map[string]any{"name": "Лютня", "path": "tavern.ogg", "volume": 0.4, "repeat": true},
			map[string]any{"name": "Нет файла", "path": "sounds/missing.ogg"},
		},
	}, assets)

	if p.Name != "Таверна" || len(p.Tracks) != 1 {
		t.Fatalf("плейлист собрался неверно: %+v", p)
	}
	if p.Tracks[0].Volume != 0.4 || !p.Tracks[0].Loop {
		t.Fatalf("настройки трека потерялись: %+v", p.Tracks[0])
	}
}
