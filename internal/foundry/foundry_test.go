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
	mapped := MapScene(context.Background(), scene, assets)
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
		{"предыстория", Doc{"type": "background"}, "Item", TargetReferences},
		{"NPC", Doc{"type": "npc"}, "Actor", TargetMonsters},
		{"транспорт не статблок", Doc{"type": "vehicle"}, "Actor", TargetSkipped},
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
		"name":   "Шахта",
		"actors": []any{map[string]any{"type": "npc", "name": "Гоблин"}},
		"items":  []any{map[string]any{"type": "spell", "name": "Свет"}},
		"scenes": []any{map[string]any{"name": "Вход", "walls": []any{}}},
	}
	entries := Expand([]Doc{adventure}, "Adventure")
	got := map[string]int{}
	for _, e := range entries {
		got[e.Target]++
	}
	if got[TargetMonsters] != 1 || got[TargetSpells] != 1 || got[TargetScenes] != 1 {
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
			map[string]any{"c": []any{800, 200, 900, 200}, "sight": 0},
		},
		"lights": []any{
			map[string]any{"x": 400, "y": 400, "config": map[string]any{"bright": 10, "dim": 20}},
		},
		"tokens": []any{
			map[string]any{"x": 300, "y": 300, "width": 1, "height": 1, "name": "Бармен", "hidden": true},
		},
	}

	s := MapScene(context.Background(), doc, assets)
	// offset = ceil(0.25*1000/100)*100 = 300 по X, ceil(0.25*800/100)*100 = 200 по Y.
	if s.Width != 1000 || s.Height != 800 {
		t.Fatalf("размер холста %vx%v", s.Width, s.Height)
	}
	if s.Grid.Size != 100 || s.Grid.UnitsPerCell != 5 || s.Grid.Unit != "фт" {
		t.Fatalf("сетка перенеслась неверно: %+v", s.Grid)
	}
	if len(s.Walls) != 4 {
		t.Fatalf("стен %d, ожидали 4", len(s.Walls))
	}
	var plain, door, secret, window *domain.Wall
	for _, w := range s.Walls {
		switch {
		case w.Door == "door":
			door = w
		case w.Door == "secret":
			secret = w
		case w.Window:
			window = w
		default:
			plain = w
		}
	}
	if plain == nil || plain.X1 != 0 || plain.Y1 != 0 || plain.X2 != 100 {
		t.Fatalf("глухая стена не сдвинулась на padding: %+v", plain)
	}
	if door == nil || door.DoorState != "open" {
		t.Fatalf("дверь перенеслась неверно: %+v", door)
	}
	if secret == nil || secret.DoorState != "closed" {
		t.Fatalf("секретная дверь перенеслась неверно: %+v", secret)
	}
	if window == nil || window.Door != "" {
		t.Fatalf("окно перенеслось неверно: %+v", window)
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
			`<a class="catalog-ref" data-kind="note" data-name="Приложение D: правила" data-folder="Модуль/Правила/Приложения">Перемещение через существ</a>`,
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
func TestRewriteDocLinks(t *testing.T) {
	ix := &LinkIndex{targets: map[string]LinkTarget{"spl1": {Kind: "spell", Name: "Свет"}}}
	doc := Doc{
		"name":   "Жезл",
		"system": map[string]any{"description": map[string]any{"value": `даёт @UUID[Compendium.mod.spells.Item.spl1]{Свет}`}},
		"items": []any{
			map[string]any{"name": "Заряд", "system": map[string]any{"description": map[string]any{"value": `см. @UUID[Compendium.mod.spells.Item.spl1]`}}},
		},
	}
	RewriteDocLinks(doc, ix)

	if got := digString(doc, "system", "description", "value"); !strings.Contains(got, `data-kind="spell"`) {
		t.Fatalf("описание не переписано: %q", got)
	}
	nested := asMap(asSlice(doc["items"])[0])
	if got := digString(nested, "system", "description", "value"); !strings.Contains(got, `>Свет</a>`) {
		t.Fatalf("вложенный документ не переписан: %q", got)
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
	if !strings.Contains(got, `src='icons/svg/nope.svg'`) {
		t.Fatalf("ссылка без файла должна остаться как была: %q", got)
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
