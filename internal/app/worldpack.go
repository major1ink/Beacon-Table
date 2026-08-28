package app

// Экспорт/импорт мира одним .zip. «Мир» на диске — это три несвязанные
// поверхности хранения (файлы под dataRoot, строки beacon.db со скоупом
// company_id, ассеты под uploadsRoot), системы модулей у проекта нет —
// поэтому «выгрузить мир» = собрать все три в архив, «загрузить» = создать
// новый мир и разложить архив по его корням. internal/app — единственный
// слой, которому можно знать конкретные репозитории и раскладку на диске
// (см. package-doc), поэтому логика здесь, рядом с CompanyManager.
//
// В экспорт по умолчанию едет только КОНТЕНТ: сцены, журнал, пользовательские
// библиотеки, плейлисты, преген-персонажи, загрузки. По флагу includeAccounts
// дополнительно едут аккаунты — игроки этого мира И аккаунты ДМ (с хешами
// паролей) — плюс персонажи с инвентарём. Тогда id сохраняются, и ссылки на
// владельцев токенов / в шапках журнала / в занятых прегенах остаются
// рабочими, а на целевом сервере сразу есть готовые логины (нужно демо-сиду).
// Без флага эти ссылки при экспорте обнуляются (см. scrubOwners,
// stripJournalFrontMatter), чтобы импортированный мир не содержал битых
// привязок. Импорт всегда создаёт НОВЫЙ мир, запускать его ДМ должен сам.

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository/sqlite"
)

const (
	worldPackFormat = "beacon-world/v1"
	// worldUploadsSentinel — чем в текстах архива заменён префикс URL загрузок
	// исходного мира (`/uploads/companies/<id>/` или `/uploads/` у legacy).
	// На импорте разворачивается обратно в префикс нового мира. Подчёркивания
	// — чтобы токен пережил и JSON, и markdown без экранирования.
	worldUploadsSentinel = "__BEACON_UPLOADS__/"

	// Лимиты распаковки — та же защита от zip-бомбы, что и у импорта Foundry
	// (держать в синхроне с internal/foundry/module.go).
	maxWorldUnpackedBytes = 4 << 30
	maxWorldUnpackedFiles = 200000
	maxWorldManifestBytes = 1 << 20
)

// worldSubdirs — поддиректории мира под dataRoot, которые едут в архив. Всё
// прочее в dataRoot (beacon.db у legacy-мира, foundry-cache, companies/) —
// не контент этого мира и в экспорт не попадает.
var worldSubdirs = []string{"scenes", "journal", "bestiary", "spells", "items", "references", "conditions"}

type worldManifest struct {
	Format           string            `json:"format"`
	BeaconVersion    string            `json:"beaconVersion"`
	ExportedAt       string            `json:"exportedAt"`
	World            worldManifestMeta `json:"world"`
	IncludesAccounts bool              `json:"includesAccounts,omitempty"`
	Counts           map[string]int    `json:"counts,omitempty"`
}

type worldManifestMeta struct {
	Name   string `json:"name"`
	System string `json:"system"`
}

type exportPlaylist struct {
	ID        string                `json:"id"`
	Name      string                `json:"name"`
	CreatedAt time.Time             `json:"createdAt"`
	Tracks    []exportPlaylistTrack `json:"tracks"`
}

type exportPlaylistTrack struct {
	URL    string  `json:"url"`
	Name   string  `json:"name"`
	Volume float64 `json:"volume"`
	Loop   bool    `json:"loop"`
}

type exportPregen struct {
	ID                 string                `json:"id"`
	Name               string                `json:"name"`
	AvatarURL          string                `json:"avatarUrl"`
	Source             string                `json:"source"`
	Sheet              domain.CharacterSheet `json:"sheet"`
	CreatedAt          time.Time             `json:"createdAt"`
	ClaimedBy          string                `json:"claimedBy,omitempty"`          // accountID — только при includeAccounts
	ClaimedCharacterID string                `json:"claimedCharacterId,omitempty"` // characterID — только при includeAccounts
}

