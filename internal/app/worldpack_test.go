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
		accounts:    sqlite.NewAccountStore(db),
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

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path) //nolint:gosec // тестовый путь
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}

func exportToZip(t *testing.T, m *CompanyManager, companyID string, withAccounts bool) string {
	t.Helper()
	var buf bytes.Buffer
	if err := m.ExportWorld(context.Background(), companyID, "test", withAccounts, &buf); err != nil {
		t.Fatalf("ExportWorld: %v", err)
	}
	path := filepath.Join(t.TempDir(), "w.zip")
	if err := os.WriteFile(path, buf.Bytes(), 0o600); err != nil {
		t.Fatalf("write zip: %v", err)
	}
	return path
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

// seedWorldContent раскладывает сцену (токен с владельцем), combat.json,
// запись журнала с шапкой, карточку бестиария, загрузки, плейлист, преген.
func seedWorldContent(t *testing.T, m *CompanyManager, c *domain.Company, ownerAcc, ownerChar string) {
	t.Helper()
	ctx := context.Background()
	data, uploads, url := m.rootsFor(c)

	writeFile(t, filepath.Join(data, "scenes", "scenes", "scene-1.json"),
		`{"id":"scene-1","mapUrl":"`+url+`maps/map.png","tokens":{"t1":{"id":"t1","label":"Гвен","ownerId":"`+ownerAcc+`","characterId":"`+ownerChar+`"},"t2":{"id":"t2","label":"Гоблин","monsterId":"m1"}}}`)
	writeFile(t, filepath.Join(data, "scenes", "combat.json"),
		`{"active":false,"round":0,"combatants":{"c1":{"id":"c1","name":"Гвен","ownerId":"`+ownerAcc+`","characterId":"`+ownerChar+`"}}}`)
	writeFile(t, filepath.Join(data, "journal", "Глава 1", "e1.md"),
		"---\nowner: "+ownerAcc+"\nownerName: Гвен\ndefault: observer\naccess:\n  "+ownerAcc+": owner\n---\n# Таверна\n\n![map]("+url+"maps/map.png)\n")
	writeFile(t, filepath.Join(data, "boards", "b1.md"),
		"---\nexcalidraw-plugin: parsed\ntags: [excalidraw]\nname: Схема\nowner: "+ownerAcc+"\nownerName: Гвен\ndefault: observer\naccess:\n  "+ownerAcc+": owner\n---\n# Excalidraw Data\n")
	writeFile(t, filepath.Join(data, "bestiary", "bestiary", "m1.json"),
		`{"id":"m1","name":"Гоблин","imageUrl":"`+url+`tokens/g.png"}`)
	writeFile(t, filepath.Join(uploads, "maps", "map.png"), "PNGDATA-map")
	writeFile(t, filepath.Join(uploads, "tokens", "g.png"), "PNGDATA-goblin")

	ps := sqlite.NewPlaylistStore(m.db, c.ID)
	if err := ps.Create(ctx, "pl-1", "Бой"); err != nil {
		t.Fatalf("playlist: %v", err)
	}
	if err := ps.AddTrack(ctx, "tr-1", "pl-1", url+"audio/x.mp3", "Драка", 0.7, true); err != nil {
		t.Fatalf("track: %v", err)
	}
	if err := sqlite.NewPregenStore(m.db, c.ID).Create(ctx, &domain.Pregen{ID: "pg-1", Name: "Аня", AvatarURL: url + "tokens/anya.png"}); err != nil {
		t.Fatalf("pregen: %v", err)
	}
}

func TestWorldPack_RoundTrip_ContentOnly(t *testing.T) {
	ctx := context.Background()
	srcM, _ := newTestManager(t)
	dstM, _ := newTestManager(t)

	src, err := srcM.Create(ctx, "Демо-мир", domain.SystemDnD5e2024)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	seedWorldContent(t, srcM, src, "acc-123", "char-9")

	res, err := dstM.ImportWorld(ctx, exportToZip(t, srcM, src.ID, false))
	if err != nil {
		t.Fatalf("ImportWorld: %v", err)
	}
	dst := res.Company
	if dst.Name != "Демо-мир" || dst.System != domain.SystemDnD5e2024 {
		t.Fatalf("метаданные мира: %+v", dst)
	}
	dstData, dstUploads, dstURL := dstM.rootsFor(dst)

	scene := readFile(t, filepath.Join(dstData, "scenes", "scenes", "scene-1.json"))
	if strings.Contains(scene, "acc-123") || strings.Contains(scene, "char-9") || strings.Contains(scene, `"ownerId"`) || strings.Contains(scene, `"characterId"`) {
		t.Fatalf("владелец токена не обнулён: %s", scene)
	}
	if !strings.Contains(scene, `"monsterId"`) || !strings.Contains(scene, `"m1"`) || !strings.Contains(scene, dstURL+"maps/map.png") {
		t.Fatalf("сцена потеряла данные / URL: %s", scene)
	}
	combat := readFile(t, filepath.Join(dstData, "scenes", "combat.json"))
	if strings.Contains(combat, "acc-123") || strings.Contains(combat, `"ownerId"`) {
		t.Fatalf("владелец combatant не обнулён: %s", combat)
	}
	journal := readFile(t, filepath.Join(dstData, "journal", "Глава 1", "e1.md"))
	if strings.Contains(journal, "owner:") || strings.Contains(journal, "acc-123") {
		t.Fatalf("привязка к аккаунту осталась в журнале: %s", journal)
	}
	if !strings.Contains(journal, "default: observer") || !strings.Contains(journal, dstURL+"maps/map.png") {
		t.Fatalf("журнал: видимость/URL: %s", journal)
	}
	board := readFile(t, filepath.Join(dstData, "boards", "b1.md"))
	if strings.Contains(board, "owner:") || strings.Contains(board, "acc-123") {
		t.Fatalf("привязка к аккаунту осталась в доске: %s", board)
	}
	// Ключи плагина и название обязаны пережить чистку, иначе файл перестанет
	// быть доской Excalidraw.
	for _, want := range []string{"excalidraw-plugin: parsed", "tags: [excalidraw]", "name: Схема", "default: observer"} {
		if !strings.Contains(board, want) {
			t.Fatalf("доска потеряла %q: %s", want, board)
		}
	}
	monster := readFile(t, filepath.Join(dstData, "bestiary", "bestiary", "m1.json"))
	if !strings.Contains(monster, dstURL+"tokens/g.png") {
		t.Fatalf("URL карточки бестиария: %s", monster)
	}
	if got := readFile(t, filepath.Join(dstUploads, "maps", "map.png")); got != "PNGDATA-map" {
		t.Fatalf("загрузка не перенесена дословно: %q", got)
	}
	pls, err := sqlite.NewPlaylistStore(dstM.db, dst.ID).List(ctx)
	if err != nil || len(pls) != 1 || len(pls[0].Tracks) != 1 || pls[0].Tracks[0].URL != dstURL+"audio/x.mp3" {
		t.Fatalf("плейлист: %+v (err %v)", pls, err)
	}
	pgs, err := sqlite.NewPregenStore(dstM.db, dst.ID).List(ctx)
	if err != nil || len(pgs) != 1 || pgs[0].AvatarURL != dstURL+"tokens/anya.png" {
		t.Fatalf("преген: %+v (err %v)", pgs, err)
	}
	if accs, _ := dstM.accounts.List(ctx); len(accs) != 0 {
		t.Fatalf("в content-only мир просочились аккаунты: %+v", accs)
	}
}

func TestWorldPack_RoundTrip_WithAccounts(t *testing.T) {
	ctx := context.Background()
	srcM, _ := newTestManager(t)
	dstM, _ := newTestManager(t)

	src, err := srcM.Create(ctx, "Кампания", domain.SystemDnD5e2024)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := srcM.accounts.Create(ctx, &domain.Account{
		ID: "acc-gwen", Username: "gwen", PasswordHash: "hash-gwen",
		Role: domain.AccountRolePlayer, Status: domain.AccountStatusActive, CompanyID: src.ID,
	}); err != nil {
		t.Fatalf("account: %v", err)
	}
	// аккаунт ДМ (глобальный) — должен приехать как admin с CompanyID == ""
	if err := srcM.accounts.Create(ctx, &domain.Account{
		ID: "acc-dm", Username: "demo-dm", PasswordHash: "hash-dm",
		Role: domain.AccountRoleAdmin, Status: domain.AccountStatusActive,
	}); err != nil {
		t.Fatalf("dm account: %v", err)
	}
	cstore := sqlite.NewCharacterStore(srcM.db, src.ID, src.System)
	if err := cstore.Create(ctx, &domain.Character{ID: "char-gwen", AccountID: "acc-gwen", Name: "Гвен"}); err != nil {
		t.Fatalf("character: %v", err)
	}
	if _, err := cstore.AddInventoryEntry(ctx, "char-gwen", "acc-gwen", domain.InventoryEntry{ID: "inv-1", Name: "Меч", Quantity: 1}); err != nil {
		t.Fatalf("inventory: %v", err)
	}
	seedWorldContent(t, srcM, src, "acc-gwen", "char-gwen")

	res, err := dstM.ImportWorld(ctx, exportToZip(t, srcM, src.ID, true))
	if err != nil {
		t.Fatalf("ImportWorld: %v", err)
	}
	if len(res.RenamedLogins) != 0 {
		t.Fatalf("неожиданные переименования: %v", res.RenamedLogins)
	}
	dst := res.Company

	acc, err := dstM.accounts.ByID(ctx, "acc-gwen")
	if err != nil {
		t.Fatalf("аккаунт не перенесён: %v", err)
	}
	if acc.CompanyID != dst.ID || acc.PasswordHash != "hash-gwen" || acc.Role != domain.AccountRolePlayer {
		t.Fatalf("аккаунт игрока: %+v", acc)
	}
	dm, err := dstM.accounts.ByID(ctx, "acc-dm")
	if err != nil {
		t.Fatalf("аккаунт ДМ не перенесён: %v", err)
	}
	if dm.Role != domain.AccountRoleAdmin || dm.CompanyID != "" || dm.PasswordHash != "hash-dm" {
		t.Fatalf("аккаунт ДМ: %+v (ожидали admin, CompanyID пустой)", dm)
	}
	dcstore := sqlite.NewCharacterStore(dstM.db, dst.ID, dst.System)
	ch, err := dcstore.ByID(ctx, "char-gwen")
	if err != nil || ch.AccountID != "acc-gwen" || ch.Name != "Гвен" {
		t.Fatalf("персонаж: %+v (err %v)", ch, err)
	}
	inv, err := dcstore.ListInventory(ctx, "char-gwen")
	if err != nil || len(inv) != 1 || inv[0].Name != "Меч" {
		t.Fatalf("инвентарь: %+v (err %v)", inv, err)
	}
	dstData, _, _ := dstM.rootsFor(dst)
	scene := readFile(t, filepath.Join(dstData, "scenes", "scenes", "scene-1.json"))
	if !strings.Contains(scene, `"ownerId":"acc-gwen"`) || !strings.Contains(scene, `"characterId":"char-gwen"`) {
		t.Fatalf("владелец токена потерян при переносе с аккаунтами: %s", scene)
	}
	journal := readFile(t, filepath.Join(dstData, "journal", "Глава 1", "e1.md"))
	if !strings.Contains(journal, "owner: acc-gwen") || !strings.Contains(journal, "acc-gwen: owner") {
		t.Fatalf("шапка журнала не сохранена при переносе с аккаунтами: %s", journal)
	}
	board := readFile(t, filepath.Join(dstData, "boards", "b1.md"))
	if !strings.Contains(board, "owner: acc-gwen") || !strings.Contains(board, "acc-gwen: owner") {
		t.Fatalf("шапка доски не сохранена при переносе с аккаунтами: %s", board)
	}
}

func TestWorldPack_ImportRenamesLoginCollision(t *testing.T) {
	ctx := context.Background()
	srcM, _ := newTestManager(t)
	dstM, _ := newTestManager(t)

	src, err := srcM.Create(ctx, "Кампания", domain.SystemDnD5e2024)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := srcM.accounts.Create(ctx, &domain.Account{
		ID: "acc-src", Username: "gandalf", PasswordHash: "h",
		Role: domain.AccountRolePlayer, Status: domain.AccountStatusActive, CompanyID: src.ID,
	}); err != nil {
		t.Fatalf("src account: %v", err)
	}
	if err := sqlite.NewCharacterStore(srcM.db, src.ID, src.System).Create(ctx, &domain.Character{ID: "char-src", AccountID: "acc-src", Name: "Гэндальф"}); err != nil {
		t.Fatalf("src char: %v", err)
	}
	zipPath := exportToZip(t, srcM, src.ID, true)

	// на целевом сервере уже занят логин "gandalf"
	other, _ := dstM.Create(ctx, "Другой мир", domain.SystemDnD5e2024)
	if err := dstM.accounts.Create(ctx, &domain.Account{
		ID: "acc-other", Username: "gandalf", PasswordHash: "h2",
		Role: domain.AccountRolePlayer, Status: domain.AccountStatusActive, CompanyID: other.ID,
	}); err != nil {
		t.Fatalf("other account: %v", err)
	}

	res, err := dstM.ImportWorld(ctx, zipPath)
	if err != nil {
		t.Fatalf("ImportWorld: %v", err)
	}
	if res.RenamedLogins["gandalf"] != "gandalf (2)" {
		t.Fatalf("ожидали gandalf → gandalf (2), получили %v", res.RenamedLogins)
	}
	acc, err := dstM.accounts.ByID(ctx, "acc-src")
	if err != nil || acc.Username != "gandalf (2)" || acc.CompanyID != res.Company.ID {
		t.Fatalf("переименованный аккаунт: %+v (err %v)", acc, err)
	}
	ch, err := sqlite.NewCharacterStore(dstM.db, res.Company.ID, res.Company.System).ByID(ctx, "char-src")
	if err != nil || ch.AccountID != "acc-src" {
		t.Fatalf("персонаж не привязан к переименованному аккаунту: %+v (err %v)", ch, err)
	}
}

// На сервере всегда есть свой ДМ (seed-admin), поэтому архивный ДМ не
// переносится, а заворачивается на локального — иначе повторный импорт своего
// же архива всегда падал бы на «аккаунт уже есть».
func TestWorldPack_ImportReusesExistingDM(t *testing.T) {
	ctx := context.Background()
	srcM, _ := newTestManager(t)
	dstM, _ := newTestManager(t)

	src, err := srcM.Create(ctx, "Кампания", domain.SystemDnD5e2024)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := srcM.accounts.Create(ctx, &domain.Account{
		ID: "acc-gwen", Username: "gwen", PasswordHash: "h",
		Role: domain.AccountRolePlayer, Status: domain.AccountStatusActive, CompanyID: src.ID,
	}); err != nil {
		t.Fatalf("player: %v", err)
	}
	if err := srcM.accounts.Create(ctx, &domain.Account{
		ID: "acc-src-dm", Username: "dm", PasswordHash: "src-dm-hash",
		Role: domain.AccountRoleAdmin, Status: domain.AccountStatusActive,
	}); err != nil {
		t.Fatalf("src dm: %v", err)
	}
	scstore := sqlite.NewCharacterStore(srcM.db, src.ID, src.System)
	if err := scstore.Create(ctx, &domain.Character{ID: "char-dm", AccountID: "acc-src-dm", Name: "НПС ДМа"}); err != nil {
		t.Fatalf("dm char: %v", err)
	}
	if err := sqlite.NewPregenStore(srcM.db, src.ID).Create(ctx, &domain.Pregen{
		ID: "pg-1", Name: "Аня", ClaimedBy: "acc-gwen", ClaimedCharacterID: "char-gwen",
	}); err != nil {
		t.Fatalf("pregen: %v", err)
	}
	if err := scstore.Create(ctx, &domain.Character{ID: "char-gwen", AccountID: "acc-gwen", Name: "Гвен"}); err != nil {
		t.Fatalf("player char: %v", err)
	}
	zipPath := exportToZip(t, srcM, src.ID, true)

	// целевой сервер: свой ДМ с другим id
	if err := dstM.accounts.Create(ctx, &domain.Account{
		ID: "acc-local-dm", Username: "dm", PasswordHash: "local-dm-hash",
		Role: domain.AccountRoleAdmin, Status: domain.AccountStatusActive,
	}); err != nil {
		t.Fatalf("local dm: %v", err)
	}

	res, err := dstM.ImportWorld(ctx, zipPath)
	if err != nil {
		t.Fatalf("ImportWorld: %v", err)
	}
	if _, err := dstM.accounts.ByID(ctx, "acc-src-dm"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("архивный ДМ не должен был появиться на сервере (err %v)", err)
	}
	if local, err := dstM.accounts.ByID(ctx, "acc-local-dm"); err != nil || local.PasswordHash != "local-dm-hash" {
		t.Fatalf("локальный ДМ пострадал: %+v (err %v)", local, err)
	}
	dcstore := sqlite.NewCharacterStore(dstM.db, res.Company.ID, res.Company.System)
	if ch, err := dcstore.ByID(ctx, "char-dm"); err != nil || ch.AccountID != "acc-local-dm" {
		t.Fatalf("персонаж ДМа не завёрнут на локального ведущего: %+v (err %v)", ch, err)
	}
	pgs, err := sqlite.NewPregenStore(dstM.db, res.Company.ID).List(ctx)
	if err != nil || len(pgs) != 1 || pgs[0].ClaimedBy != "acc-gwen" {
		t.Fatalf("занятость прегена: %+v (err %v)", pgs, err)
	}
	if _, err := dstM.accounts.ByID(ctx, "acc-gwen"); err != nil {
		t.Fatalf("игрок не перенесён: %v", err)
	}
}

// Повторный импорт своего же архива на тот же сервер: id ДМ совпадает —
// раньше это давало «мир уже импортирован», теперь ДМ просто переиспользуется.
func TestWorldPack_ImportSameServerDMIdCollision(t *testing.T) {
	ctx := context.Background()
	m, _ := newTestManager(t)

	src, err := m.Create(ctx, "Кампания", domain.SystemDnD5e2024)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := m.accounts.Create(ctx, &domain.Account{
		ID: "acc-dm", Username: "dm", PasswordHash: "dm-hash",
		Role: domain.AccountRoleAdmin, Status: domain.AccountStatusActive,
	}); err != nil {
		t.Fatalf("dm: %v", err)
	}
	if err := m.accounts.Create(ctx, &domain.Account{
		ID: "acc-p", Username: "player", PasswordHash: "p",
		Role: domain.AccountRolePlayer, Status: domain.AccountStatusActive, CompanyID: src.ID,
	}); err != nil {
		t.Fatalf("player: %v", err)
	}
	zipPath := exportToZip(t, m, src.ID, true)

	// player id всё ещё занят — этот же мир уже на сервере
	if _, err := m.ImportWorld(ctx, zipPath); err == nil {
		t.Fatal("ожидали отказ: игрок с таким id уже есть")
	}

	// убираем игрока (мир «удалён»), но ДМ остаётся — импорт должен пройти
	if err := m.accounts.Delete(ctx, "acc-p"); err != nil {
		t.Fatalf("delete player: %v", err)
	}
	if _, err := m.ImportWorld(ctx, zipPath); err != nil {
		t.Fatalf("повторный импорт с тем же ДМ отклонён: %v", err)
	}
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
