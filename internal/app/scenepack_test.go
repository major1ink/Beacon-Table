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
	"beacon-table/internal/service"
)

func TestScenePackRoundTrip(t *testing.T) {
	ctx := context.Background()
	m, root := newTestManager(t)
	m.dice = service.NewDiceRoller()
	t.Cleanup(m.Shutdown)
	c, err := m.Create(ctx, "Мир", domain.SystemCustom)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Launch(ctx, c.ID); err != nil {
		t.Fatal(err)
	}
	_, uploadsRoot, uploadsURL := m.rootsFor(c)
	writeFile(t, filepath.Join(uploadsRoot, "maps", "1-карта.webp"), "map")
	writeFile(t, filepath.Join(root, "secret.txt"), "secret")

	s := domain.NewScene("src", "Склеп")
	s.MapURL = uploadsURL + "maps/1-карта.webp"
	s.GlobalLight = "dim"
	s.Building = "Башня"
	s.Tokens["t1"] = &domain.Token{ID: "t1", Label: "Вор", OwnerID: "acc", CharacterID: "ch", Image: uploadsURL + "tokens/2-нет.webp", Light: &domain.TokenLight{Bright: 20}}
	s.Tokens["t2"] = &domain.Token{ID: "t2", Label: "Утечка", Image: uploadsURL + "../../secret.txt"}
	s.Walls["w1"] = &domain.Wall{ID: "w1"}
	s.Teleports["a"] = &domain.Teleport{ID: "a", TargetTeleportID: "b"}
	s.Teleports["b"] = &domain.Teleport{ID: "b", TargetTeleportID: "a"}
	s.Teleports["c"] = &domain.Teleport{ID: "c", TargetSceneID: "other"}
	if _, err := m.Current().Room.ImportScenes(ctx, []*domain.SceneState{s}); err != nil {
		t.Fatal(err)
	}

	var buf bytes.Buffer
	if err := m.ExportScene(ctx, "src", "test", true, &buf); err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, f := range zr.File {
		names = append(names, f.Name)
	}
	if got := strings.Join(names, ","); got != "manifest.json,scene.json,uploads/maps/1-карта.webp" {
		t.Fatalf("состав архива: %s", got)
	}

	acc := &domain.Account{ID: "dm", Role: domain.AccountRoleAdmin}
	got, err := m.ImportScene(ctx, acc, bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatal(err)
	}
	if got.ID == "src" || got.Name != "Склеп" || got.GlobalLight != "dim" || got.Building != "" || len(got.Walls) != 1 {
		t.Fatalf("сцена: %+v", got)
	}
	if !strings.HasPrefix(got.MapURL, uploadsURL+"maps/") || !strings.HasSuffix(got.MapURL, "-карта.webp") || got.MapURL == s.MapURL {
		t.Fatalf("фон: %q", got.MapURL)
	}
	if b, err := os.ReadFile(filepath.Join(uploadsRoot, strings.TrimPrefix(got.MapURL, uploadsURL))); err != nil || string(b) != "map" {
		t.Fatalf("файл фона: %q %v", b, err)
	}
	for id, tok := range got.Tokens {
		if id == "t1" || id == "t2" || tok.OwnerID != "" || tok.CharacterID != "" || tok.Image != "" {
			t.Errorf("токен %s: %+v", id, tok)
		}
	}
	for id, tp := range got.Teleports {
		switch {
		case id == "a" || id == "b" || id == "c":
			t.Errorf("старый id портала %s", id)
		case tp.TargetSceneID != "":
			t.Errorf("портал на чужую сцену: %+v", tp)
		case tp.TargetTeleportID != "" && got.Teleports[tp.TargetTeleportID] == nil:
			t.Errorf("пара портала потерялась: %+v", tp)
		}
	}
}

func TestScenePackRejectsOtherZip(t *testing.T) {
	ctx := context.Background()
	m, _ := newTestManager(t)
	m.dice = service.NewDiceRoller()
	t.Cleanup(m.Shutdown)
	c, _ := m.Create(ctx, "Мир", domain.SystemCustom)
	if err := m.Launch(ctx, c.ID); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	fw, _ := zw.Create("scene.json")
	_, _ = fw.Write([]byte(`{}`))
	_ = zw.Close()
	_, err := m.ImportScene(ctx, &domain.Account{Role: domain.AccountRoleAdmin}, bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	var verr *domain.ValidationError
	if err == nil || !errors.As(err, &verr) {
		t.Fatalf("ожидалась ошибка формата: %v", err)
	}
}