// exportAccount — аккаунт в архиве мира (includeAccounts): игрок этого мира
// либо ДМ (глобальный). Пароль — bcrypt-хеш как есть. Нужен для демо-сида:
// в архив кладётся готовый мир вместе с логинами, которые ждут игроков.
type exportAccount struct {
	ID                 string `json:"id"`
	Username           string `json:"username"`
	PasswordHash       string `json:"passwordHash"`
	Role               string `json:"role"` // player | admin
	Status             string `json:"status"`
	MustChangePassword bool   `json:"mustChangePassword,omitempty"`
}

// exportCharacter — персонаж игрока в архиве (includeAccounts), с инвентарём.
type exportCharacter struct {
	ID        string                   `json:"id"`
	AccountID string                   `json:"accountId"`
	Name      string                   `json:"name"`
	AvatarURL string                   `json:"avatarUrl"`
	Sheet     domain.CharacterSheet    `json:"sheet"`
	Inventory []*domain.InventoryEntry `json:"inventory,omitempty"`
}

// ImportResult — итог ImportWorld: созданный мир и карта переименованных из-за
// коллизий логинов (старый → новый), пустая, если аккаунты не переносились
// или совпадений не было.
type ImportResult struct {
	Company       *domain.Company
	RenamedLogins map[string]string
}

// importOutcome — то, что накопилось по ходу распаковки и нужно либо отдать
// вызывающему (renamedLogins), либо откатить при сбое (createdAccountIDs —
// аккаунты создаются раньше остального, а их удаление каскадит персонажей и
// сессии по FK).
type importOutcome struct {
	renamedLogins     map[string]string
	createdAccountIDs []string
}

// CompanyByID — один мир по id (для HTTP-слоя: 404 и имя файла экспорта).
func (m *CompanyManager) CompanyByID(ctx context.Context, id string) (*domain.Company, error) {
	return m.companies.ByID(ctx, id)
}

