package app

// Экспорт/импорт одной сцены файлом .zip — чтобы приложить сцену к отчёту о
// баге и открыть её у себя один в один. В архив едут сцена (стены, токены,
// свет, туман, сетка) и, по флагу, только те загрузки мира, на которые она
// ссылается. Привязки к остальной кампании (аккаунты, персонажи, запись
// журнала, другие сцены и этажи) вычищаются: их в чужом мире нет, а
// личного там быть не должно.

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path"
	"regexp"
	"strings"
	"time"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository/scenefile"
)

const (
	scenePackFormat = "beacon-scene/v1"
	// maxScenePackBytes — сцена с видео-фоном 4K весит сотни мегабайт, но не
	// больше; выше — скорее не тот файл.
	maxScenePackBytes = 1 << 30
	maxSceneJSONBytes = 64 << 20
)

// sceneUploadRe — адрес загрузки в тексте сцены после замены префикса мира
// на worldUploadsSentinel; конец — кавычка JSON.
var sceneUploadRe = regexp.MustCompile(regexp.QuoteMeta(worldUploadsSentinel) + `[^"\\]+`)

// uploadNamePrefixRe — числовой префикс, который хранилище добавляет к имени
// файла (см. localfs.Store.Save); при повторной загрузке он добавится снова.
var uploadNamePrefixRe = regexp.MustCompile(`^\d+-`)

type sceneManifest struct {
	Format        string `json:"format"`
	BeaconVersion string `json:"beaconVersion"`
	ExportedAt    string `json:"exportedAt"`
	Scene         string `json:"scene"`
	Media         bool   `json:"media"`
}

// ScenePackName — имя файла экспорта сцены.
func ScenePackName(scene string) string {
	name := strings.Map(func(r rune) rune {
		if strings.ContainsRune(`/\:*?"<>|`, r) || r < ' ' {
			return '_'
		}
		return r
	}, strings.TrimSpace(scene))
	if name == "" {
		name = "scene"
	}
	return name + ".beacon-scene.zip"
}

// ExportScene пишет сцену sceneID запущенного мира в w. withMedia — класть
// ли файлы фона, токенов и звуков; без них архив весит килобайты, а для
// бага со светом и стенами картинки не нужны.
func (m *CompanyManager) ExportScene(ctx context.Context, sceneID, beaconVersion string, withMedia bool, w io.Writer) error {
	world := m.Current()
	if world == nil {
		return domain.ErrNotFound
	}
	scene, err := world.Room.SceneCopy(ctx, sceneID)
	if err != nil {
		return err
	}
	detachScene(scene)
	_, uploadsRoot, uploadsURL := m.rootsFor(world.Company)
	raw, err := json.MarshalIndent(scene, "", "  ")
	if err != nil {
		return err
	}
	text := strings.ReplaceAll(string(raw), uploadsURL, worldUploadsSentinel)

	zw := zip.NewWriter(w)
	add := func(name string, data []byte) error {
		fw, err := zw.Create(name)
		if err != nil {
			return err
		}
		_, err = fw.Write(data)
		return err
	}
	man, _ := json.MarshalIndent(sceneManifest{
		Format: scenePackFormat, BeaconVersion: beaconVersion,
		ExportedAt: time.Now().UTC().Format(time.RFC3339), Scene: scene.Name, Media: withMedia,
	}, "", "  ")
	if err := add("manifest.json", man); err != nil {
		return err
	}
	if err := add("scene.json", []byte(text)); err != nil {
		return err
	}
	if withMedia {
		seen := map[string]bool{}
		for _, u := range sceneUploadRe.FindAllString(text, -1) {
			rel := strings.TrimPrefix(u, worldUploadsSentinel)
			if seen[rel] {
				continue
			}
			seen[rel] = true
			if err := addUpload(zw, uploadsRoot, rel); err != nil {
				return err
			}
		}
	}
	if err := zw.Close(); err != nil {
		return err
	}
	return nil
}

// addUpload кладёт файл загрузок rel в архив; пропавший с диска файл
// пропускаем — сцена важнее картинки.
func addUpload(zw *zip.Writer, uploadsRoot, rel string) error {
	full, ok := safeJoin(uploadsRoot, rel)
	if !ok {
		return nil
	}
	//nolint:gosec // G304: путь проверен safeJoin — внутри uploadsRoot
	f, err := os.Open(full)
	if err != nil {
		return nil
	}
	defer func() { _ = f.Close() }()
	fw, err := zw.CreateHeader(&zip.FileHeader{Name: "uploads/" + rel, Method: zip.Store})
	if err != nil {
		return err
	}
	_, err = io.Copy(fw, f)
	return err
}

// detachScene вычищает из сцены ссылки на остальную кампанию.
func detachScene(s *domain.SceneState) {
	s.Building, s.Floor = "", 0
	s.PlayerAccess = false
	for _, t := range s.Tokens {
		t.OwnerID, t.CharacterID = "", ""
	}
	for _, d := range s.Drawings {
		d.AuthorID, d.AuthorName = "", ""
	}
	for _, n := range s.NoteMarkers {
		n.NoteID, n.Library, n.FoundryEntry, n.FoundryFolder = "", "", "", ""
	}
	for _, t := range s.Teleports {
		if !t.Local() {
			t.TargetSceneID, t.TargetTeleportID = "", ""
		}
	}
}

