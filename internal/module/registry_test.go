package module

import (
	"archive/zip"
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"beacon-table/internal/domain"
)

func manifestJSON(id, version string, extra ...string) string {
	s := `{"format":"beacon-module/v1","id":"` + id + `","type":"content","title":"Тест ` + id + `","version":"` + version + `"`
	for _, e := range extra {
		s += "," + e
	}
	return s + "}"
}

func makeArchive(t *testing.T, files map[string]string) string {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(t.TempDir(), "m.btmod")
	if err := os.WriteFile(p, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestManifestValidate(t *testing.T) {
	cases := map[string]string{
		"нет формата":          `{"id":"a","type":"content","title":"A","version":"1.0.0"}`,
		"чужой формат":         `{"format":"beacon-module/v9","id":"a","type":"content","title":"A","version":"1.0.0"}`,
		"плохой id":            manifestJSON("Big_ID", "1.0.0"),
		"двойной дефис":        manifestJSON("a--b", "1.0.0"),
		"id sys":               manifestJSON("sys", "1.0.0"),
		"плохая версия":        manifestJSON("a", "1.0"),
		"плохой тип":           strings.Replace(manifestJSON("a", "1.0.0"), `"content"`, `"theme"`, 1),
		"плохая зависимость":   manifestJSON("a", "1.0.0", `"requires":[{"id":"B"}]`),
		"плохая minAppVersion": manifestJSON("a", "1.0.0", `"minAppVersion":"latest"`),
	}
	for name, raw := range cases {
		if _, err := ParseManifest([]byte(raw)); err == nil {
			t.Errorf("%s: ожидали ошибку", name)
		}
	}
	m, err := ParseManifest([]byte(manifestJSON("srd-extra", "v1.2.3-beta", `"requires":[{"id":"dnd5e-2024","minVersion":"1.0.0"}]`)))
	if err != nil {
		t.Fatal(err)
	}
	if m.IDPrefix() != "srd-extra--" {
		t.Fatalf("префикс id: %q", m.IDPrefix())
	}
	m.LegacyIDs = true
	if m.IDPrefix() != LegacyIDPrefix {
		t.Fatalf("legacy-префикс: %q", m.IDPrefix())
	}
}

func TestVersionCompare(t *testing.T) {
	a, _ := ParseVersion("0.9.0")
	b, _ := ParseVersion("0.10.0")
	if !a.Less(b) || b.Less(a) || a.Less(a) {
		t.Fatal("сравнение версий по числам, а не по строкам")
	}
}

func TestInstallBothLayoutsAndUpdate(t *testing.T) {
	root := t.TempDir()
	r := NewRegistry(root, nil, nil, "0.9.0")

	// module.json в корне архива.
	m, err := r.Install(makeArchive(t, map[string]string{
		"module.json":          manifestJSON("alpha", "1.0.0"),
		"bestiary/goblin.json": `{"name":"Гоблин"}`,
		"assets/goblin.webp":   "img",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if m.Source != SourceInstalled || m.Manifest.Version != "1.0.0" {
		t.Fatalf("установка: %+v", m.Manifest)
	}
	if b, err := fs.ReadFile(m.FS, "bestiary/goblin.json"); err != nil || !strings.Contains(string(b), "Гоблин") {
		t.Fatalf("карточка не распаковалась: %v", err)
	}

	// Обновление: архив с папкой верхнего уровня, в новой версии карточки нет.
	if _, err := r.Install(makeArchive(t, map[string]string{
		"alpha/module.json":        manifestJSON("alpha", "1.1.0"),
		"alpha/bestiary/wolf.json": `{"name":"Волк"}`,
	})); err != nil {
		t.Fatal(err)
	}
	got, err := r.Get("alpha")
	if err != nil || got.Manifest.Version != "1.1.0" {
		t.Fatalf("после обновления: %+v %v", got, err)
	}
	if _, err := fs.Stat(got.FS, "bestiary/goblin.json"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal("обновление должно заменять модуль целиком, а не дописывать поверх")
	}
	entries, _ := os.ReadDir(root)
	if len(entries) != 1 {
		t.Fatalf("после установки остался мусор: %v", entries)
	}
}

func TestInstallRejects(t *testing.T) {
	r := NewRegistry(t.TempDir(), nil, nil, "0.9.0")
	cases := map[string]map[string]string{
		"нет module.json": {"bestiary/x.json": "{}"},
		"zip slip":        {"module.json": manifestJSON("evil", "1.0.0"), "../../evil.txt": "x"},
		"слишком новый":   {"module.json": manifestJSON("future", "1.0.0", `"minAppVersion":"1.0.0"`)},
	}
	for name, files := range cases {
		_, err := r.Install(makeArchive(t, files))
		var ve *domain.ValidationError
		if !errors.As(err, &ve) {
			t.Errorf("%s: ожидали ValidationError, получили %v", name, err)
		}
	}
	if _, err := r.Get("evil"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatal("модуль с zip slip не должен установиться")
	}
	notZip := filepath.Join(t.TempDir(), "x.btmod")
	_ = os.WriteFile(notZip, []byte("not a zip"), 0o600)
	if _, err := r.Install(notZip); err == nil {
		t.Fatal("не-zip должен отклоняться")
	}
}

func TestSourcesPriorityAndRemove(t *testing.T) {
	root := t.TempDir()
	builtinMan, _ := ParseManifest([]byte(`{"format":"beacon-module/v1","id":"dnd","type":"system","title":"D&D","version":"0.0.1","legacyIds":true}`))
	fsys := fstest.MapFS{
		"systemdata/bestiary/dnd/goblin.json": {Data: []byte(`{"name":"Гоблин"}`)},
	}
	builtin := Builtin(fsys, "systemdata", "dnd", builtinMan)
	if builtin.ContentDir(KindBestiary) != "systemdata/bestiary/dnd" || builtin.AssetsDir() != "systemdata/assets/dnd" {
		t.Fatalf("раскладка встроенного: %s %s", builtin.ContentDir(KindBestiary), builtin.AssetsDir())
	}

	dev := t.TempDir()
	if err := os.WriteFile(filepath.Join(dev, "module.json"), []byte(strings.Replace(manifestJSON("dnd", "9.9.9"), `"content"`, `"system"`, 1)), 0o600); err != nil {
		t.Fatal(err)
	}
	r := NewRegistry(root, []*Module{builtin}, nil, "")
	if m, _ := r.Get("dnd"); m.Source != SourceBuiltin {
		t.Fatalf("без установки — встроенный: %s", m.Source)
	}
	if err := r.Remove("dnd"); err == nil {
		t.Fatal("встроенный модуль удалить нельзя")
	}
	if _, err := r.Install(makeArchive(t, map[string]string{"module.json": strings.Replace(manifestJSON("dnd", "1.0.0"), `"content"`, `"system"`, 1)})); err != nil {
		t.Fatal(err)
	}
	if m, _ := r.Get("dnd"); m.Source != SourceInstalled || m.Manifest.Version != "1.0.0" {
		t.Fatalf("установленный перекрывает встроенный: %s %s", m.Source, m.Manifest.Version)
	}
	rDev := NewRegistry(root, []*Module{builtin}, []string{dev}, "")
	if m, _ := rDev.Get("dnd"); m.Source != SourceDev || m.Manifest.Version != "9.9.9" {
		t.Fatalf("dev перекрывает установленный: %s %s", m.Source, m.Manifest.Version)
	}
	if err := r.Remove("dnd"); err != nil {
		t.Fatal(err)
	}
	if m, _ := r.Get("dnd"); m.Source != SourceBuiltin {
		t.Fatal("после удаления установленного снова виден встроенный")
	}
	if err := r.Remove("nope"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("удаление несуществующего: %v", err)
	}
	if err := r.Remove("../x"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("id с путём: %v", err)
	}
}

func TestBrokenModuleDoesNotHideOthers(t *testing.T) {
	root := t.TempDir()
	_ = os.MkdirAll(filepath.Join(root, "broken"), 0o750)
	_ = os.WriteFile(filepath.Join(root, "broken", "module.json"), []byte("{"), 0o600)
	_ = os.MkdirAll(filepath.Join(root, "ok"), 0o750)
	_ = os.WriteFile(filepath.Join(root, "ok", "module.json"), []byte(manifestJSON("ok", "1.0.0")), 0o600)
	all, err := NewRegistry(root, nil, nil, "").List()
	if err != nil || len(all) != 1 || all[0].Manifest.ID != "ok" {
		t.Fatalf("список: %v %v", all, err)
	}
}