// ExportWorld пишет мир companyID в w как .zip. includeAccounts — тащить ли
// аккаунты игроков и их персонажей (см. package-doc). Ошибку возвращает ДО
// первого записанного байта только пока не тронут zip.Writer (мир не найден,
// сбой БД); дальше стрим уже идёт, вызывающему остаётся его логировать.
func (m *CompanyManager) ExportWorld(ctx context.Context, companyID, beaconVersion string, includeAccounts bool, w io.Writer) error {
	company, err := m.companies.ByID(ctx, companyID)
	if err != nil {
		return err
	}
	dataRoot, uploadsRoot, uploadsURL := m.rootsFor(company)

	zw := zip.NewWriter(w)
	counts := map[string]int{}

	addFile := func(name string, data []byte) error {
		fw, err := zw.Create(name)
		if err != nil {
			return err
		}
		_, err = fw.Write(data)
		return err
	}

	for _, sub := range worldSubdirs {
		root := filepath.Join(dataRoot, sub)
		walkErr := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				if errors.Is(err, fs.ErrNotExist) {
					return nil // мир ни разу не запускали — каталога просто нет
				}
				return err
			}
			if d.IsDir() {
				if d.Name() == "migrations" {
					return fs.SkipDir // история миграций формата сцен — не контент
				}
				return nil
			}
			if !d.Type().IsRegular() {
				return nil
			}
			rel, err := filepath.Rel(dataRoot, path)
			if err != nil {
				return err
			}
			b, err := os.ReadFile(path) //nolint:gosec // G304: путь из WalkDir по dataRoot
			if err != nil {
				return err
			}
			ext := strings.ToLower(filepath.Ext(path))
			if ext == ".json" || ext == ".md" {
				text := strings.ReplaceAll(string(b), uploadsURL, worldUploadsSentinel)
				slashRel := filepath.ToSlash(rel)
				switch {
				case sub == "journal" && ext == ".md":
					if !includeAccounts {
						text = stripJournalFrontMatter(text)
					}
					counts["journal"]++
				case sub == "scenes" && strings.HasSuffix(slashRel, "/combat.json"):
					if !includeAccounts {
						text = scrubOwners(text, "combatants")
					}
				case sub == "scenes" && strings.Contains(slashRel, "/scenes/"):
					if !includeAccounts {
						text = scrubOwners(text, "tokens")
					}
					counts["scenes"]++
				case sub != "scenes":
					counts["cards"]++
				}
				b = []byte(text)
			}
			return addFile("world/"+filepath.ToSlash(rel), b)
		})
		if walkErr != nil {
			return walkErr
		}
	}

	if err := walkUploads(uploadsRoot, func(rel string, b []byte) error {
		counts["assets"]++
		return addFile("uploads/"+rel, b)
	}); err != nil {
		return err
	}

	playlists, err := sqlite.NewPlaylistStore(m.db, company.ID).List(ctx)
	if err != nil {
		return err
	}
	pls := make([]exportPlaylist, 0, len(playlists))
	for _, p := range playlists {
		ep := exportPlaylist{ID: p.ID, Name: p.Name, CreatedAt: p.CreatedAt}
		for _, t := range p.Tracks {
			ep.Tracks = append(ep.Tracks, exportPlaylistTrack{URL: t.URL, Name: t.Name, Volume: t.Volume, Loop: t.Loop})
		}
		pls = append(pls, ep)
	}
	counts["playlists"] = len(pls)
	if err := addJSONFile(addFile, "db/playlists.json", pls, uploadsURL); err != nil {
		return err
	}

	pregenList, err := sqlite.NewPregenStore(m.db, company.ID).List(ctx)
	if err != nil {
		return err
	}
	pgs := make([]exportPregen, 0, len(pregenList))
	for _, p := range pregenList {
		ep := exportPregen{
			ID: p.ID, Name: p.Name, AvatarURL: p.AvatarURL, Source: p.Source, Sheet: p.Sheet, CreatedAt: p.CreatedAt,
		}
		if includeAccounts {
			// Занятость прегена держится на id аккаунта/персонажа — есть смысл
			// только когда они тоже приезжают.
			ep.ClaimedBy = p.ClaimedBy
			ep.ClaimedCharacterID = p.ClaimedCharacterID
		}
		pgs = append(pgs, ep)
	}
	counts["pregens"] = len(pgs)
	if err := addJSONFile(addFile, "db/pregens.json", pgs, uploadsURL); err != nil {
		return err
	}

	mods, err := sqlite.NewFoundryModuleStore(m.db, company.ID).List(ctx)
	if err != nil {
		return err
	}
	if err := addJSONFile(addFile, "db/foundry_modules.json", mods, uploadsURL); err != nil {
		return err
	}

	if includeAccounts {
		accs, err := m.exportAccounts(ctx, company.ID)
		if err != nil {
			return err
		}
		counts["accounts"] = len(accs)
		if err := addJSONFile(addFile, "db/accounts.json", accs, ""); err != nil {
			return err
		}
		chars, err := m.exportCharacters(ctx, company)
		if err != nil {
			return err
		}
		counts["characters"] = len(chars)
		if err := addJSONFile(addFile, "db/characters.json", chars, uploadsURL); err != nil {
			return err
		}
	}

	man := worldManifest{
		Format:           worldPackFormat,
		BeaconVersion:    beaconVersion,
		ExportedAt:       time.Now().UTC().Format(time.RFC3339),
		World:            worldManifestMeta{Name: company.Name, System: company.System},
		IncludesAccounts: includeAccounts,
		Counts:           counts,
	}
	if err := addJSONFile(addFile, "manifest.json", man, ""); err != nil {
		return err
	}

	return zw.Close()
}

// addJSONFile маршалит v, при непустом uploadsURL заменяет его на сентинел
// (URL-ы бывают и внутри листов прегенов, и в треках плейлистов) и кладёт в
// архив.
func addJSONFile(addFile func(string, []byte) error, name string, v any, uploadsURL string) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	if uploadsURL != "" {
		b = []byte(strings.ReplaceAll(string(b), uploadsURL, worldUploadsSentinel))
	}
	return addFile(name, b)
}

