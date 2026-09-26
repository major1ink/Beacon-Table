package module

import (
	"errors"
	"strings"
	"testing"

	"beacon-table/internal/domain"
)

const sheetSchema = `{"format":"beacon-schema/v1","kind":"sheet",
 "fields":{"luck":{"type":"number","path":"luck","label":"Удача"}},
 "layout":[{"fields":["luck"]}]}`

func systemManifest(id string) string {
	return strings.Replace(manifestJSON(id, "1.0.0"), `"content"`, `"system"`, 1)
}

func TestInstallModuleWithSchemas(t *testing.T) {
	r := NewRegistry(t.TempDir(), nil, nil, "0.9.0")
	m, err := r.Install(makeArchive(t, map[string]string{
		"module.json":        systemManifest("luckworld"),
		"schemas/sheet.json": sheetSchema,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if m.Schemas["sheet"] == nil || len(m.Schemas) != 1 {
		t.Fatalf("схемы модуля: %v", m.Schemas)
	}
	// Перечитанный с диска модуль (как при запуске сервера) — те же схемы.
	got, err := r.Get("luckworld")
	if err != nil || got.Schemas["sheet"] == nil {
		t.Fatalf("после перечитывания: %v %v", err, got)
	}
}

func TestInstallRejectsBadSchemas(t *testing.T) {
	r := NewRegistry(t.TempDir(), nil, nil, "0.9.0")
	cases := map[string]map[string]string{
		"битая схема":        {"module.json": systemManifest("a"), "schemas/sheet.json": `{"format":"beacon-schema/v1","kind":"sheet","fields":{}}`},
		"не тот вид":         {"module.json": systemManifest("b"), "schemas/spell.json": sheetSchema},
		"незнакомое имя":     {"module.json": systemManifest("c"), "schemas/vehicle.json": sheetSchema},
		"схема у контента":   {"module.json": manifestJSON("d", "1.0.0"), "schemas/sheet.json": sheetSchema},
		"путь внутрь combat": {"module.json": systemManifest("e"), "schemas/sheet.json": strings.Replace(sheetSchema, `"path":"luck"`, `"path":"combat.luck"`, 1)},
	}
	for name, files := range cases {
		_, err := r.Install(makeArchive(t, files))
		var ve *domain.ValidationError
		if !errors.As(err, &ve) {
			t.Errorf("%s: ожидали ValidationError, получили %v", name, err)
		}
	}
	// Обновление, сломанное схемой, не трогает прежнюю версию.
	if _, err := r.Install(makeArchive(t, map[string]string{"module.json": systemManifest("keep"), "schemas/sheet.json": sheetSchema})); err != nil {
		t.Fatal(err)
	}
	broken := strings.Replace(systemManifest("keep"), `"1.0.0"`, `"1.1.0"`, 1)
	if _, err := r.Install(makeArchive(t, map[string]string{"module.json": broken, "schemas/sheet.json": "{"})); err == nil {
		t.Fatal("битая схема в обновлении должна отклоняться")
	}
	if m, err := r.Get("keep"); err != nil || m.Manifest.Version != "1.0.0" {
		t.Fatalf("прежняя версия должна остаться: %v %+v", err, m)
	}
}
