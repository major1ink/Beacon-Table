package service

// Страховочный сквозной тест импорта пакета Foundry перед выносом D&D в
// модули (задача «Импорты при переходе на модули»). Модуль собирается из тех
// же фикстур, что и клиентские тесты мапперов (web/test/fixtures/foundry —
// документы реальной структуры dnd5e 5.x и старых схем), плюс синтетические
// паки всех остальных типов: сцена, журнал с папками и ссылками, плейлист,
// приключение, таблица, макрос.
//
// В эталон testdata/foundry-import.golden.json попадает то, что делает
// сервер: куда разъехался каждый документ, что сервер в нём переписал
// (картинки, ссылки, макросы), какие заметки, сцены и плейлисты получились.
// Сами карточки из документов собирает клиент — это web/test/import-golden.test.js.
//
// Пересобрать эталон: UPDATE_GOLDEN=1 go test ./internal/service -run FoundryImportGolden

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository/memory"
	"beacon-table/internal/testutil"
)

const fixturesDir = "../../web/test/fixtures/foundry"

func loadFixtureDocs(t *testing.T, name string) []map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(fixturesDir, name)) //nolint:gosec // путь к фикстуре задаёт тест
	if err != nil {
		t.Fatal(err)
	}
	var docs []map[string]any
	if err := json.Unmarshal(raw, &docs); err != nil {
		t.Fatal(err)
	}
	return docs
}