// exportAccounts — игроки ЭТОГО мира плюс все аккаунты ДМ (они глобальны,
// CompanyID == ""). ДМ едут в архив ради демо-сида: развернул архив — и на
// сервере уже есть готовый логин ведущего. Обычный бэкап/обмен приключением
// тоже их несёт — импортёр видит их в панели и может удалить лишние.
func (m *CompanyManager) exportAccounts(ctx context.Context, companyID string) ([]exportAccount, error) {
	all, err := m.accounts.List(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]exportAccount, 0)
	for _, a := range all {
		isPlayerHere := a.Role == domain.AccountRolePlayer && a.CompanyID == companyID
		isDM := a.Role == domain.AccountRoleAdmin
		if !isPlayerHere && !isDM {
			continue
		}
		out = append(out, exportAccount{
			ID: a.ID, Username: a.Username, PasswordHash: a.PasswordHash,
			Role: a.Role, Status: a.Status, MustChangePassword: a.MustChangePassword,
		})
	}
	return out, nil
}

// exportCharacters — все персонажи мира с инвентарём (id сохраняются, чтобы
// Token.OwnerID/CharacterID и т.п. остались валидны после импорта).
func (m *CompanyManager) exportCharacters(ctx context.Context, company *domain.Company) ([]exportCharacter, error) {
	cstore := sqlite.NewCharacterStore(m.db, company.ID, company.System)
	chars, err := cstore.All(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]exportCharacter, 0, len(chars))
	for _, c := range chars {
		inv, err := cstore.ListInventory(ctx, c.ID)
		if err != nil {
			return nil, err
		}
		out = append(out, exportCharacter{
			ID: c.ID, AccountID: c.AccountID, Name: c.Name, AvatarURL: c.AvatarURL,
			Sheet: c.Sheet, Inventory: inv,
		})
	}
	return out, nil
}

// walkUploads обходит все обычные файлы под root, пропуская вложенный
// companies/ (у legacy-мира root == uploads/, и там лежат ассеты ДРУГИХ
// миров — они не наши).
func walkUploads(root string, fn func(rel string, b []byte) error) error {
	return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if d.IsDir() {
			if rel == "companies" {
				return fs.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		b, err := os.ReadFile(path) //nolint:gosec // G304: путь из WalkDir по uploadsRoot
		if err != nil {
			return err
		}
		return fn(filepath.ToSlash(rel), b)
	})
}

// ImportWorld создаёт новый мир из архива archivePath и раскладывает его
// содержимое по корням мира. Если в архиве есть db/accounts.json — переносит и
// аккаунты (игроков и ДМ) с персонажами (логины при коллизии получают суффикс,
// см. ImportResult.RenamedLogins). Мир не запускается. Любой сбой после
// создания записи мира откатывается (запись мира, оба каталога, созданные
// аккаунты).
func (m *CompanyManager) ImportWorld(ctx context.Context, archivePath string) (*ImportResult, error) {
	zr, err := zip.OpenReader(archivePath)
	if err != nil {
		return nil, &domain.ValidationError{Msg: "не удалось открыть архив — это точно .zip мира Beacon Table?"}
	}
	defer func() { _ = zr.Close() }()

	man, err := readWorldManifest(&zr.Reader)
	if err != nil {
		return nil, err
	}
	if man.Format != worldPackFormat {
		return nil, &domain.ValidationError{Msg: "неизвестный формат архива: " + man.Format}
	}
	if strings.TrimSpace(man.World.Name) == "" {
		return nil, &domain.ValidationError{Msg: "в архиве не указано название мира"}
	}
	if !domain.ValidSystem(man.World.System) {
		return nil, &domain.ValidationError{Msg: "в архиве неизвестная игровая система: " + man.World.System}
	}

	company, err := m.Create(ctx, man.World.Name, man.World.System)
	if err != nil {
		return nil, err
	}
	dataRoot, uploadsRoot, uploadsURL := m.rootsFor(company)

	out, err := m.populateWorld(ctx, &zr.Reader, company.ID, company.System, dataRoot, uploadsRoot, uploadsURL)
	if err != nil {
		for _, id := range out.createdAccountIDs {
			_ = m.accounts.Delete(ctx, id) // каскадит персонажей/инвентарь/сессии
		}
		_ = m.companies.Delete(ctx, company.ID)
		_ = os.RemoveAll(dataRoot)
		_ = os.RemoveAll(uploadsRoot)
		return nil, err
	}
	return &ImportResult{Company: company, RenamedLogins: out.renamedLogins}, nil
}

