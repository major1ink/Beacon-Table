package service

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository/memory"
)

// Сквозной тест импорта: поднимаем http-сервер с манифестом и архивом
// модуля, натравливаем на него FoundryService и смотрим, что пак разъехался
// по разделам — карточки отдались клиенту документами, сцена/плейлист/
// заметка разложены сервером, файлы перенесены в библиотеку загрузок.

// ---- заглушки сервисов мира ----

// fakeAssets — библиотека загрузок в памяти. Хранит то же, что и настоящая
// (kind/папка/имя → ссылка), потому что импорт на неё опирается: повторный
// перенос того же файла модуля должен узнаваться по имени и не плодить
// копию (см. assetSaver).
type fakeAssets struct {
	saved  []string
	byKind map[string][]domain.AssetInfo
	// deletedFolders — "kind/folder" каждого вызова DeleteFolder, для
	// TestFoundryModuleDelete: проверить, что "Удалить модуль" реально просит
	// снести папку модуля во всех разделах, а не только карточки.
	deletedFolders []string
}

func (f *fakeAssets) Upload(_ context.Context, _ *domain.Account, kind, folder, filename string, r io.Reader) (string, error) {
	if _, err := io.Copy(io.Discard, r); err != nil {
		return "", err
	}
	url := "/uploads/" + kind + "/" + folder + "/" + filename
	f.saved = append(f.saved, kind+"/"+filename)
	if f.byKind == nil {
		f.byKind = map[string][]domain.AssetInfo{}
	}
	f.byKind[kind] = append(f.byKind[kind], domain.AssetInfo{URL: url, Name: filename, Path: folder})
	return url, nil
}
func (f *fakeAssets) List(context.Context) (map[string][]domain.AssetInfo, error) {
	return f.byKind, nil
}
func (f *fakeAssets) FoldersAll(context.Context) (map[string][]domain.AssetFolder, error) {
	return nil, nil
}
func (f *fakeAssets) CreateFolder(context.Context, *domain.Account, string, string) error { return nil }
func (f *fakeAssets) DeleteFolder(_ context.Context, _ *domain.Account, kind, folder string) error {
	f.deletedFolders = append(f.deletedFolders, kind+"/"+folder)
	return nil
}
func (f *fakeAssets) DeleteAsset(context.Context, *domain.Account, string, string) error { return nil }

type fakeRoom struct {
	scenes []*domain.SceneState
	// linkedWith — карта, с которой позвали LinkTokensToMonsters (nil, если
	// не звали вовсе): тесты связывания смотрят именно на неё.
	linkedWith map[string]string
}

func (f *fakeRoom) Join(RoomClient)                       {}
func (f *fakeRoom) Leave(RoomClient)                      {}
func (f *fakeRoom) Dispatch(RoomClient, domain.ClientMsg) {}
func (f *fakeRoom) Shutdown()                             {}
func (f *fakeRoom) NotifyJournalChanged(string)           {}
func (f *fakeRoom) NotifyCharacterSheetChanged(string)    {}
func (f *fakeRoom) NotifyPlaylistsChanged()               {}
func (f *fakeRoom) SpawnPlayerToken(context.Context, string, string, string, string) (bool, error) {
	return false, nil
}
func (f *fakeRoom) RemoveOwnerTokens(context.Context, string) (int, error) { return 0, nil }
func (f *fakeRoom) Announce(string)                                        {}
func (f *fakeRoom) ImportScenes(_ context.Context, scenes []*domain.SceneState) (int, error) {
	f.scenes = append(f.scenes, scenes...)
	return len(scenes), nil
}

// LinkTokensToMonsters — фейк повторяет ровно то, что делает настоящая
// комната (см. Room.linkTokensToMonsters): дописывает MonsterID токенам с
// известным FoundryActorID, не трогая уже связанные.
func (f *fakeRoom) LinkTokensToMonsters(_ context.Context, monsterByActor map[string]string) (int, error) {
	f.linkedWith = monsterByActor
	linked := 0
	for _, s := range f.scenes {
		for _, t := range s.Tokens {
			if t.MonsterID != "" || t.FoundryActorID == "" {
				continue
			}
			if id, ok := monsterByActor[t.FoundryActorID]; ok {
				t.MonsterID = id
				linked++
			}
		}
	}
	return linked, nil
}

