package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"beacon-table/internal/module"
)

// TestExportModuleManifests пишет module.json модулей D&D для репозитория
// модулей из встроенных манифестов (builtinModules): система отдельно от
// контента. Разовый инструмент переноса — запускается только с
// BEACON_EXPORT_MODULES=<папка modules/ репозитория модулей>; после выноса D&D
// из бинарника исчезает вместе с builtinModules.
func TestExportModuleManifests(t *testing.T) {
	out := os.Getenv("BEACON_EXPORT_MODULES")
	if out == "" {
		t.Skip("BEACON_EXPORT_MODULES не задан")
	}
	const minApp = "0.9.0"
	var manifests []*module.Manifest
	for _, m := range builtinModules(systemFiles) {
		man := *m.Manifest
		man.MinAppVersion = minApp
		man.License = "CC-BY-4.0"
		switch man.ID {
		case "dnd5e-2014":
			man.Description = "Система D&D 5e (редакция 2014): лист персонажа, карточки существа, заклинания, предмета и справочника, правила боя (инициатива, спасброски от смерти, опыт по уровню опасности), монеты и вес, состояния SRD 5.1."
		case "dnd5e-2024":
			man.Description = "Система D&D 5e (редакция 2024): лист персонажа, карточки существа, заклинания, предмета и справочника, правила боя (инициатива, спасброски от смерти, опыт по уровню опасности), монеты и вес, состояния SRD 5.2."
		}
		manifests = append(manifests, &man)
	}
	manifests = append(manifests, &module.Manifest{
		Format:        module.Format,
		ID:            "dnd5e-2024-srd",
		Type:          module.TypeContent,
		Title:         "D&D 5e (2024) — SRD 5.2",
		Version:       "1.0.0",
		MinAppVersion: minApp,
		Systems:       []string{"dnd5e-2024"},
		Requires:      []module.Dependency{{ID: "dnd5e-2024", MinVersion: "1.0.0"}},
		Description:   "Каталог SRD 5.2 для D&D 5e 2024: существа, заклинания, предметы и справочник (классы, архетипы, виды, предыстории, черты).",
		License:       "CC-BY-4.0",
		LegacyIDs:     true,
	})
	for _, man := range manifests {
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		enc.SetEscapeHTML(false)
		enc.SetIndent("", "  ")
		if err := enc.Encode(man); err != nil {
			t.Fatal(err)
		}
		if _, err := module.ParseManifest(buf.Bytes()); err != nil {
			t.Fatalf("%s: %v", man.ID, err)
		}
		dir := filepath.Join(out, man.ID)
		if err := os.MkdirAll(dir, 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "module.json"), buf.Bytes(), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}