func (m *CompanyManager) populateWorld(ctx context.Context, zr *zip.Reader, companyID, system, dataRoot, uploadsRoot, uploadsURL string) (*importOutcome, error) {
	out := &importOutcome{}
	if err := os.MkdirAll(dataRoot, 0o750); err != nil {
		return out, err
	}
	if err := os.MkdirAll(uploadsRoot, 0o750); err != nil {
		return out, err
	}

	dbFiles := map[string][]byte{}
	var total int64
	var files int

	for _, entry := range zr.File {
		name := filepath.ToSlash(entry.Name)
		if name == "manifest.json" {
			continue
		}

		if strings.HasPrefix(name, "db/") {
			if entry.FileInfo().IsDir() {
				continue
			}
			b, err := readZipEntry(entry, maxWorldUnpackedBytes-total)
			if err != nil {
				return out, err
			}
			total += int64(len(b))
			dbFiles[name] = b
			continue
		}

		var destRoot, rel string
		rewrite := false
		switch {
		case strings.HasPrefix(name, "world/"):
			destRoot, rel, rewrite = dataRoot, strings.TrimPrefix(name, "world/"), true
		case strings.HasPrefix(name, "uploads/"):
			destRoot, rel = uploadsRoot, strings.TrimPrefix(name, "uploads/")
		default:
			return out, &domain.ValidationError{Msg: "неизвестная запись в архиве: " + entry.Name}
		}

		if entry.FileInfo().IsDir() {
			continue
		}
		if !entry.FileInfo().Mode().IsRegular() {
			continue
		}
		if strings.Contains(rel, "migrations/") || strings.Contains(rel, "foundry-cache/") {
			continue
		}

		dst, ok := safeJoin(destRoot, rel)
		if !ok {
			return out, &domain.ValidationError{Msg: "недопустимый путь в архиве: " + entry.Name}
		}
		files++
		if files > maxWorldUnpackedFiles {
			return out, &domain.ValidationError{Msg: "в архиве слишком много файлов"}
		}
		b, err := readZipEntry(entry, maxWorldUnpackedBytes-total)
		if err != nil {
			return out, err
		}
		total += int64(len(b))

		if rewrite {
			if ext := strings.ToLower(filepath.Ext(rel)); ext == ".json" || ext == ".md" {
				b = []byte(strings.ReplaceAll(string(b), worldUploadsSentinel, uploadsURL))
			}
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o750); err != nil {
			return out, err
		}
		if err := os.WriteFile(dst, b, 0o600); err != nil {
			return out, err
		}
	}

	return m.importWorldDB(ctx, companyID, system, dbFiles, uploadsURL)
}