type fakePlaylists struct{ lists []*domain.Playlist }

func (f *fakePlaylists) List(context.Context) ([]*domain.Playlist, error) { return f.lists, nil }
func (f *fakePlaylists) Create(_ context.Context, name string) (*domain.Playlist, error) {
	p := &domain.Playlist{ID: name, Name: name}
	f.lists = append(f.lists, p)
	return p, nil
}
func (f *fakePlaylists) Rename(context.Context, string, string) error { return nil }
func (f *fakePlaylists) Delete(context.Context, string) error         { return nil }
func (f *fakePlaylists) AddTrack(_ context.Context, playlistID, url, name string, volume float64, loop bool) (*domain.PlaylistTrack, error) {
	track := &domain.PlaylistTrack{PlaylistID: playlistID, URL: url, Name: name, Volume: volume, Loop: loop}
	for _, p := range f.lists {
		if p.ID == playlistID {
			p.Tracks = append(p.Tracks, track)
		}
	}
	return track, nil
}
func (f *fakePlaylists) UpdateTrack(context.Context, string, string, string, float64, bool) error {
	return nil
}
func (f *fakePlaylists) DeleteTrack(context.Context, string, string) error       { return nil }
func (f *fakePlaylists) MoveTrack(context.Context, string, string, string) error { return nil }

type fakeBestiary struct{ byID map[string]*domain.Monster }

func newFakeBestiary() *fakeBestiary { return &fakeBestiary{byID: map[string]*domain.Monster{}} }
func (f *fakeBestiary) List(context.Context) ([]*domain.Monster, error) {
	out := make([]*domain.Monster, 0, len(f.byID))
	for _, m := range f.byID {
		out = append(out, m)
	}
	return out, nil
}
func (f *fakeBestiary) Get(_ context.Context, id string) (*domain.Monster, error) {
	return f.byID[id], nil
}
func (f *fakeBestiary) Create(_ context.Context, name string) (*domain.Monster, error) {
	m := &domain.Monster{ID: name, Name: name}
	f.byID[m.ID] = m
	return m, nil
}
func (f *fakeBestiary) Update(_ context.Context, id string, m domain.Monster) (*domain.Monster, error) {
	m.ID = id
	f.byID[id] = &m
	return &m, nil
}
func (f *fakeBestiary) Delete(_ context.Context, id string) error { delete(f.byID, id); return nil }

type fakeSpells struct{ byID map[string]*domain.Spell }

func newFakeSpells() *fakeSpells { return &fakeSpells{byID: map[string]*domain.Spell{}} }
func (f *fakeSpells) List(context.Context) ([]*domain.Spell, error) {
	out := make([]*domain.Spell, 0, len(f.byID))
	for _, x := range f.byID {
		out = append(out, x)
	}
	return out, nil
}
func (f *fakeSpells) Get(_ context.Context, id string) (*domain.Spell, error) { return f.byID[id], nil }
func (f *fakeSpells) Create(_ context.Context, name string) (*domain.Spell, error) {
	x := &domain.Spell{ID: name, Name: name}
	f.byID[x.ID] = x
	return x, nil
}
func (f *fakeSpells) Update(_ context.Context, id string, x domain.Spell) (*domain.Spell, error) {
	x.ID = id
	f.byID[id] = &x
	return &x, nil
}
func (f *fakeSpells) Delete(_ context.Context, id string) error { delete(f.byID, id); return nil }

type fakeItems struct{ byID map[string]*domain.Item }

