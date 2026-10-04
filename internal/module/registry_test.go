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
		"нет формата":            `{"id":"a","type":"content","title":"A","version":"1.0.0"}`,
		"чужой формат":           `{"format":"beacon-module/v9","id":"a","type":"content","title":"A","version":"1.0.0"}`,
		"плохой id":              manifestJSON("Big_ID", "1.0.0"),
		"двойной дефис":          manifestJSON("a--b", "1.0.0"),
		"id sys":                 manifestJSON("sys", "1.0.0"),
		"плохая версия":          manifestJSON("a", "1.0"),
		"плохой тип":             strings.Replace(manifestJSON("a", "1.0.0"), `"content"`, `"theme"`, 1),
		"плохая зависимость":     manifestJSON("a", "1.0.0", `"requires":[{"id":"B"}]`),
		"плохая minAppVersion":   manifestJSON("a", "1.0.0", `"minAppVersion":"latest"`),
		"правила боя у контента": manifestJSON("a", "1.0.0", `"combat":{"zeroHp":{"character":"out","other":"dead"}}`),
		"плохие правила боя": strings.Replace(manifestJSON("a", "1.0.0", `"combat":{"zeroHp":{"character":"deathSaves","other":"dead"}}`),
			`"content"`, `"system"`, 1),
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