func (m *CompanyManager) importWorldDB(ctx context.Context, companyID, system string, dbFiles map[string][]byte, uploadsURL string) (*importOutcome, error) {
	unseal := func(b []byte) []byte {
		return []byte(strings.ReplaceAll(string(b), worldUploadsSentinel, uploadsURL))
	}

	// Аккаунты (игроки + ДМ) и персонажи — раньше всего: на их id (сохраняются
	// как есть) ссылаются токены сцен, шапки журнала и занятость прегенов.
	out, err := m.importAccounts(ctx, companyID, system, dbFiles)
	if err != nil {
		return out, err
	}

	if raw, ok := dbFiles["db/playlists.json"]; ok {
		var pls []exportPlaylist
		if err := json.Unmarshal(unseal(raw), &pls); err != nil {
			return out, &domain.ValidationError{Msg: "битый db/playlists.json в архиве"}
		}
		store := sqlite.NewPlaylistStore(m.db, companyID)
		for _, p := range pls {
			// id генерим заново: playlists.id уникален глобально, архивный мог
			// бы столкнуться с уже существующим. Перекрёстных ссылок на него
			// нет — треки адресуются через тот id, что мы тут и создаём.
			id := newID()
			if err := store.Create(ctx, id, p.Name); err != nil {
				return out, err
			}
			for _, t := range p.Tracks {
				if err := store.AddTrack(ctx, newID(), id, t.URL, t.Name, t.Volume, t.Loop); err != nil {
					return out, err
				}
			}
		}
	}

	if raw, ok := dbFiles["db/pregens.json"]; ok {
		var pgs []exportPregen
		if err := json.Unmarshal(unseal(raw), &pgs); err != nil {
			return out, &domain.ValidationError{Msg: "битый db/pregens.json в архиве"}
		}
		store := sqlite.NewPregenStore(m.db, companyID)
		for _, p := range pgs {
			// id прегена генерим заново (pregen_characters.id уникален
			// глобально, внешних ссылок на него нет). claimed_* непустые
			// только если экспорт был с аккаунтами — тогда id аккаунта и
			// персонажа тоже перенесены и разрешатся.
			if err := store.Create(ctx, &domain.Pregen{
				ID: newID(), Name: p.Name, AvatarURL: p.AvatarURL, Sheet: p.Sheet, Source: p.Source,
				ClaimedBy: p.ClaimedBy, ClaimedCharacterID: p.ClaimedCharacterID,
			}); err != nil {
				return out, err
			}
		}
	}

	if raw, ok := dbFiles["db/foundry_modules.json"]; ok {
		var mods []domain.FoundryModule
		if err := json.Unmarshal(raw, &mods); err != nil {
			return out, &domain.ValidationError{Msg: "битый db/foundry_modules.json в архиве"}
		}
		store := sqlite.NewFoundryModuleStore(m.db, companyID)
		for _, fm := range mods {
			if fm.ID == "" {
				continue
			}
			if err := store.Upsert(ctx, fm); err != nil {
				return out, err
			}
		}
	}
	return out, nil
}