func newFakeItems() *fakeItems { return &fakeItems{byID: map[string]*domain.Item{}} }
func (f *fakeItems) List(context.Context) ([]*domain.Item, error) {
	out := make([]*domain.Item, 0, len(f.byID))
	for _, x := range f.byID {
		out = append(out, x)
	}
	return out, nil
}
func (f *fakeItems) Get(_ context.Context, id string) (*domain.Item, error) { return f.byID[id], nil }
func (f *fakeItems) Create(_ context.Context, name string) (*domain.Item, error) {
	x := &domain.Item{ID: name, Name: name}
	f.byID[x.ID] = x
	return x, nil
}
func (f *fakeItems) Update(_ context.Context, id string, x domain.Item) (*domain.Item, error) {
	x.ID = id
	f.byID[id] = &x
	return &x, nil
}
func (f *fakeItems) Delete(_ context.Context, id string) error { delete(f.byID, id); return nil }

type fakeReferences struct{ byID map[string]*domain.Reference }

func newFakeReferences() *fakeReferences {
	return &fakeReferences{byID: map[string]*domain.Reference{}}
}
func (f *fakeReferences) List(context.Context) ([]*domain.Reference, error) {
	out := make([]*domain.Reference, 0, len(f.byID))
	for _, x := range f.byID {
		out = append(out, x)
	}
	return out, nil
}
func (f *fakeReferences) Get(_ context.Context, id string) (*domain.Reference, error) {
	return f.byID[id], nil
}
func (f *fakeReferences) Create(_ context.Context, name string) (*domain.Reference, error) {
	x := &domain.Reference{ID: name, Name: name}
	f.byID[x.ID] = x
	return x, nil
}
func (f *fakeReferences) Update(_ context.Context, id string, x domain.Reference) (*domain.Reference, error) {
	x.ID = id
	f.byID[id] = &x
	return &x, nil
}
func (f *fakeReferences) Delete(_ context.Context, id string) error { delete(f.byID, id); return nil }

type fakeConditionSvc struct{ byID map[string]*domain.Condition }

func newFakeConditions() *fakeConditionSvc {
	return &fakeConditionSvc{byID: map[string]*domain.Condition{}}
}
func (f *fakeConditionSvc) List(context.Context) ([]*domain.Condition, error) {
	out := make([]*domain.Condition, 0, len(f.byID))
	for _, x := range f.byID {
		out = append(out, x)
	}
	return out, nil
}
func (f *fakeConditionSvc) Get(_ context.Context, id string) (*domain.Condition, error) {
	return f.byID[id], nil
}
func (f *fakeConditionSvc) BySlug(_ context.Context, slug string) (*domain.Condition, error) {
	for _, x := range f.byID {
		if x.Slug == slug {
			return x, nil
		}
	}
	return nil, nil
}
func (f *fakeConditionSvc) Create(_ context.Context, name string) (*domain.Condition, error) {
	x := &domain.Condition{ID: name, Name: name}
	f.byID[x.ID] = x
	return x, nil
}
func (f *fakeConditionSvc) Update(_ context.Context, id string, x domain.Condition) (*domain.Condition, error) {
	x.ID = id
	f.byID[id] = &x
	return &x, nil
}
func (f *fakeConditionSvc) Delete(_ context.Context, id string) error { delete(f.byID, id); return nil }

// ---- модуль-фикстура ----

// packFile — один пак в формате "каталог с .json" (исходники паков): для
// теста он честнее LevelDB — тот собирается бинарём Foundry, а формат
// json-каталога модули кладут в релиз как есть.
type packFile struct {
	path    string
	content string
}