// ImportScene добавляет сцену из архива ExportScene в запущенный мир новой
// сценой (с новыми id) и возвращает её. Файлы из архива ложатся в
// загрузки мира; адреса, файлов к которым в архиве нет, обнуляются.
func (m *CompanyManager) ImportScene(ctx context.Context, acc *domain.Account, r io.ReaderAt, size int64) (*domain.SceneState, error) {
	world := m.Current()
	if world == nil {
		return nil, domain.ErrNotFound
	}
	if size > maxScenePackBytes {
		return nil, &domain.ValidationError{Msg: "файл сцены слишком большой"}
	}
	zr, err := zip.NewReader(r, size)
	if err != nil {
		return nil, &domain.ValidationError{Msg: "это не архив сцены Beacon Table"}
	}
	entries := map[string]*zip.File{}
	for _, f := range zr.File {
		entries[f.Name] = f
	}
	var man sceneManifest
	if f := entries["manifest.json"]; f != nil {
		if b, err := readZipEntry(f, maxWorldManifestBytes); err == nil {
			_ = json.Unmarshal(b, &man)
		}
	}
	if man.Format != scenePackFormat || entries["scene.json"] == nil {
		return nil, &domain.ValidationError{Msg: "это не экспорт сцены Beacon Table"}
	}
	raw, err := readZipEntry(entries["scene.json"], maxSceneJSONBytes)
	if err != nil {
		return nil, err
	}
	text := string(raw)

	budget := int64(maxScenePackBytes)
	uploaded := map[string]string{}
	var upErr error
	text = sceneUploadRe.ReplaceAllStringFunc(text, func(u string) string {
		rel := strings.TrimPrefix(u, worldUploadsSentinel)
		if url, ok := uploaded[rel]; ok || upErr != nil {
			return url
		}
		f := entries["uploads/"+rel]
		if f == nil {
			uploaded[rel] = ""
			return ""
		}
		data, err := readZipEntry(f, budget)
		if err != nil {
			upErr = err
			return ""
		}
		budget -= int64(len(data))
		url, err := uploadSceneFile(ctx, world, acc, rel, data)
		if err != nil {
			upErr = err
			return ""
		}
		uploaded[rel] = url
		return url
	})
	if upErr != nil {
		return nil, upErr
	}

	var scene domain.SceneState
	if err := json.Unmarshal([]byte(text), &scene); err != nil {
		return nil, &domain.ValidationError{Msg: "битый scene.json в архиве"}
	}
	detachScene(&scene)
	renewSceneIDs(&scene)
	scenefile.Sanitize(&scene)
	if _, err := world.Room.ImportScenes(ctx, []*domain.SceneState{&scene}); err != nil {
		return nil, err
	}
	if len(uploaded) > 0 {
		world.Room.NotifyLibraryChanged("assets")
	}
	return &scene, nil
}

// uploadSceneFile кладёт файл rel ("maps/123-карта.webp") в загрузки мира
// той же библиотеки; неизвестная библиотека — в декорации.
func uploadSceneFile(ctx context.Context, world *ActiveWorld, acc *domain.Account, rel string, data []byte) (string, error) {
	kind, rest, _ := strings.Cut(rel, "/")
	folder, name := path.Split(rest)
	folder = strings.Trim(folder, "/")
	known := false
	for _, k := range domain.AssetKinds {
		known = known || k == kind
	}
	if !known {
		kind, folder = domain.AssetKindProps, "Импорт сцены"
	} else if kind != domain.AssetKindProps {
		folder = "" // папки есть только у декораций
	}
	name = uploadNamePrefixRe.ReplaceAllString(name, "")
	if name == "" {
		return "", errors.New("пустое имя файла в архиве сцены")
	}
	return world.Assets.Upload(ctx, acc, kind, folder, name, bytes.NewReader(data))
}

// renewSceneIDs — новые id сцены, токенов и порталов: импорт той же сцены
// дважды не должен столкнуть их с уже существующими.
func renewSceneIDs(s *domain.SceneState) {
	s.ID = newID()
	tokens := make(map[string]*domain.Token, len(s.Tokens))
	for _, t := range s.Tokens {
		t.ID = newID()
		tokens[t.ID] = t
	}
	s.Tokens = tokens
	ids := map[string]string{}
	for _, t := range s.Teleports {
		ids[t.ID] = newID()
	}
	teleports := make(map[string]*domain.Teleport, len(s.Teleports))
	for _, t := range s.Teleports {
		t.ID = ids[t.ID]
		if t.TargetTeleportID != "" {
			t.TargetTeleportID = ids[t.TargetTeleportID]
		}
		teleports[t.ID] = t
	}
	s.Teleports = teleports
}
