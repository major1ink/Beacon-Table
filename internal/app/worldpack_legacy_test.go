package app

// Страховка переноса миров через вынос D&D в модули (задача «Импорты при
// переходе на модули»). testdata/world-v0.8.6.zip — архив мира в формате
// нынешней версии: заполнены все поля всего, что едет в архив (библиотеки,
// сцены с токенами на карточках каталога «из коробки», бой, лут, журнал,
// доска, аккаунты, персонажи с листом и инвентарём, прегены, плейлисты,
// загрузки). Любая будущая версия обязана импортировать его так, что мир
// совпадёт с testdata/world-v0.8.6.expected.json.
//
// Пересобрать оба файла (только осознанно — это эталон старого формата):
//
//	UPDATE_GOLDEN=1 go test ./internal/app -run LegacyArchive

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository/sqlite"
	"beacon-table/internal/testutil"
)

const (
	legacyArchive  = "testdata/world-v0.8.6.zip"
	legacyExpected = "testdata/world-v0.8.6.expected.json"
)

// filledSheet — лист, где заполнено каждое поле (спасброски — на все шесть
// характеристик, как в настоящем листе, см. sqlite.decodeSheet).
func filledSheet() domain.CharacterSheet {
	var sheet domain.CharacterSheet
	testutil.Fill(&sheet)
	sheet.SaveProf = map[string]bool{"str": true, "dex": false, "con": true, "int": false, "wis": true, "cha": false}
	return sheet
}

func writeJSON(t *testing.T, path string, v any) {
	t.Helper()
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, path, string(b))
}