func TestManifestCombatRules(t *testing.T) {
	raw := strings.Replace(manifestJSON("hack", "1.0.0",
		`"combat":{"initiative":{"roll":"2d6"},"zeroHp":{"character":"deathSaves","other":"out","deathSaves":{"success":2,"fail":4}},"xp":{"field":"xp"}}`),
		`"content"`, `"system"`, 1)
	m, err := ParseManifest([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if m.Combat == nil || m.Combat.Initiative.Roll != "2d6" || m.Combat.ZeroHP.DeathSaves.Fail != 4 {
		t.Fatalf("правила боя разобраны не так: %+v", m.Combat)
	}
}

func TestManifestModifierTargets(t *testing.T) {
	system := func(targets string) string {
		return strings.Replace(manifestJSON("sys-x", "1.0.0", `"modifierTargets":`+targets), `"content"`, `"system"`, 1)
	}
	bad := map[string]string{
		"у контента":  manifestJSON("a", "1.0.0", `"modifierTargets":[{"target":"luck","label":"Удача"}]`),
		"цель ядра":   system(`[{"target":"ac","label":"КД"}]`),
		"свободная":   system(`[{"target":"stat.сила","label":"Сила"}]`),
		"дважды":      system(`[{"target":"luck","label":"Удача"},{"target":"luck","label":"Удача"}]`),
		"без подписи": system(`[{"target":"luck","label":" "}]`),
		"кривая цель": system(`[{"target":"luck points","label":"Удача"}]`),
	}
	for name, raw := range bad {
		if _, err := ParseManifest([]byte(raw)); err == nil {
			t.Errorf("%s: ожидали ошибку", name)
		}
	}
	m, err := ParseManifest([]byte(system(`[{"target":"luck","label":"Удача","periodic":true}]`)))
	if err != nil {
		t.Fatal(err)
	}
	if got := m.ModifierTargets[0]; !got.System || got.Periodic {
		t.Fatalf("цель системы: System=%v Periodic=%v, ожидали true/false", got.System, got.Periodic)
	}
}

func TestManifestIgnoresOldImporters(t *testing.T) {
	raw := strings.Replace(manifestJSON("sys-x", "1.0.0", `"importers":["lss"]`), `"content"`, `"system"`, 1)
	if _, err := ParseManifest([]byte(raw)); err != nil {
		t.Fatalf("манифест со старым ключом importers: %v", err)
	}
}

func TestManifestUnitsAndCurrencies(t *testing.T) {
	system := func(extra string) string {
		return strings.Replace(manifestJSON("sys-x", "1.0.0", extra), `"content"`, `"system"`, 1)
	}
	bad := map[string]string{
		"у контента":          manifestJSON("a", "1.0.0", `"currencies":[{"key":"gp","label":"ЗМ"}]`),
		"единицы у контента":  manifestJSON("a", "1.0.0", `"units":{"weight":"кг"}`),
		"валюта дважды":       system(`"currencies":[{"key":"gp","label":"ЗМ"},{"key":"gp","label":"ЗМ"}]`),
		"кривой ключ":         system(`"currencies":[{"key":"Gold","label":"ЗМ"}]`),
		"броски у контента":   manifestJSON("a", "1.0.0", `"rolls":{"check":"1d20"}`),
		"проверка без куба":   system(`"rolls":{"check":"5"}`),
		"проверка со ссылкой": system(`"rolls":{"check":"1d20 + @dex"}`),
		"кривая проверка":     system(`"rolls":{"check":"1d20 +"}`),
	}
	for name, raw := range bad {
		if _, err := ParseManifest([]byte(raw)); err == nil {
			t.Errorf("%s: ожидали ошибку", name)
		}
	}
	m, err := ParseManifest([]byte(system(`"units":{"weight":" фнт "},"currencies":[{"key":"gp","label":"ЗМ","title":"золото"}]`)))
	if err != nil {
		t.Fatal(err)
	}
	if m.Units.Weight != "фнт" || len(m.Currencies) != 1 {
		t.Fatalf("разобрано: %+v %+v", m.Units, m.Currencies)
	}
	for _, check := range []string{" 2к6 ", "1d20+1", ""} {
		if _, err := ParseManifest([]byte(system(`"rolls":{"check":"` + check + `"}`))); err != nil {
			t.Errorf("куб проверки %q: %v", check, err)
		}
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
		"bestiary/goblin.json": {Data: []byte(`{"name":"Гоблин"}`)},
	}
	builtin := Builtin(fsys, builtinMan)

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

func TestInstallRejectsBadCards(t *testing.T) {
	cases := map[string]struct {
		files map[string]string
		want  string
	}{
		"не JSON":           {map[string]string{"bestiary/goblin.json": "{"}, "не JSON-объект"},
		"без имени":         {map[string]string{"bestiary/goblin.json": `{"name":" "}`}, "нет имени"},
		"с id":              {map[string]string{"spells/fire.json": `{"id":"x","name":"Огонь"}`}, `нет "id"`},
		"плохое имя файла":  {map[string]string{"items/Big Sword.json": `{"name":"Меч"}`}, "латиница"},
		"не .json":          {map[string]string{"items/sword.txt": "x"}, "файл .json"},
		"вложенная папка":   {map[string]string{"items/sub/sword.json": `{"name":"Меч"}`}, "вложенные папки"},
		"чужое состояние":   {map[string]string{"conditions/prone.json": `{"name":"Лежит","slug":"down"}`}, "slug состояния"},
		"чужая картинка":    {map[string]string{"bestiary/goblin.json": `{"name":"Гоблин","imageUrl":"/module-assets/other/g.webp"}`}, "чужой модуль"},
		"нет картинки":      {map[string]string{"bestiary/goblin.json": `{"name":"Гоблин","imageUrl":"/module-assets/bad/g.webp"}`}, "нет картинки assets/g.webp"},
		"длинный ключ":      {map[string]string{"bestiary/goblin.json": `{"name":"Гоблин","` + strings.Repeat("k", domain.MaxExtraKeyLen+1) + `":1}`}, "не поместится"},
		"неверный тип поля": {map[string]string{"bestiary/goblin.json": `{"name":["Гоблин"]}`}, "bestiary/goblin.json"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			r := NewRegistry(t.TempDir(), nil, nil, "0.9.0")
			if _, err := r.Install(makeArchive(t, map[string]string{"module.json": manifestJSON("bad", "1.0.0")})); err != nil {
				t.Fatal(err)
			}
			files := map[string]string{"module.json": manifestJSON("bad", "1.1.0")}
			for k, v := range tc.files {
				files[k] = v
			}
			_, err := r.Install(makeArchive(t, files))
			var ve *domain.ValidationError
			if !errors.As(err, &ve) || !strings.Contains(ve.Msg, tc.want) {
				t.Fatalf("ожидали ValidationError с %q, получили %v", tc.want, err)
			}
			if m, _ := r.Get("bad"); m == nil || m.Manifest.Version != "1.0.0" {
				t.Fatal("прежняя версия модуля должна остаться")
			}
		})
	}
}

func TestInstallReportsFirstErrors(t *testing.T) {
	files := map[string]string{"module.json": manifestJSON("many", "1.0.0")}
	for i := range 8 {
		files["bestiary/m"+strings.Repeat("a", i+1)+".json"] = `{}`
	}
	_, err := NewRegistry(t.TempDir(), nil, nil, "").Install(makeArchive(t, files))
	if err == nil || !strings.Contains(err.Error(), "и ещё 3") {
		t.Fatalf("ожидали 5 ошибок и «и ещё 3»: %v", err)
	}
}

func TestInstallWarningsDoNotBlock(t *testing.T) {
	_, err := NewRegistry(t.TempDir(), nil, nil, "").Install(makeArchive(t, map[string]string{
		"module.json":          manifestJSON("warn", "1.0.0"),
		"bestiary/goblin.json": `{"name":"Гоблин","imageUrl":"https://example.com/g.webp"}`,
		"assets/unused.webp":   "img",
	}))
	if err != nil {
		t.Fatal(err)
	}
}

func TestInstallRequires(t *testing.T) {
	system := func(version string) string {
		return strings.Replace(manifestJSON("rules", version), `"content"`, `"system"`, 1)
	}
	content := makeArchive(t, map[string]string{
		"module.json": manifestJSON("srd", "1.0.0", `"systems":["rules"]`, `"requires":[{"id":"rules","minVersion":"1.2.0"}]`),
	})
	r := NewRegistry(t.TempDir(), nil, nil, "")
	steps := []struct {
		system string
		want   string
	}{
		{"", "нужен модуль rules (не ниже 1.2.0) — сначала установи"},
		{"1.1.0", "не ниже 1.2.0, а установлен 1.1.0"},
		{"1.2.0", ""},
	}
	for _, s := range steps {
		if s.system != "" {
			if _, err := r.Install(makeArchive(t, map[string]string{"module.json": system(s.system)})); err != nil {
				t.Fatal(err)
			}
		}
		_, err := r.Install(content)
		var ve *domain.ValidationError
		switch {
		case s.want == "" && err != nil:
			t.Fatalf("система %s: %v", s.system, err)
		case s.want != "" && (!errors.As(err, &ve) || !strings.Contains(ve.Msg, s.want)):
			t.Fatalf("система %q: ожидали %q, получили %v", s.system, s.want, err)
		}
	}
	if _, err := r.Get("srd"); err != nil {
		t.Fatal("контент должен встать после системы")
	}
}

func themedSystem(theme string) string {
	return strings.Replace(manifestJSON("themed", "1.0.0", `"theme":`+theme), `"content"`, `"system"`, 1)
}

func TestManifestTheme(t *testing.T) {
	for name, raw := range map[string]string{
		"у контента":        manifestJSON("a", "1.0.0", `"theme":{"vars":{"accent":"#fff"}}`),
		"чужая переменная":  themedSystem(`{"vars":{"width":"1px"}}`),
		"лишнее поле theme": themedSystem(`{"script":"a.js"}`),
	} {
		if _, err := ParseManifest([]byte(raw)); err == nil {
			t.Errorf("%s: ожидали ошибку", name)
		}
	}
	if _, err := ParseManifest([]byte(themedSystem(`{"vars":{"accent":"#a83a32"}}`))); err != nil {
		t.Fatal(err)
	}
}

func TestInstallTheme(t *testing.T) {
	reg := NewRegistry(t.TempDir(), nil, nil, "0.9.0")
	theme := `{"vars":{"accent":"#a83a32"},"fonts":[{"family":"Title","file":"fonts/t.woff2"}],"styles":["theme/sheet.css"]}`
	good := map[string]string{
		"module.json":          themedSystem(theme),
		"assets/fonts/t.woff2": "font",
		"theme/sheet.css":      ".stat-table th { color: #c9a227 }",
	}
	m, err := reg.Install(makeArchive(t, good))
	if err != nil {
		t.Fatal(err)
	}
	css, err := m.ThemeCSS()
	if err != nil || !strings.Contains(css, "--accent:#a83a32") || !strings.Contains(css, ".card-root .stat-table th") || !strings.Contains(css, "/module-assets/themed/fonts/t.woff2") {
		t.Fatalf("CSS темы: %q %v", css, err)
	}
	for name, patch := range map[string]map[string]string{
		"нет шрифта":  {"assets/fonts/t.woff2": ""},
		"плохой CSS":  {"theme/sheet.css": "@import url(x.css);"},
		"внешний url": {"theme/sheet.css": `.a { background: url(https://example.com/x.png) }`},
	} {
		files := map[string]string{}
		for k, v := range good {
			files[k] = v
		}
		for k, v := range patch {
			if v == "" {
				delete(files, k)
			} else {
				files[k] = v
			}
		}
		other := NewRegistry(t.TempDir(), nil, nil, "0.9.0")
		if _, err := other.Install(makeArchive(t, files)); err == nil {
			t.Errorf("%s: ожидали отказ", name)
		}
	}
}