// importAccounts переносит аккаунты (игроков этого мира и ДМ) и персонажей
// (db/accounts.json, db/characters.json). id аккаунтов и персонажей
// сохраняются как есть — на них ссылаются токены сцен, шапки журнала,
// занятость прегенов. Логин при коллизии получает суффикс « (N)». Аккаунт ДМ
// восстанавливается глобальным (CompanyID == ""), игрок — привязанным к
// новому миру. Возвращаемый importOutcome несёт и переименования, и id всех
// созданных аккаунтов (для отката при сбое дальше по распаковке).
func (m *CompanyManager) importAccounts(ctx context.Context, companyID, system string, dbFiles map[string][]byte) (*importOutcome, error) {
	out := &importOutcome{renamedLogins: map[string]string{}}
	raw, ok := dbFiles["db/accounts.json"]
	if !ok {
		return out, nil
	}
	var accs []exportAccount
	if err := json.Unmarshal(raw, &accs); err != nil {
		return out, &domain.ValidationError{Msg: "битый db/accounts.json в архиве"}
	}
	// id аккаунтов сохраняются (на них ссылаются токены/журнал) — значит
	// повторный импорт того же архива на тот же сервер невозможен. Ловим это
	// заранее и понятным текстом, а не констрейнтом БД посреди распаковки.
	for _, a := range accs {
		if a.ID == "" {
			continue
		}
		if _, err := m.accounts.ByID(ctx, a.ID); err == nil {
			return out, &domain.ValidationError{Msg: "аккаунт из архива («" + a.Username + "») уже есть на этом сервере — похоже, мир уже импортирован. Удалите старую копию, либо экспортируйте без аккаунтов."}
		} else if !errors.Is(err, domain.ErrNotFound) {
			return out, err
		}
	}

	uploadsURL := m.uploadsURLFor(companyID)
	for _, a := range accs {
		if a.ID == "" || a.Username == "" || a.PasswordHash == "" {
			return out, &domain.ValidationError{Msg: "битый db/accounts.json: пустой id, логин или пароль"}
		}
		name, err := m.freeUsername(ctx, a.Username)
		if err != nil {
			return out, err
		}
		if name != a.Username {
			out.renamedLogins[a.Username] = name
		}
		status := a.Status
		if status != domain.AccountStatusActive && status != domain.AccountStatusPending {
			status = domain.AccountStatusActive
		}
		// Роль как в архиве; ДМ — глобальный (не привязан к миру), тем же
		// принципом, что и seed-admin (см. domain.Account.CompanyID).
		role := domain.AccountRolePlayer
		accCompany := companyID
		if a.Role == domain.AccountRoleAdmin {
			role = domain.AccountRoleAdmin
			accCompany = ""
		}
		if err := m.accounts.Create(ctx, &domain.Account{
			ID: a.ID, Username: name, PasswordHash: a.PasswordHash,
			Role: role, Status: status, MustChangePassword: a.MustChangePassword,
			CompanyID: accCompany,
		}); err != nil {
			return out, &domain.ValidationError{Msg: "не удалось создать аккаунт «" + name + "» из архива (возможно, конфликт id)"}
		}
		out.createdAccountIDs = append(out.createdAccountIDs, a.ID)
	}

	if craw, ok := dbFiles["db/characters.json"]; ok {
		unsealed := []byte(strings.ReplaceAll(string(craw), worldUploadsSentinel, uploadsURL))
		var chars []exportCharacter
		if err := json.Unmarshal(unsealed, &chars); err != nil {
			return out, &domain.ValidationError{Msg: "битый db/characters.json в архиве"}
		}
		cstore := sqlite.NewCharacterStore(m.db, companyID, system)
		for _, c := range chars {
			if c.ID == "" || c.AccountID == "" {
				return out, &domain.ValidationError{Msg: "битый db/characters.json: пустой id или accountId"}
			}
			if err := cstore.Create(ctx, &domain.Character{
				ID: c.ID, AccountID: c.AccountID, Name: c.Name, AvatarURL: c.AvatarURL, Sheet: c.Sheet,
			}); err != nil {
				return out, &domain.ValidationError{Msg: "не удалось создать персонажа «" + c.Name + "» из архива"}
			}
			for _, e := range c.Inventory {
				if e == nil {
					continue
				}
				if _, err := cstore.AddInventoryEntry(ctx, c.ID, c.AccountID, *e); err != nil {
					return out, err
				}
			}
		}
	}
	return out, nil
}

// uploadsURLFor — префикс URL загрузок мира companyID.
func (m *CompanyManager) uploadsURLFor(companyID string) string {
	company, err := m.companies.ByID(context.Background(), companyID)
	if err != nil {
		return ""
	}
	_, _, uploadsURL := m.rootsFor(company)
	return uploadsURL
}

// freeUsername — исходный логин, если свободен, иначе « (2)», « (3)», …
func (m *CompanyManager) freeUsername(ctx context.Context, want string) (string, error) {
	free := func(name string) (bool, error) {
		_, err := m.accounts.ByUsername(ctx, name)
		if errors.Is(err, domain.ErrNotFound) {
			return true, nil
		}
		return false, err // nil (занят) либо реальная ошибка БД
	}
	if ok, err := free(want); err != nil {
		return "", err
	} else if ok {
		return want, nil
	}
	for i := 2; i <= 50; i++ {
		cand := fmt.Sprintf("%s (%d)", want, i)
		if ok, err := free(cand); err != nil {
			return "", err
		} else if ok {
			return cand, nil
		}
	}
	return "", &domain.ValidationError{Msg: "слишком много занятых логинов вида «" + want + " (N)» — переименуйте вручную и повторите"}
}