// seedLegacyWorld — мир, каким его сохраняет 0.8.6, со ссылками на каталог
// «из коробки» D&D (sys-…) там, где их ставит приложение: токен и боец на
// монстра каталога, строка инвентаря и лута на предмет каталога, наложенное
// состояние по slug'у каталога.
func seedLegacyWorld(t *testing.T, m *CompanyManager) *domain.Company {
	t.Helper()
	ctx := context.Background()
	c, err := m.Create(ctx, "Мир 0.8.6", domain.SystemDnD5e2024)
	if err != nil {
		t.Fatal(err)
	}
	data, uploads, url := m.rootsFor(c)

	// Библиотеки мира — по карточке каждого вида, все поля заполнены.
	var mon domain.Monster
	testutil.Fill(&mon)
	mon.ID, mon.ImageURL = "lib-monster", url+"tokens/monster.webp"
	mon.Spells[0].SpellID = "sys-ognennyi-snaryad-fire-bolt"
	mon.Inventory[0].ItemID = "sys-dlinnyi-mech-longsword"
	writeJSON(t, filepath.Join(data, "bestiary", "bestiary", mon.ID+".json"), mon)
	var sp domain.Spell
	testutil.Fill(&sp)
	sp.ID = "lib-spell"
	sp.Statuses[0].Slug = "paralyzed"
	writeJSON(t, filepath.Join(data, "spells", "spells", sp.ID+".json"), sp)
	var it domain.Item
	testutil.Fill(&it)
	it.ID, it.ImageURL = "lib-item", url+"items/item.webp"
	writeJSON(t, filepath.Join(data, "items", "items", it.ID+".json"), it)
	var ref domain.Reference
	testutil.Fill(&ref)
	ref.ID = "lib-reference"
	writeJSON(t, filepath.Join(data, "references", "references", ref.ID+".json"), ref)
	var cond domain.Condition
	testutil.Fill(&cond)
	cond.ID, cond.Slug = "lib-condition", "c-lib-condition"
	writeJSON(t, filepath.Join(data, "conditions", "conditions", cond.ID+".json"), cond)

	// Сцена: все поля, плюс токен на монстра каталога с наложенным
	// состоянием каталога и лутом из предмета каталога.
	var scene domain.SceneState
	testutil.Fill(&scene)
	scene.ID, scene.MapURL = "scene-1", url+"maps/map.webp"
	for _, tok := range scene.Tokens {
		tok.MonsterID = "sys-goblin-voitel-goblin-warrior"
		tok.CharacterID, tok.OwnerID = "char-1", "acc-player"
		tok.Statuses[0].Slug = "prone"
		tok.Loot[0].ItemID = "sys-dlinnyi-mech-longsword"
	}
	writeJSON(t, filepath.Join(data, "scenes", "scenes", "scene-1.json"), scene)
	var combat domain.CombatState
	testutil.Fill(&combat)
	for _, cmb := range combat.Combatants {
		cmb.MonsterID = "sys-goblin-voitel-goblin-warrior"
		cmb.CharacterID, cmb.OwnerID = "char-1", "acc-player"
	}
	writeJSON(t, filepath.Join(data, "scenes", "combat.json"), combat)
	var hub domain.LootHub
	testutil.Fill(&hub)
	writeJSON(t, filepath.Join(data, "scenes", "hub.json"), hub)

	writeFile(t, filepath.Join(data, "journal", "Глава 1", "e1.md"),
		"---\nowner: acc-player\nownerName: Гвен\ndefault: observer\naccess:\n  acc-player: owner\n---\n# Таверна\n\n![карта]("+url+"maps/map.webp)\n\n[[Гоблин-воитель]]\n")
	writeFile(t, filepath.Join(data, "boards", "b1.md"),
		"---\nexcalidraw-plugin: parsed\ntags: [excalidraw]\nname: Схема\nowner: acc-player\nownerName: Гвен\ndefault: observer\naccess:\n  acc-player: owner\n---\n# Excalidraw Data\n")
	for _, f := range []string{"maps/map.webp", "tokens/monster.webp", "items/item.webp", "audio/battle.mp3"} {
		writeFile(t, filepath.Join(uploads, filepath.FromSlash(f)), "DATA-"+f)
	}

	// База: аккаунты, персонаж с полным листом и инвентарём, преген, плейлист.
	for _, a := range []*domain.Account{
		{ID: "acc-player", Username: "gwen", PasswordHash: "hash-gwen", Role: domain.AccountRolePlayer, Status: domain.AccountStatusActive, CompanyID: c.ID},
		{ID: "acc-dm", Username: "dm", PasswordHash: "hash-dm", Role: domain.AccountRoleAdmin, Status: domain.AccountStatusActive},
	} {
		if err := m.accounts.Create(ctx, a); err != nil {
			t.Fatal(err)
		}
	}
	chars := sqlite.NewCharacterStore(m.db, c.ID, c.System)
	if err := chars.Create(ctx, &domain.Character{ID: "char-1", AccountID: "acc-player", Name: "Гвен", AvatarURL: url + "tokens/monster.webp"}); err != nil {
		t.Fatal(err)
	}
	if ok, err := chars.UpdateSheet(ctx, "char-1", "acc-player", filledSheet()); err != nil || !ok {
		t.Fatalf("лист: ok=%v err=%v", ok, err)
	}
	var entry domain.InventoryEntry
	testutil.Fill(&entry)
	entry.ID, entry.ItemID, entry.Equipped = "inv-1", "sys-dlinnyi-mech-longsword", false
	if _, err := chars.AddInventoryEntry(ctx, "char-1", "acc-player", entry); err != nil {
		t.Fatal(err)
	}
	pregen := &domain.Pregen{ID: "pg-1", Name: "Пробный персонаж", AvatarURL: url + "tokens/monster.webp", Source: "ag-goblin-trouble", Sheet: filledSheet()}
	if err := sqlite.NewPregenStore(m.db, c.ID).Create(ctx, pregen); err != nil {
		t.Fatal(err)
	}
	pls := sqlite.NewPlaylistStore(m.db, c.ID)
	if err := pls.Create(ctx, "pl-1", "Бой", domain.PlaylistKindSFX); err != nil {
		t.Fatal(err)
	}
	if err := pls.AddTrack(ctx, "tr-1", "pl-1", url+"audio/battle.mp3", "Драка", 0.7, true); err != nil {
		t.Fatal(err)
	}
	return c
}

