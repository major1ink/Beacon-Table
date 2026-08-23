package service

import (
	"archive/zip"
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"beacon-table/internal/domain"
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
func (f *fakeAssets) DeleteFolder(context.Context, *domain.Account, string, string) error { return nil }
func (f *fakeAssets) DeleteAsset(context.Context, *domain.Account, string, string) error  { return nil }

type fakeRoom struct{ scenes []*domain.SceneState }

func (f *fakeRoom) Join(RoomClient)                       {}
func (f *fakeRoom) Leave(RoomClient)                      {}
func (f *fakeRoom) Dispatch(RoomClient, domain.ClientMsg) {}
func (f *fakeRoom) Shutdown()                             {}
func (f *fakeRoom) ImportScenes(_ context.Context, scenes []*domain.SceneState) (int, error) {
	f.scenes = append(f.scenes, scenes...)
	return len(scenes), nil
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
			`"walls":[{"c":[0,0,100,0]}]}`},
		{"packs/_source/music/tavern.json", `{"_id":"p1","name":"Таверна","playing":false,` +
			`"sounds":[{"name":"Лютня","path":"modules/my-module/audio/tavern.ogg","volume":0.4,"repeat":true}]}`},
		// Журнал лежит во вложенной папке компендиума — в библиотеке заметок
		// должна получиться такая же (плюс два верхних уровня: модуль и пак).
		{"packs/_source/lore/folder-chapter.json", `{"_key":"!folders!f1","_id":"f1","name":"Глава 1","type":"JournalEntry","sorting":"a"}`},
		{"packs/_source/lore/folder-npc.json", `{"_key":"!folders!f2","_id":"f2","name":"NPC","type":"JournalEntry","sorting":"a","folder":"f1"}`},
		{"packs/_source/lore/legends.json", `{"_key":"!journal!j1","_id":"j1","name":"Легенды","folder":"f2","pages":[{"name":"Пролог","type":"text","text":{"content":"<p>Текст</p>"}}]}`},
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
	svc := NewFoundryService(t.TempDir(), assets, room, playlists)
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
}

func TestFoundryInspectRejectsBadURL(t *testing.T) {
	svc := NewFoundryService(t.TempDir(), &fakeAssets{}, &fakeRoom{}, &fakePlaylists{})
	if _, err := svc.Inspect(context.Background(), "file:///etc/passwd"); err == nil {
		t.Fatal("не-http ссылка должна отклоняться")
	}
}