func readWorldManifest(zr *zip.Reader) (*worldManifest, error) {
	for _, f := range zr.File {
		if filepath.ToSlash(f.Name) != "manifest.json" {
			continue
		}
		b, err := readZipEntry(f, maxWorldManifestBytes)
		if err != nil {
			return nil, err
		}
		var man worldManifest
		if err := json.Unmarshal(b, &man); err != nil {
			return nil, &domain.ValidationError{Msg: "битый manifest.json в архиве"}
		}
		return &man, nil
	}
	return nil, &domain.ValidationError{Msg: "в архиве нет manifest.json — это не экспорт мира Beacon Table"}
}

func readZipEntry(entry *zip.File, budget int64) ([]byte, error) {
	if budget <= 0 {
		return nil, &domain.ValidationError{Msg: "распакованный архив мира больше допустимого"}
	}
	rc, err := entry.Open()
	if err != nil {
		return nil, err
	}
	defer func() { _ = rc.Close() }()
	b, err := io.ReadAll(io.LimitReader(rc, budget+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > budget {
		return nil, &domain.ValidationError{Msg: "распакованный архив мира больше допустимого"}
	}
	return b, nil
}

// stripJournalFrontMatter убирает из шапки записи журнала привязки к
// аккаунтам (owner/ownerName/access — их id в целевом сервере нет),
// сохраняя только уровень видимости default. Формат шапки — см.
// internal/repository/journalfile package-doc.
func stripJournalFrontMatter(raw string) string {
	s := strings.TrimPrefix(raw, "\ufeff") // BOM от редактора не должен прятать шапку
	if !strings.HasPrefix(s, "---\n") && !strings.HasPrefix(s, "---\r\n") {
		return raw
	}
	lines := strings.Split(s, "\n")
	end := -1
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			end = i
			break
		}
	}
	if end < 0 {
		return raw // незакрытая шапка — не трогаем, текст не теряем
	}
	def := ""
	for _, line := range lines[1:end] {
		key, value, ok := strings.Cut(strings.TrimSpace(strings.TrimRight(line, "\r")), ":")
		if ok && strings.TrimSpace(key) == "default" {
			def = strings.TrimSpace(value)
		}
	}
	body := strings.Join(lines[end+1:], "\n")
	if def == "" {
		return body
	}
	return "---\ndefault: " + def + "\n---\n" + body
}

// scrubOwners вырезает ownerId/characterId из объектов под ключом key
// (`tokens` в JSON сцены, `combatants` в combat.json) — их id указывают на
// аккаунты и персонажей исходного мира, которых в новом нет. Работает по
// map[string]any, чтобы не потерять никакие другие поля файла; при непарсе
// возвращает исходный текст (лучше оставить как есть, чем потерять файл).
func scrubOwners(jsonText, key string) string {
	var m map[string]any
	if err := json.Unmarshal([]byte(jsonText), &m); err != nil {
		return jsonText
	}
	objs, ok := m[key].(map[string]any)
	if !ok {
		return jsonText
	}
	changed := false
	for _, v := range objs {
		o, ok := v.(map[string]any)
		if !ok {
			continue
		}
		for _, k := range []string{"ownerId", "characterId"} {
			if _, had := o[k]; had {
				delete(o, k)
				changed = true
			}
		}
	}
	if !changed {
		return jsonText
	}
	out, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return jsonText
	}
	return string(out)
}

// safeJoin — путь внутри dir по имени записи архива; ok=false, если имя
// уводит наружу (zip slip). Скопировано из internal/foundry/module.go —
// держать в синхроне.
func safeJoin(dir, name string) (string, bool) {
	clean := filepath.Clean(filepath.FromSlash(strings.ReplaceAll(name, "\\", "/")))
	if clean == "." || filepath.IsAbs(clean) || strings.HasPrefix(clean, "..") {
		return "", false
	}
	target := filepath.Join(dir, clean)
	rel, err := filepath.Rel(dir, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	return target, true
}
