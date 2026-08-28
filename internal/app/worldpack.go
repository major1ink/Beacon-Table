package app

// Экспорт/импорт мира одним .zip. «Мир» на диске — это три несвязанные
// поверхности хранения (файлы под dataRoot, строки beacon.db со скоупом
// company_id, ассеты под uploadsRoot), системы модулей у проекта нет —
// поэтому «выгрузить мир» = собрать все три в архив, «загрузить» = создать
// новый мир и разложить архив по его корням. internal/app — единственный
// слой, которому можно знать конкретные репозитории и раскладку на диске
// (см. package-doc), поэтому логика здесь, рядом с CompanyManager.
//
// В экспорт едет только КОНТЕНТ: сцены, журнал, пользовательские библиотеки,
// плейлисты, преген-персонажи, загрузки. Аккаунты игроков, их персонажи и
// сессии — нет (аккаунты глобальны, не привязаны к миру). Импорт всегда
// создаёт НОВЫЙ мир, запускать его ДМ должен сам.

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
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
	Format        string            `json:"format"`
	BeaconVersion string            `json:"beaconVersion"`
	ExportedAt    string            `json:"exportedAt"`
	World         worldManifestMeta `json:"world"`
	Counts        map[string]int    `json:"counts,omitempty"`
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
	ID        string                `json:"id"`
	Name      string                `json:"name"`
	AvatarURL string                `json:"avatarUrl"`
	Source    string                `json:"source"`
	Sheet     domain.CharacterSheet `json:"sheet"`
	CreatedAt time.Time             `json:"createdAt"`
}

// CompanyByID — один мир по id (для HTTP-слоя: 404 и имя файла экспорта).
func (m *CompanyManager) CompanyByID(ctx context.Context, id string) (*domain.Company, error) {
	return m.companies.ByID(ctx, id)
}

// ExportWorld пишет мир companyID в w как .zip. Ошибку возвращает ДО первого
// записанного байта только в двух случаях (мир не найден, сбой БД); дальше
// стрим уже идёт, вызывающему остаётся его логировать.
func (m *CompanyManager) ExportWorld(ctx context.Context, companyID, beaconVersion string, w io.Writer) error {
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
				if sub == "journal" && ext == ".md" {
					text = stripJournalFrontMatter(text)
					counts["journal"]++
				} else if sub == "scenes" {
					if strings.Contains(filepath.ToSlash(rel), "/scenes/") {
						counts["scenes"]++
					}
				} else {
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
		pgs = append(pgs, exportPregen{
			ID: p.ID, Name: p.Name, AvatarURL: p.AvatarURL, Source: p.Source, Sheet: p.Sheet, CreatedAt: p.CreatedAt,
		})
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

	man := worldManifest{
		Format:        worldPackFormat,
		BeaconVersion: beaconVersion,
		ExportedAt:    time.Now().UTC().Format(time.RFC3339),
		World:         worldManifestMeta{Name: company.Name, System: company.System},
		Counts:        counts,
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
// содержимое по корням мира. Мир не запускается. Любой сбой после создания
// записи мира откатывается (запись + оба каталога сносятся).
func (m *CompanyManager) ImportWorld(ctx context.Context, archivePath string) (*domain.Company, error) {
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

	if err := m.populateWorld(ctx, &zr.Reader, company.ID, dataRoot, uploadsRoot, uploadsURL); err != nil {
		_ = m.companies.Delete(ctx, company.ID)
		_ = os.RemoveAll(dataRoot)
		_ = os.RemoveAll(uploadsRoot)
		return nil, err
	}
	return company, nil
}

func (m *CompanyManager) populateWorld(ctx context.Context, zr *zip.Reader, companyID, dataRoot, uploadsRoot, uploadsURL string) error {
	if err := os.MkdirAll(dataRoot, 0o750); err != nil {
		return err
	}
	if err := os.MkdirAll(uploadsRoot, 0o750); err != nil {
		return err
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
				return err
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
			return &domain.ValidationError{Msg: "неизвестная запись в архиве: " + entry.Name}
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
			return &domain.ValidationError{Msg: "недопустимый путь в архиве: " + entry.Name}
		}
		files++
		if files > maxWorldUnpackedFiles {
			return &domain.ValidationError{Msg: "в архиве слишком много файлов"}
		}
		b, err := readZipEntry(entry, maxWorldUnpackedBytes-total)
		if err != nil {
			return err
		}
		total += int64(len(b))

		if rewrite {
			if ext := strings.ToLower(filepath.Ext(rel)); ext == ".json" || ext == ".md" {
				b = []byte(strings.ReplaceAll(string(b), worldUploadsSentinel, uploadsURL))
			}
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o750); err != nil {
			return err
		}
		if err := os.WriteFile(dst, b, 0o600); err != nil {
			return err
		}
	}

	return m.importWorldDB(ctx, companyID, dbFiles, uploadsURL)
}

func (m *CompanyManager) importWorldDB(ctx context.Context, companyID string, dbFiles map[string][]byte, uploadsURL string) error {
	unseal := func(b []byte) []byte {
		return []byte(strings.ReplaceAll(string(b), worldUploadsSentinel, uploadsURL))
	}

	if raw, ok := dbFiles["db/playlists.json"]; ok {
		var pls []exportPlaylist
		if err := json.Unmarshal(unseal(raw), &pls); err != nil {
			return &domain.ValidationError{Msg: "битый db/playlists.json в архиве"}
		}
		store := sqlite.NewPlaylistStore(m.db, companyID)
		for _, p := range pls {
			// id генерим заново: playlists.id уникален глобально, архивный мог
			// бы столкнуться с уже существующим. Перекрёстных ссылок на него
			// нет — треки адресуются через тот id, что мы тут и создаём.
			id := newID()
			if err := store.Create(ctx, id, p.Name); err != nil {
				return err
			}
			for _, t := range p.Tracks {
				if err := store.AddTrack(ctx, newID(), id, t.URL, t.Name, t.Volume, t.Loop); err != nil {
					return err
				}
			}
		}
	}

	if raw, ok := dbFiles["db/pregens.json"]; ok {
		var pgs []exportPregen
		if err := json.Unmarshal(unseal(raw), &pgs); err != nil {
			return &domain.ValidationError{Msg: "битый db/pregens.json в архиве"}
		}
		store := sqlite.NewPregenStore(m.db, companyID)
		for _, p := range pgs {
			// id заново (pregen_characters.id уникален глобально); claimed_*
			// не переносим — в новом мире пул свободен.
			if err := store.Create(ctx, &domain.Pregen{
				ID: newID(), Name: p.Name, AvatarURL: p.AvatarURL, Sheet: p.Sheet, Source: p.Source,
			}); err != nil {
				return err
			}
		}
	}

	if raw, ok := dbFiles["db/foundry_modules.json"]; ok {
		var mods []domain.FoundryModule
		if err := json.Unmarshal(raw, &mods); err != nil {
			return &domain.ValidationError{Msg: "битый db/foundry_modules.json в архиве"}
		}
		store := sqlite.NewFoundryModuleStore(m.db, companyID)
		for _, fm := range mods {
			if fm.ID == "" {
				continue
			}
			if err := store.Upsert(ctx, fm); err != nil {
				return err
			}
		}
	}
	return nil
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
