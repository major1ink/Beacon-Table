package app

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository/sqlite"
)

func newTestManager(t *testing.T) (*CompanyManager, string) {
	t.Helper()
	db, err := sqlite.Open(":memory:")
	if err != nil {
		t.Fatalf("sqlite.Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	root := t.TempDir()
	m := &CompanyManager{
		db:          db,
		companies:   sqlite.NewCompanyStore(db),
		dataRoot:    filepath.Join(root, "data"),
		uploadsRoot: filepath.Join(root, "uploads"),
		uploadsURL:  "/uploads/",
	}
	return m, root
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func TestWorldPack_RoundTrip(t *testing.T) {
	ctx := context.Background()
	m, _ := newTestManager(t)

	src, err := m.Create(ctx, "Демо-мир", domain.SystemDnD5e2024)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	srcData, srcUploads, srcURL := m.rootsFor(src)

	writeFile(t, filepath.Join(srcData, "scenes", "scenes", "scene-1.json"),
		`{"id":"scene-1","mapUrl":"`+srcURL+`maps/map.png"}`)
	writeFile(t, filepath.Join(srcData, "journal", "Глава 1", "e1.md"),
		"---\nowner: acc-123\nownerName: Гвен\ndefault: observer\naccess:\n  acc-9: owner\n---\n# Таверна\n\n![map](/uploads/companies/"+src.ID+"/maps/map.png)\n")
	writeFile(t, filepath.Join(srcData, "bestiary", "bestiary", "m1.json"),
		`{"id":"m1","name":"Гоблин","imageUrl":"`+srcURL+`tokens/g.png"}`)
	writeFile(t, filepath.Join(srcUploads, "maps", "map.png"), "PNGDATA-map")
	writeFile(t, filepath.Join(srcUploads, "tokens", "g.png"), "PNGDATA-goblin")

	ps := sqlite.NewPlaylistStore(m.db, src.ID)
	if err := ps.Create(ctx, "pl-1", "Бой"); err != nil {
		t.Fatalf("playlist create: %v", err)
	}
	if err := ps.AddTrack(ctx, "tr-1", "pl-1", srcURL+"audio/x.mp3", "Драка", 0.7, true); err != nil {
		t.Fatalf("playlist track: %v", err)
	}
	pg := sqlite.NewPregenStore(m.db, src.ID)
	if err := pg.Create(ctx, &domain.Pregen{ID: "pg-1", Name: "Аня", AvatarURL: srcURL + "tokens/anya.png"}); err != nil {
		t.Fatalf("pregen create: %v", err)
	}

	var buf bytes.Buffer
	if err := m.ExportWorld(ctx, src.ID, "test", &buf); err != nil {
		t.Fatalf("ExportWorld: %v", err)
	}

	zipPath := filepath.Join(t.TempDir(), "w.zip")
	if err := os.WriteFile(zipPath, buf.Bytes(), 0o600); err != nil {
		t.Fatalf("write zip: %v", err)
	}
	dst, err := m.ImportWorld(ctx, zipPath)
	if err != nil {
		t.Fatalf("ImportWorld: %v", err)
	}
	if dst.ID == src.ID {
		t.Fatal("импортированный мир получил тот же id, что и исходный")
	}
	if dst.Name != "Демо-мир" || dst.System != domain.SystemDnD5e2024 {
		t.Fatalf("метаданные мира не сохранились: %+v", dst)
	}
	dstData, dstUploads, dstURL := m.rootsFor(dst)

	scene := readFile(t, filepath.Join(dstData, "scenes", "scenes", "scene-1.json"))
	if !strings.Contains(scene, dstURL+"maps/map.png") || strings.Contains(scene, src.ID) {
		t.Fatalf("URL в сцене не переписан: %s", scene)
	}
	journal := readFile(t, filepath.Join(dstData, "journal", "Глава 1", "e1.md"))
	if strings.Contains(journal, "owner:") || strings.Contains(journal, "acc-123") {
		t.Fatalf("привязка к аккаунту осталась в журнале: %s", journal)
	}
	if !strings.Contains(journal, "default: observer") {
		t.Fatalf("уровень видимости журнала потерян: %s", journal)
	}
	if !strings.Contains(journal, dstURL+"maps/map.png") {
		t.Fatalf("URL в журнале не переписан: %s", journal)
	}
	monster := readFile(t, filepath.Join(dstData, "bestiary", "bestiary", "m1.json"))
	if !strings.Contains(monster, dstURL+"tokens/g.png") {
		t.Fatalf("URL в карточке бестиария не переписан: %s", monster)
	}
	if got := readFile(t, filepath.Join(dstUploads, "maps", "map.png")); got != "PNGDATA-map" {
		t.Fatalf("файл загрузки не перенесён дословно: %q", got)
	}

	pls, err := sqlite.NewPlaylistStore(m.db, dst.ID).List(ctx)
	if err != nil || len(pls) != 1 || len(pls[0].Tracks) != 1 {
		t.Fatalf("плейлист не импортирован: %+v (err %v)", pls, err)
	}
	if pls[0].Tracks[0].URL != dstURL+"audio/x.mp3" {
		t.Fatalf("URL трека не переписан: %s", pls[0].Tracks[0].URL)
	}
	pgs, err := sqlite.NewPregenStore(m.db, dst.ID).List(ctx)
	if err != nil || len(pgs) != 1 || pgs[0].AvatarURL != dstURL+"tokens/anya.png" {
		t.Fatalf("преген не импортирован/URL не переписан: %+v (err %v)", pgs, err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path) //nolint:gosec // тестовый путь
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}

func makeZip(t *testing.T, files map[string]string) string {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range files {
		fw, err := zw.Create(name)
		if err != nil {
			t.Fatalf("zip create %s: %v", name, err)
		}
		if _, err := fw.Write([]byte(content)); err != nil {
			t.Fatalf("zip write %s: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	path := filepath.Join(t.TempDir(), "in.zip")
	if err := os.WriteFile(path, buf.Bytes(), 0o600); err != nil {
		t.Fatalf("write zip: %v", err)
	}
	return path
}

func TestWorldPack_ImportRejectsZipSlip(t *testing.T) {
	ctx := context.Background()
	m, root := newTestManager(t)

	zipPath := makeZip(t, map[string]string{
		"manifest.json":           `{"format":"beacon-world/v1","world":{"name":"Злой","system":"dnd5e-2024"}}`,
		"world/../../../evil.txt": "pwned",
		"world/scenes/ok.json":    `{}`,
	})
	if _, err := m.ImportWorld(ctx, zipPath); err == nil {
		t.Fatal("ImportWorld принял архив с выходом за пределы каталога")
	}
	if _, err := os.Stat(filepath.Join(root, "evil.txt")); err == nil {
		t.Fatal("файл записан за пределами каталога мира")
	}
	// откат: осиротевшего мира в списке не осталось
	list, _ := m.companies.List(ctx)
	if len(list) != 0 {
		t.Fatalf("после сбоя импорта остался мир: %+v", list)
	}
}

func TestWorldPack_ImportRejectsBadManifest(t *testing.T) {
	ctx := context.Background()
	m, _ := newTestManager(t)

	cases := map[string]string{
		"чужой формат":  `{"format":"foundry/v11","world":{"name":"X","system":"dnd5e-2024"}}`,
		"нет системы":   `{"format":"beacon-world/v1","world":{"name":"X","system":"pathfinder"}}`,
		"нет названия":  `{"format":"beacon-world/v1","world":{"name":"","system":"dnd5e-2024"}}`,
		"нет манифеста": ``,
	}
	for name, manifest := range cases {
		t.Run(name, func(t *testing.T) {
			files := map[string]string{"world/scenes/ok.json": `{}`}
			if manifest != "" {
				files["manifest.json"] = manifest
			}
			_, err := m.ImportWorld(ctx, makeZip(t, files))
			var verr *domain.ValidationError
			if !errors.As(err, &verr) {
				t.Fatalf("ожидали *domain.ValidationError, получили %v", err)
			}
		})
	}
}
