//go:build corpus

package foundry

// Прогон серверной части импорта по НАСТОЯЩЕМУ модулю Foundry — страховка
// на время выноса D&D в модули (задача «Импорты при переходе на модули»).
// Чужие модули в репозиторий не кладутся, поэтому тест собирается только с
// тегом corpus и без переменных окружения пропускается:
//
//	go test -tags corpus ./internal/foundry -run Corpus
//
//	BEACON_FOUNDRY_CORPUS=<папка распакованного модуля>   — что прогонять
//	BEACON_FOUNDRY_CORPUS_OUT=<папка вне репозитория>     — где эталон и дамп
//	UPDATE_GOLDEN=1                                       — записать эталон
//
// Модули, которые уже импортировались в локальные миры, лежат распакованными
// в data/companies/<мир>/foundry-cache/<ключ>/. Кроме эталона тест кладёт в
// OUT/<id модуля>-<пак>.client.json документы по разделам — ровно то, что
// сервер отдал бы странице импорта (картинки и макросы переписаны, вложения
// приключений вынуты). На них гоняется клиентская половина
// (web/scripts/import-corpus.mjs).

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"beacon-table/internal/testutil"
)

// corpusSaver — вместо загрузки в библиотеку отдаёт предсказуемую ссылку.
type corpusSaver struct{}

func (corpusSaver) Save(_ context.Context, kind, folder, filename string, _ io.Reader) (string, error) {
	return "/uploads/" + kind + "/" + folder + "/" + filename, nil
}

func TestCorpusServerSide(t *testing.T) {
	dir, out := os.Getenv("BEACON_FOUNDRY_CORPUS"), os.Getenv("BEACON_FOUNDRY_CORPUS_OUT")
	if dir == "" || out == "" {
		t.Skip("нет BEACON_FOUNDRY_CORPUS / BEACON_FOUNDRY_CORPUS_OUT — прогон по реальному модулю не запрошен")
	}
	ctx := context.Background()
	root, man, err := findManifestDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	mod, err := openModule(root, man)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(out, 0o750); err != nil {
		t.Fatal(err)
	}
	title := man.DisplayTitle()
	links := BuildLinkIndex(mod, title)
	assets := NewAssets(mod, corpusSaver{}, "foundry/"+man.PackageID())

	report := map[string]any{}
	for _, p := range mod.Packs() {
		contents, err := mod.ReadPack(p)
		if err != nil {
			report[p.Name] = map[string]any{"error": err.Error()}
			continue
		}
		targets := map[string][]string{}
		clientDocs := map[string][]Doc{}
		var notes []map[string]any
		var scenes []any
		for _, e := range Expand(contents.Docs, p.DocType()) {
			name, _ := e.Doc["name"].(string)
			if e.Embedded {
				name += " (вложение)"
			}
			targets[e.Target] = append(targets[e.Target], name)
			switch e.Target {
			case TargetNotes:
				folder := NoteFolder(title, p.Name, contents.Folders.Path(DocFolderID(e.Doc)))
				j := MapJournal(ctx, e.Doc, folder, assets)
				notes = append(notes, map[string]any{"folder": j.Folder, "title": j.Title, "content": links.Rewrite(j.Content)})
			case TargetScenes:
				for _, s := range MapScenes(ctx, e.Doc, assets, links) {
					b, _ := json.Marshal(s)
					var g any
					_ = json.Unmarshal(b, &g)
					scenes = append(scenes, testutil.StableIDs(g))
				}
			case TargetPlaylists, TargetSkipped:
			default:
				// То, что уходит клиенту: картинки и макросы переписаны.
				assets.RewriteDoc(ctx, e.Doc)
				RewriteDocMacros(e.Doc, links)
				clientDocs[e.Target] = append(clientDocs[e.Target], e.Doc)
			}
		}
		for k := range targets {
			sort.Strings(targets[k])
		}
		report[p.Name] = map[string]any{
			"docs":    len(contents.Docs),
			"targets": targets,
			"notes":   notes,
			"scenes":  scenes,
		}
		b, _ := json.Marshal(clientDocs)
		if err := os.WriteFile(filepath.Join(out, man.PackageID()+"-"+p.Name+".client.json"), b, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	testutil.Golden(t, filepath.Join(out, "golden", man.PackageID()+".server.json"), report)
}