func moduleZip(t *testing.T, manifest string, files []packFile) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	write := func(name, content string) {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(w, content); err != nil {
			t.Fatal(err)
		}
	}
	// Содержимое вложено в папку модуля — так собирают релизы чаще всего,
	// заодно проверяем поиск манифеста внутри архива.
	write("my-module/module.json", manifest)
	for _, f := range files {
		write("my-module/"+f.path, f.content)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestFoundryImportEndToEnd(t *testing.T) {
	manifest := `{
	  "id": "my-module",
	  "title": "Мой модуль",
	  "version": "1.2.3",
	  "download": "PLACEHOLDER",
	  "packs": [
	    {"name": "gear", "label": "Снаряжение", "path": "packs/_source/gear", "type": "Item"},
	    {"name": "places", "label": "Места", "path": "packs/_source/places", "type": "Scene"},
	    {"name": "music", "label": "Музыка", "path": "packs/_source/music", "type": "Playlist"},
	    {"name": "lore", "label": "Лор", "path": "packs/_source/lore", "type": "JournalEntry"}
	  ]
	}`
	files := []packFile{
		{"icons/sword.webp", "webp"},
		{"audio/tavern.ogg", "ogg"},
		{"maps/town.webp", "webp"},
		{"packs/_source/gear/sword.json", `{"_id":"i1","name":"Длинный меч","type":"weapon","img":"modules/my-module/icons/sword.webp","system":{}}`},
		{"packs/_source/gear/light.json", `{"_id":"i2","name":"Свет","type":"spell","system":{"level":0}}`},
		{"packs/_source/places/town.json", `{"_id":"s1","name":"Городок","width":1000,"height":800,"padding":0,` +
			`"grid":{"type":1,"size":100,"distance":5,"units":"фт"},` +
			`"background":{"src":"modules/my-module/maps/town.webp"},` +
			`"walls":[{"c":[0,0,100,0]}],` +
			`"notes":[{"entryId":"j1","x":150,"y":150}]}`},
		{"packs/_source/music/tavern.json", `{"_id":"p1","name":"Таверна","playing":false,` +
			`"sounds":[{"name":"Лютня","path":"modules/my-module/audio/tavern.ogg","volume":0.4,"repeat":true}]}`},
		// Журнал лежит во вложенной папке компендиума — в библиотеке заметок
		// должна получиться такая же (плюс два верхних уровня: модуль и пак).
		{"packs/_source/lore/folder-chapter.json", `{"_key":"!folders!f1","_id":"f1","name":"Глава 1","type":"JournalEntry","sorting":"a"}`},
		{"packs/_source/lore/folder-npc.json", `{"_key":"!folders!f2","_id":"f2","name":"NPC","type":"JournalEntry","sorting":"a","folder":"f1"}`},
		{"packs/_source/lore/legends.json", `{"_key":"!journal!j1","_id":"j1","name":"Легенды","folder":"f2","pages":[{"name":"Пролог","type":"text","text":{"content":"<p>Карта: @UUID[Compendium.my-module.places.Scene.s1], музыка: @UUID[Compendium.my-module.music.Playlist.p1]{включить}</p>"}}]}`},
	}

	var archive []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/module.json":
			io.WriteString(w, strings.Replace(manifest, "PLACEHOLDER", "http://"+r.Host+"/module.zip", 1))
		case "/module.zip":
			w.Write(archive)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()
	archive = moduleZip(t, strings.Replace(manifest, "PLACEHOLDER", srv.URL+"/module.zip", 1), files)

	assets := &fakeAssets{}
	room := &fakeRoom{}
	playlists := &fakePlaylists{}
	svc := NewFoundryService(t.TempDir(), assets, room, playlists, memory.NewFoundryModuleStore(),
		newFakeBestiary(), newFakeSpells(), newFakeItems(), newFakeReferences(), newFakeConditions(), memory.NewPregenStore(), true)
	ctx := context.Background()
	account := &domain.Account{ID: "dm", Role: "admin"}

	pkg, err := svc.Inspect(ctx, srv.URL+"/module.json")
	if err != nil {
		t.Fatal(err)
	}
	if pkg.Title != "Мой модуль" || pkg.Version != "1.2.3" || len(pkg.Packs) != 4 {
		t.Fatalf("разведка вернула не то: %+v", pkg)
	}
	gear := pkg.Packs[0]
	if gear.Targets["items"] != 1 || gear.Targets["spells"] != 1 {
		t.Fatalf("пак предметов не разъехался по разделам: %+v", gear.Targets)
	}

	// Карточки: сервер отдаёт документы клиенту, ничего сам не создаёт.
	res, err := svc.ImportPack(ctx, account, srv.URL+"/module.json", "gear", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Docs["items"]) != 1 || len(res.Docs["spells"]) != 1 {
		t.Fatalf("документы карточек не приехали: %+v", res.Docs)
	}
	img, _ := res.Docs["items"][0]["img"].(string)
	if !strings.HasPrefix(img, "/uploads/tokens/foundry/my-module/") {
		t.Fatalf("иконка предмета не перенесена: %q", img)
	}
	if res.Assets != 1 {
		t.Fatalf("файлов перенесено %d, ожидали 1", res.Assets)
	}

	// Повторный импорт того же пака не копирует картинку заново и отдаёт ту
	// же ссылку: иначе каждая карточка и заметка с картинкой выглядела бы
	// изменившейся при сравнении с уже импортированной (см. assetSaver).
	again, err := svc.ImportPack(ctx, account, srv.URL+"/module.json", "gear", nil)
	if err != nil {
		t.Fatal(err)
	}
	if imgAgain, _ := again.Docs["items"][0]["img"].(string); imgAgain != img {
		t.Fatalf("ссылка на картинку изменилась при повторном импорте: %q → %q", img, imgAgain)
	}
	if len(assets.saved) != 1 {
		t.Fatalf("файл сохранён %d раз(а), ожидали 1: %v", len(assets.saved), assets.saved)
	}

	// Выбор разделов: просим только заклинания — предмет должен отсеяться.
	res, err = svc.ImportPack(ctx, account, srv.URL+"/module.json", "gear", []string{"spells"})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Docs["items"]) != 0 || len(res.Docs["spells"]) != 1 || res.Skipped != 1 {
		t.Fatalf("фильтр разделов не сработал: %+v (skipped=%d)", res.Docs, res.Skipped)
	}

	// Сцена, плейлист и заметка — их раскладывает сам сервер.
	if _, err := svc.ImportPack(ctx, account, srv.URL+"/module.json", "places", nil); err != nil {
		t.Fatal(err)
	}
	if len(room.scenes) != 1 || room.scenes[0].Name != "Городок" || len(room.scenes[0].Walls) != 1 {
		t.Fatalf("сцена не доехала до комнаты: %+v", room.scenes)
	}
	if !strings.HasPrefix(room.scenes[0].MapURL, "/uploads/maps/") {
		t.Fatalf("фон карты не перенесён: %q", room.scenes[0].MapURL)
	}
	// Значок Foundry на карте (notes[]) → domain.NoteMarker с «якорем» на
	// запись журнала (её id ещё неизвестен — заводит клиент).
	if len(room.scenes[0].NoteMarkers) != 1 {
		t.Fatalf("значков на карте %d, ожидали 1", len(room.scenes[0].NoteMarkers))
	}
	var marker *domain.NoteMarker
	for _, nm := range room.scenes[0].NoteMarkers {
		marker = nm
	}
	if marker.FoundryEntry != "Легенды" || marker.FoundryFolder != "Мой модуль/Лор/Глава 1/NPC" || marker.NoteID != "" {
		t.Fatalf("значок связался неверно: %+v", marker)
	}
	if _, err := svc.ImportPack(ctx, account, srv.URL+"/module.json", "music", nil); err != nil {
		t.Fatal(err)
	}
	if len(playlists.lists) != 1 || len(playlists.lists[0].Tracks) != 1 {
		t.Fatalf("плейлист не завёлся: %+v", playlists.lists)
	}
	if !strings.HasPrefix(playlists.lists[0].Tracks[0].URL, "/uploads/audio/") {
		t.Fatalf("трек не перенесён: %q", playlists.lists[0].Tracks[0].URL)
	}
	// Журналы сервер НЕ заводит сам (при совпадении с существующей заметкой
	// решение принимает ДМ, см. FoundryImport.Notes) — только готовит текст
	// и папку.
	res, err = svc.ImportPack(ctx, account, srv.URL+"/module.json", "lore", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Notes) != 1 {
		t.Fatalf("заметок подготовлено %d, ожидали 1: %+v", len(res.Notes), res.Notes)
	}
	note := res.Notes[0]
	if note.Title != "Легенды" || !strings.HasPrefix(note.Content, "# Легенды") {
		t.Fatalf("заметка собралась неверно: %+v", note)
	}
	if note.Folder != "Мой модуль/Лор/Глава 1/NPC" {
		t.Fatalf("папка заметки: %q", note.Folder)
	}
	// Ссылка на сцену внутри текста → кликабельный <a data-kind="scene">
	// (клиент по имени переключит карту стола, см. web/src/catalog-links.js).
	if !strings.Contains(note.Content, `data-kind="scene" data-name="Городок"`) {
		t.Fatalf("ссылка на сцену не стала кликабельной: %q", note.Content)
	}
	if !strings.Contains(note.Content, `data-kind="playlist" data-name="Таверна"`) {
		t.Fatalf("ссылка на плейлист не стала кликабельной: %q", note.Content)
	}
}