func loadLegacyDocs(t *testing.T) map[string][]map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(fixturesDir, "legacy-v2-v3.json"))
	if err != nil {
		t.Fatal(err)
	}
	var out map[string][]map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	// У рукописных фикстур старых схем нет _id — даём стабильные.
	for kind, docs := range out {
		for i, d := range docs {
			if _, ok := d["_id"]; !ok {
				d["_id"] = kind + "-legacy-" + string(rune('a'+i))
			}
		}
	}
	return out
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func generic(t *testing.T, v any) any {
	t.Helper()
	var out any
	if err := json.Unmarshal([]byte(mustJSON(t, v)), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestFoundryImportGolden(t *testing.T) {
	npc := loadFixtureDocs(t, "actors-npc.json")
	vehicle := loadFixtureDocs(t, "actors-vehicle.json")
	chars := loadFixtureDocs(t, "actors-character.json")
	spells := loadFixtureDocs(t, "spells.json")
	items := loadFixtureDocs(t, "items.json")
	refs := loadFixtureDocs(t, "references.json")
	legacy := loadLegacyDocs(t)

	const moduleID = "ag-fifthpendium"
	goblinID, _ := npc[0]["_id"].(string)
	swordID, _ := items[0]["_id"].(string)
	scene := map[string]any{
		"_id": "scene01", "name": "Пещера гоблинов", "width": 2000, "height": 1500, "padding": 0,
		"grid":       map[string]any{"type": 1, "size": 100, "distance": 5, "units": "фт"},
		"background": map[string]any{"src": "modules/" + moduleID + "/maps/cave.webp"},
		"walls":      []any{map[string]any{"c": []any{0, 0, 500, 0}}, map[string]any{"c": []any{500, 0, 500, 500}, "door": 1, "ds": 0}},
		"lights":     []any{map[string]any{"x": 300, "y": 300, "config": map[string]any{"bright": 10, "dim": 20, "color": "#ff9900"}}},
		"tokens": []any{
			map[string]any{"name": "Гоблин-воитель", "actorId": goblinID, "x": 100, "y": 100, "width": 1, "height": 1, "texture": map[string]any{"src": "modules/" + moduleID + "/tokens/goblin.webp"}},
			map[string]any{"name": "Незнакомец", "actorId": "нет-такого", "x": 200, "y": 100, "width": 1, "height": 1},
		},
		"notes": []any{map[string]any{"entryId": "journal01", "x": 400, "y": 400}},
	}
	journalFolder := map[string]any{"_key": "!folders!fold01", "_id": "fold01", "name": "Глава 1", "type": "JournalEntry", "sorting": "a"}
	journal := map[string]any{
		"_key": "!journal!journal01", "_id": "journal01", "name": "Вход в пещеру", "folder": "fold01",
		"pages": []any{
			map[string]any{"name": "Описание", "type": "text", "text": map[string]any{"content": "<p>Здесь живут @UUID[Compendium." + moduleID + ".actors.Actor." + goblinID + "]{гоблины}. " +
				"Спасбросок [[/save dex 15]], урон [[/damage 2d6 fire]], [[/check wis 12]]. Сбивает с ног: &amp;Reference[condition=prone]{Лежит}. " +
				"Меч: @UUID[Compendium." + moduleID + ".items.Item." + swordID + "]. Карта: @UUID[Compendium." + moduleID + ".places.Scene.scene01]. " +
				"Бросок [[1d20+5]].</p><img src=\"modules/" + moduleID + "/maps/cave.webp\">"}},
			map[string]any{"name": "Карта", "type": "image", "src": "modules/" + moduleID + "/maps/cave.webp"},
		},
	}
	playlist := map[string]any{"_id": "music01", "name": "Пещера", "playing": false,
		"sounds": []any{map[string]any{"name": "Капли", "path": "modules/" + moduleID + "/audio/drops.ogg", "volume": 0.5, "repeat": true}}}
	table := map[string]any{"_id": "table01", "name": "Случайные встречи", "formula": "1d6", "results": []any{}}
	macro := map[string]any{"_id": "macro01", "name": "Макрос", "type": "script", "command": "console.log(1)"}
	adventure := map[string]any{
		"_id": "adv01", "name": "Маленькое приключение", "caption": "", "description": "<p>Текст.</p>",
		"actors": []any{npc[0], chars[0]}, "items": []any{items[2]}, "journal": []any{journal}, "scenes": []any{scene},
		"playlists": []any{playlist}, "tables": []any{table}, "macros": []any{macro}, "folders": []any{journalFolder},
	}

	type pack struct {
		name, typ string
		docs      []map[string]any
	}
	packs := []pack{
		{"actors", "Actor", append(append(append([]map[string]any{}, npc...), vehicle...), append(chars, legacy["npc"]...)...)},
		{"spells", "Item", append(append([]map[string]any{}, spells...), legacy["spells"]...)},
		{"items", "Item", append(append([]map[string]any{}, items...), legacy["items"]...)},
		{"references", "Item", refs},
		{"places", "Scene", []map[string]any{scene}},
		{"lore", "JournalEntry", []map[string]any{journalFolder, journal}},
		{"music", "Playlist", []map[string]any{playlist}},
		{"tables", "RollTable", []map[string]any{table}},
		{"macros", "Macro", []map[string]any{macro}},
		{"adventure", "Adventure", []map[string]any{adventure}},
	}

	originals := map[string]map[string]any{}
	var manifestPacks []map[string]any
	var files []packFile
	for _, p := range packs {
		manifestPacks = append(manifestPacks, map[string]any{"name": p.name, "label": p.name, "path": "packs/_source/" + p.name, "type": p.typ, "system": "dnd5e"})
		for i, d := range p.docs {
			id, _ := d["_id"].(string)
			if id == "" {
				t.Fatalf("у документа %v нет _id", d["name"])
			}
			originals[p.name+"/"+id] = generic(t, d).(map[string]any)
			files = append(files, packFile{path: "packs/_source/" + p.name + "/" + strings.ReplaceAll(id, "/", "_") + "-" + string(rune('a'+i%26)) + ".json", content: mustJSON(t, d)})
		}
	}
	// Часть картинок есть в архиве, часть нет — как у настоящих модулей.
	for _, f := range []string{"maps/cave.webp", "tokens/goblin.webp", "audio/drops.ogg"} {
		files = append(files, packFile{path: f, content: "DATA-" + f})
	}
	if img, _ := items[4]["img"].(string); strings.HasPrefix(img, "modules/"+moduleID+"/") {
		files = append(files, packFile{path: strings.TrimPrefix(img, "modules/"+moduleID+"/"), content: "DATA-item"})
	}
	manifest := mustJSON(t, map[string]any{
		"id": moduleID, "title": "Фикстуры dnd5e", "version": "1.0.0", "download": "PLACEHOLDER",
		"packs": manifestPacks, "relationships": map[string]any{"systems": []any{map[string]any{"id": "dnd5e", "type": "system"}}},
	})

	var archive []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/module.json":
			_, _ = io.WriteString(w, strings.Replace(manifest, "PLACEHOLDER", "http://"+r.Host+"/module.zip", 1))
		case "/module.zip":
			_, _ = w.Write(archive)
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
	inspect := map[string]any{}
	for _, p := range pkg.Packs {
		inspect[p.Name] = map[string]any{"type": p.Type, "count": p.Count, "targets": p.Targets, "error": p.Error}
	}

	imported := map[string]any{}
	for _, p := range packs {
		res, err := svc.ImportPack(ctx, account, srv.URL+"/module.json", p.name, nil)
		if err != nil {
			t.Fatalf("пак %s: %v", p.name, err)
		}
		docs := map[string]any{}
		for target, list := range res.Docs {
			var out []any
			for _, d := range list {
				id, _ := d["_id"].(string)
				entry := map[string]any{"name": d["name"], "type": d["type"]}
				if orig, ok := originals[p.name+"/"+id]; ok {
					// Что сервер переписал в документе по дороге к клиенту.
					if diffs := testutil.JSONDiff(orig, generic(t, d)); len(diffs) > 0 {
						entry["rewritten"] = diffs
					}
				} else {
					entry["from"] = "вложение" // вынут из приключения или из актёра
				}
				out = append(out, entry)
			}
			docs[target] = out
		}
		imported[p.name] = map[string]any{
			"docs": docs, "notes": res.Notes, "applied": res.Applied, "skipped": res.Skipped,
			"assets": res.Assets, "assetsMissing": res.AssetsMissing, "warnings": res.Warnings,
		}
	}

	// Сцены с токенами: связь токена с актёром сохраняется якорем
	// FoundryActorID до того, как клиент заведёт карточки существ.
	testutil.Golden(t, "testdata/foundry-import.golden.json", map[string]any{
		"inspect":   inspect,
		"packs":     imported,
		"scenes":    testutil.StableIDs(generic(t, room.scenes)),
		"playlists": generic(t, playlists.lists),
		"uploaded":  len(assets.saved),
	})
}