// dumpWorld — всё, что есть у мира после импорта, в одном сравнимом JSON:
// файлы под dataRoot (JSON — разобранным, остальное — текстом), загрузки,
// аккаунты, персонажи с инвентарём, прегены, плейлисты. Id мира и адрес
// его загрузок заменены метками, а id прегенов и плейлистов не сравниваются —
// импорт выдаёт их заново.
func dumpWorld(t *testing.T, m *CompanyManager, c *domain.Company) map[string]any {
	t.Helper()
	ctx := context.Background()
	data, uploads, url := m.rootsFor(c)
	norm := func(s string) string {
		return strings.ReplaceAll(strings.ReplaceAll(s, url, "<uploads>/"), c.ID, "<world>")
	}
	files := map[string]any{}
	err := filepath.WalkDir(data, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(data, path)
		b, err := os.ReadFile(path) //nolint:gosec // обход своего каталога
		if err != nil {
			return err
		}
		text := norm(string(b))
		var parsed any
		if strings.HasSuffix(path, ".json") && json.Unmarshal([]byte(text), &parsed) == nil {
			files[filepath.ToSlash(rel)] = parsed
		} else {
			files[filepath.ToSlash(rel)] = text
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	up := map[string]any{}
	_ = filepath.WalkDir(uploads, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(uploads, path)
		b, _ := os.ReadFile(path) //nolint:gosec // обход своего каталога
		up[filepath.ToSlash(rel)] = string(b)
		return nil
	})

	accs, err := m.accounts.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var accounts []map[string]any
	for _, a := range accs {
		accounts = append(accounts, map[string]any{
			"id": a.ID, "username": a.Username, "passwordHash": a.PasswordHash,
			"role": a.Role, "status": a.Status, "companyId": norm(a.CompanyID),
		})
	}
	sort.Slice(accounts, func(i, j int) bool { return fmt.Sprint(accounts[i]["id"]) < fmt.Sprint(accounts[j]["id"]) })

	chars := sqlite.NewCharacterStore(m.db, c.ID, c.System)
	all, err := chars.All(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var characters []map[string]any
	for _, ch := range all {
		inv, err := chars.ListInventory(ctx, ch.ID)
		if err != nil {
			t.Fatal(err)
		}
		characters = append(characters, map[string]any{
			"id": ch.ID, "accountId": ch.AccountID, "name": ch.Name, "system": ch.System,
			"avatarUrl": norm(ch.AvatarURL), "sheet": ch.Sheet, "inventory": inv,
		})
	}
	pregens, err := sqlite.NewPregenStore(m.db, c.ID).List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var pgs []map[string]any
	for _, p := range pregens {
		pgs = append(pgs, map[string]any{"name": p.Name, "avatarUrl": norm(p.AvatarURL), "source": p.Source, "sheet": p.Sheet})
	}
	playlists, err := sqlite.NewPlaylistStore(m.db, c.ID).List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var pls []map[string]any
	for _, p := range playlists {
		var tracks []map[string]any
		for _, tr := range p.Tracks {
			tracks = append(tracks, map[string]any{"url": norm(tr.URL), "name": tr.Name, "volume": tr.Volume, "loop": tr.Loop})
		}
		pls = append(pls, map[string]any{"name": p.Name, "kind": p.Kind, "tracks": tracks})
	}

	out := map[string]any{
		"world":      map[string]any{"name": c.Name, "system": c.System},
		"files":      files,
		"uploads":    up,
		"accounts":   accounts,
		"characters": characters,
		"pregens":    pgs,
		"playlists":  pls,
	}
	// Через JSON — чтобы сравнивать ровно то, что записано бы в эталон.
	b, _ := json.Marshal(out)
	var generic map[string]any
	_ = json.Unmarshal(b, &generic)
	return generic
}

func TestWorldPack_LegacyArchive(t *testing.T) {
	ctx := context.Background()
	if os.Getenv("UPDATE_GOLDEN") != "" {
		srcM, _ := newTestManager(t)
		src := seedLegacyWorld(t, srcM)
		var buf bytes.Buffer
		if err := srcM.ExportWorld(ctx, src.ID, "0.8.6", true, &buf); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll("testdata", 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(legacyArchive, buf.Bytes(), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	dstM, _ := newTestManager(t)
	res, err := dstM.ImportWorld(ctx, legacyArchive)
	if err != nil {
		t.Fatalf("архив 0.8.6 не импортируется: %v", err)
	}
	got := dumpWorld(t, dstM, res.Company)

	if os.Getenv("UPDATE_GOLDEN") != "" {
		b, _ := json.MarshalIndent(got, "", " ")
		if err := os.WriteFile(legacyExpected, append(b, '\n'), 0o600); err != nil {
			t.Fatal(err)
		}
		return
	}
	raw, err := os.ReadFile(legacyExpected)
	if err != nil {
		t.Fatalf("нет эталона: %v", err)
	}
	var want map[string]any
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	if diffs := testutil.JSONDiff(want, got); len(diffs) > 0 {
		t.Fatalf("мир из архива 0.8.6 разошёлся с эталоном:\n%s", strings.Join(diffs, "\n"))
	}
}