// TestFoundryModuleDelete проверяет, что "Удалить модуль" сносит только
// карточки, помеченные его id (руками заведённые остаются), просит удалить
// файловые папки во всех разделах и забывает саму запись об установке.
func TestFoundryModuleDelete(t *testing.T) {
	modules := memory.NewFoundryModuleStore()
	bestiary := newFakeBestiary()
	spells := newFakeSpells()
	assets := &fakeAssets{}
	svc := NewFoundryService(t.TempDir(), assets, &fakeRoom{}, &fakePlaylists{}, modules,
		bestiary, spells, newFakeItems(), newFakeReferences(), newFakeConditions(), memory.NewPregenStore(), true)
	ctx := context.Background()

	if err := modules.Upsert(ctx, domain.FoundryModule{
		ID: "my-module", Title: "Мой модуль", Version: "1.0.0",
		ManifestURL: "https://example.com/module.json", ImportedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}

	tagged, _ := bestiary.Create(ctx, "Гоблин")
	tagged.FoundryModuleID = "my-module"
	if _, err := bestiary.Update(ctx, tagged.ID, *tagged); err != nil {
		t.Fatal(err)
	}
	manual, _ := bestiary.Create(ctx, "Ручной монстр") // FoundryModuleID пуст — как будто ДМ завёл сам
	taggedSpell, _ := spells.Create(ctx, "Огненный шар")
	taggedSpell.FoundryModuleID = "my-module"
	if _, err := spells.Update(ctx, taggedSpell.ID, *taggedSpell); err != nil {
		t.Fatal(err)
	}

	account := &domain.Account{ID: "dm", Role: "admin"}
	result, err := svc.Delete(ctx, account, "my-module")
	if err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if len(result.Warnings) != 0 {
		t.Fatalf("не ожидали предупреждений: %v", result.Warnings)
	}
	if result.Cards["monsters"] != 1 || result.Cards["spells"] != 1 {
		t.Fatalf("карточек удалено: %+v", result.Cards)
	}
	if _, ok := bestiary.byID[tagged.ID]; ok {
		t.Fatal("помеченный монстр должен был удалиться")
	}
	if _, ok := bestiary.byID[manual.ID]; !ok {
		t.Fatal("ручной монстр не должен был удалиться")
	}
	if _, ok := spells.byID[taggedSpell.ID]; ok {
		t.Fatal("помеченное заклинание должно было удалиться")
	}

	wantFolders := map[string]bool{
		"maps/foundry/my-module": true, "tokens/foundry/my-module": true,
		"audio/foundry/my-module": true, "notes/foundry/my-module": true,
	}
	if len(assets.deletedFolders) != len(wantFolders) {
		t.Fatalf("папки файлов: %v", assets.deletedFolders)
	}
	for _, f := range assets.deletedFolders {
		if !wantFolders[f] {
			t.Fatalf("неожиданная папка удалена: %s", f)
		}
	}

	if _, err := modules.ByID(ctx, "my-module"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("запись об установке должна была исчезнуть, err=%v", err)
	}
	if _, err := svc.Delete(ctx, account, "my-module"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("повторное удаление несуществующего модуля должно быть ErrNotFound, err=%v", err)
	}
}

func TestFoundryInspectRejectsBadURL(t *testing.T) {
	svc := NewFoundryService(t.TempDir(), &fakeAssets{}, &fakeRoom{}, &fakePlaylists{}, memory.NewFoundryModuleStore(),
		newFakeBestiary(), newFakeSpells(), newFakeItems(), newFakeReferences(), newFakeConditions(), memory.NewPregenStore(), true)
	if _, err := svc.Inspect(context.Background(), "file:///etc/passwd"); err == nil {
		t.Fatal("не-http ссылка должна отклоняться")
	}
}

// TestFoundryLinkSceneTokens — отложенное связывание токенов импортированной
// сцены со статблоками (см. FoundryService.LinkSceneTokens).
//
// Проверяется именно ПОРЯДОК, из-за которого связывание вообще пришлось
// делать отдельным шагом: сцена уже разложена, а карточки существ появляются
// в бестиарии позже (их заводит клиент, см. package doc FoundryService).
func TestFoundryLinkSceneTokens(t *testing.T) {
	bestiary := newFakeBestiary()
	room := &fakeRoom{}
	svc := NewFoundryService(t.TempDir(), &fakeAssets{}, room, &fakePlaylists{}, memory.NewFoundryModuleStore(),
		bestiary, newFakeSpells(), newFakeItems(), newFakeReferences(), newFakeConditions(), memory.NewPregenStore(), true)
	ctx := context.Background()

	scene := domain.NewScene("sc1", "Логово")
	scene.Tokens["t-goblin"] = &domain.Token{ID: "t-goblin", Label: "Гоблин-воитель", FoundryActorID: "actor-goblin"}
	scene.Tokens["t-orc"] = &domain.Token{ID: "t-orc", Label: "Орк", FoundryActorID: "actor-orc"}
	// Токен, которого ДМ привязал руками к своей карточке: повторный импорт
	// не должен перебивать его выбор.
	scene.Tokens["t-manual"] = &domain.Token{ID: "t-manual", Label: "Вожак", FoundryActorID: "actor-goblin", MonsterID: "my-own"}
	// Декорация/свет — якоря нет вовсе, связывать нечего.
	scene.Tokens["t-lamp"] = &domain.Token{ID: "t-lamp", LightOnly: true}
	if _, err := room.ImportScenes(ctx, []*domain.SceneState{scene}); err != nil {
		t.Fatal(err)
	}

	// Пока бестиарий пуст, шаг ничего не делает и до комнаты вообще не идёт.
	linked, err := svc.LinkSceneTokens(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if linked != 0 || room.linkedWith != nil {
		t.Fatalf("без карточек существ связывать нечего: linked=%d, linkedWith=%v", linked, room.linkedWith)
	}

	goblin, _ := bestiary.Create(ctx, "Гоблин-воитель")
	goblin.FoundryActorID = "actor-goblin"
	if _, err := bestiary.Update(ctx, goblin.ID, *goblin); err != nil {
		t.Fatal(err)
	}
	manual, _ := bestiary.Create(ctx, "Ручной монстр") // без FoundryActorID — в карту не попадёт
	_ = manual

	linked, err = svc.LinkSceneTokens(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if linked != 1 {
		t.Fatalf("связали %d токенов, ожидали 1", linked)
	}
	if got := scene.Tokens["t-goblin"].MonsterID; got != goblin.ID {
		t.Fatalf("гоблин не получил статблок: %q", got)
	}
	if got := scene.Tokens["t-manual"].MonsterID; got != "my-own" {
		t.Fatalf("ручная привязка перебита: %q", got)
	}
	if got := scene.Tokens["t-orc"].MonsterID; got != "" {
		t.Fatalf("орка не с чем было связывать, а он связался: %q", got)
	}
	if _, ok := room.linkedWith["actor-goblin"]; !ok || len(room.linkedWith) != 1 {
		t.Fatalf("в комнату уехала неверная карта: %v", room.linkedWith)
	}

	// Повтор идемпотентен: связывать больше нечего, ничего не ломается.
	linked, err = svc.LinkSceneTokens(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if linked != 0 {
		t.Fatalf("повторный проход связал %d токенов, ожидали 0", linked)
	}
}
