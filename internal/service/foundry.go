package service

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"beacon-table/internal/domain"
	"beacon-table/internal/foundry"
)

// FoundryService — импорт компендиумов из пакетов Foundry VTT по ссылке на
// манифест: скачать module.json, забрать архив, распаковать и разложить
// содержимое по разделам стола.
//
// Разделение труда с клиентом ровно то же, что и у импорта одиночного файла
// (см. web/src/item-import.js и соседей): формат карточек dnd5e разбирает
// клиент, сервер о нём по-прежнему ничего не знает — он достаёт документы из
// чужого контейнера (LevelDB/NeDB/JSON), переносит файлы из архива в
// библиотеку загрузок и отдаёт документы клиенту уже с нашими ссылками на
// картинки. Исключение — сцены, плейлисты и заметки: у них клиентского
// маппера нет (сцена живёт в Room, плейлист и заметка — в своих сервисах),
// их сервер раскладывает сам, см. foundry.ServerSideTargets.
type FoundryService interface {
	// Inspect — что за пакет по ссылке и что в нём лежит: список паков с
	// количеством документов по разделам. Архив при этом уже скачивается и
	// распаковывается (посчитать документы иначе нельзя) и остаётся в кэше,
	// поэтому последующие Import по тем же ссылкам идут без сети.
	Inspect(ctx context.Context, manifestURL string) (*FoundryPackage, error)
	// ImportPack — импорт ОДНОГО пака. Клиент идёт пак за паком, а не
	// одним запросом на весь модуль: так виден прогресс, а ответ (документы
	// на маппинг) не разрастается до сотен мегабайт.
	//
	// targets ограничивает разделы, в которые импортируем ("items",
	// "spells", ... см. foundry.Target*); пустой список — все.
	ImportPack(ctx context.Context, account *domain.Account, manifestURL, packName string, targets []string) (*FoundryImport, error)
}

// FoundryPackage — результат разведки: сам пакет и его компендиумы.
type FoundryPackage struct {
	ID       string        `json:"id"`
	Title    string        `json:"title"`
	Version  string        `json:"version"`
	Download string        `json:"download"`
	Packs    []FoundryPack `json:"packs"`
}

// FoundryPack — один компендиум глазами разведки.
type FoundryPack struct {
	Name   string `json:"name"`
	Label  string `json:"label"`
	Type   string `json:"type"`
	System string `json:"system,omitempty"`
	Count  int    `json:"count"`
	// Targets — сколько документов пака в какой раздел поедет (ключи —
	// foundry.Target*). Пак Foundry типа "Item" обычно разъезжается сразу по
	// нескольким, поэтому число, а не один ярлык.
	Targets map[string]int `json:"targets"`
	// Error — пак не прочитался (нет в архиве, битый формат). Не роняет всю
	// разведку: остальные паки импортировать это не мешает.
	Error string `json:"error,omitempty"`
}

// FoundryImport — результат импорта одного пака.
type FoundryImport struct {
	Pack string `json:"pack"`
	// Docs — документы для клиентских мапперов, по разделам: "items",
	// "spells", "monsters", "references", "conditions".
	Docs map[string][]foundry.Doc `json:"docs"`
	// Applied — что сервер завёл сам (сцены/плейлисты/заметки).
	Applied map[string]int `json:"applied"`
	// Skipped — документы, которым в Beacon Table места нет (таблицы,
	// макросы, колоды) или которые отсеяны выбором разделов.
	Skipped int `json:"skipped"`
	// Assets — сколько файлов перенесено из архива в библиотеку загрузок.
	Assets int `json:"assets"`
	// AssetsMissing — сколько ссылок на файлы вело в никуда. Это норма, а не
	// поломка: официальные компендиумы ссылаются иконками на ассеты самого
	// Foundry ("icons/magic/…"), которых в архиве модуля нет и быть не
	// может. Показываем числом, чтобы «карточки без картинок» не выглядели
	// сбоем импорта.
	AssetsMissing int `json:"assetsMissing"`
	// Warnings — что пошло не так, но не остановило импорт.
	Warnings []string `json:"warnings,omitempty"`
}

type foundryService struct {
	cache     *foundry.Cache
	assets    AssetService
	room      RoomService
	playlists PlaylistService
	notes     NoteService
}

// foundryHTTPTimeout — потолок на скачивание манифеста и архива. Модуль с
// картами тянется долго даже на быстром канале, но час — это уже висящее
// соединение, а не медленная загрузка.
const foundryHTTPTimeout = time.Hour

// roomImportTimeout — сколько ждём, пока комната примет импортированные
// сцены (см. RoomService.ImportScenes).
const roomImportTimeout = 30 * time.Second

// NewFoundryService — cacheDir: папка под скачанные архивы (чистится по TTL
// самим кэшем, см. foundry.Cache).
func NewFoundryService(cacheDir string, assets AssetService, room RoomService, playlists PlaylistService, notes NoteService) FoundryService {
	client := &http.Client{Timeout: foundryHTTPTimeout}
	return &foundryService{
		cache:     foundry.NewCache(cacheDir, client),
		assets:    assets,
		room:      room,
		playlists: playlists,
		notes:     notes,
	}
}

func (s *foundryService) Inspect(ctx context.Context, manifestURL string) (*FoundryPackage, error) {
	mod, err := s.cache.Module(ctx, strings.TrimSpace(manifestURL))
	if err != nil {
		return nil, &domain.ValidationError{Msg: err.Error()}
	}
	man := mod.Manifest
	if mod.ArchiveManifest != nil {
		man = mod.ArchiveManifest
	}
	out := &FoundryPackage{
		ID:       man.PackageID(),
		Title:    man.DisplayTitle(),
		Version:  man.Version,
		Download: mod.Manifest.Download,
	}
	for _, p := range mod.Packs() {
		info := FoundryPack{Name: p.Name, Label: p.Label, Type: p.DocType(), System: p.System, Targets: map[string]int{}}
		if info.Label == "" {
			info.Label = p.Name
		}
		docs, err := mod.ReadPack(p)
		if err != nil {
			info.Error = err.Error()
			out.Packs = append(out.Packs, info)
			continue
		}
		for _, e := range foundry.Expand(docs, p.DocType()) {
			info.Count++
			info.Targets[e.Target]++
		}
		out.Packs = append(out.Packs, info)
	}
	return out, nil
}

func (s *foundryService) ImportPack(ctx context.Context, account *domain.Account, manifestURL, packName string, targets []string) (*FoundryImport, error) {
	mod, err := s.cache.Module(ctx, strings.TrimSpace(manifestURL))
	if err != nil {
		return nil, &domain.ValidationError{Msg: err.Error()}
	}
	pack, ok := findPack(mod.Packs(), packName)
	if !ok {
		return nil, &domain.ValidationError{Msg: fmt.Sprintf("пака «%s» в этом модуле нет", packName)}
	}
	docs, err := mod.ReadPack(pack)
	if err != nil {
		return nil, &domain.ValidationError{Msg: err.Error()}
	}

	packageID := mod.Manifest.PackageID()
	if mod.ArchiveManifest != nil && mod.ArchiveManifest.PackageID() != "" {
		packageID = mod.ArchiveManifest.PackageID()
	}
	assets := foundry.NewAssets(mod, assetSaver{assets: s.assets, account: account}, "foundry/"+sanitizeFolderName(packageID))

	wanted := make(map[string]bool, len(targets))
	for _, t := range targets {
		wanted[t] = true
	}
	result := &FoundryImport{
		Pack:    pack.Name,
		Docs:    map[string][]foundry.Doc{},
		Applied: map[string]int{},
	}

	scenes := make([]*domain.SceneState, 0, 8)
	for _, e := range foundry.Expand(docs, pack.DocType()) {
		if e.Target == foundry.TargetSkipped || (len(wanted) > 0 && !wanted[e.Target]) {
			result.Skipped++
			continue
		}
		switch e.Target {
		case foundry.TargetScenes:
			scenes = append(scenes, foundry.MapScene(ctx, e.Doc, assets))
		case foundry.TargetPlaylists:
			if err := s.applyPlaylist(ctx, foundry.MapPlaylist(ctx, e.Doc, assets)); err != nil {
				result.Warnings = appendWarning(result.Warnings, err.Error())
				continue
			}
			result.Applied[foundry.TargetPlaylists]++
		case foundry.TargetNotes:
			if _, err := s.notes.Create(ctx, foundry.MapJournal(ctx, e.Doc, assets)); err != nil {
				result.Warnings = appendWarning(result.Warnings, err.Error())
				continue
			}
			result.Applied[foundry.TargetNotes]++
		default:
			assets.RewriteDoc(ctx, e.Doc)
			result.Docs[e.Target] = append(result.Docs[e.Target], e.Doc)
		}
	}
	if len(scenes) > 0 {
		// Таймаут — не про скорость вставки (она мгновенная), а про случай,
		// когда комнату уже погасило переключение мира посреди импорта: её
		// горутина не читает канал, и без ограничения ждать пришлось бы до
		// разрыва соединения клиентом.
		roomCtx, cancel := context.WithTimeout(ctx, roomImportTimeout)
		added, err := s.room.ImportScenes(roomCtx, scenes)
		cancel()
		if err != nil {
			result.Warnings = appendWarning(result.Warnings, "сцены не добавились: "+err.Error())
		}
		result.Applied[foundry.TargetScenes] = added
	}
	result.Assets = assets.Count()
	result.AssetsMissing = assets.Missing
	return result, nil
}

// applyPlaylist заводит плейлист и его треки через обычный PlaylistService —
// импорт не лезет в хранилище мимо сервиса, как и любой другой вызывающий.
func (s *foundryService) applyPlaylist(ctx context.Context, p *foundry.Playlist) error {
	if p == nil || len(p.Tracks) == 0 {
		return nil
	}
	created, err := s.playlists.Create(ctx, p.Name)
	if err != nil {
		return fmt.Errorf("плейлист «%s»: %w", p.Name, err)
	}
	for _, t := range p.Tracks {
		if _, err := s.playlists.AddTrack(ctx, created.ID, t.URL, t.Name, t.Volume, t.Loop); err != nil {
			return fmt.Errorf("трек «%s»: %w", t.Name, err)
		}
	}
	return nil
}

func findPack(packs []foundry.Pack, name string) (foundry.Pack, bool) {
	for _, p := range packs {
		if p.Name == name {
			return p, true
		}
	}
	return foundry.Pack{}, false
}

// maxImportWarnings — сколько предупреждений доезжает до ДМ. Если пак сыплет
// ошибками на каждом документе, первых двух десятков достаточно, чтобы
// понять причину, а ответ не превращается в лог.
const maxImportWarnings = 20

func appendWarning(warnings []string, msg string) []string {
	if len(warnings) >= maxImportWarnings {
		return warnings
	}
	return append(warnings, msg)
}

// sanitizeFolderName — имя подпапки библиотеки загрузок из id модуля.
// localfs сам отклоняет ".." и пустые сегменты (см. sanitizeFolder), но id
// модуля вообще не обязан быть именем файла — оставляем только безопасное.
func sanitizeFolderName(id string) string {
	clean := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			return r
		default:
			return '-'
		}
	}, id)
	clean = strings.Trim(clean, "-")
	if clean == "" {
		return "module"
	}
	return clampRunes(clean, 60)
}

// assetSaver — переходник между foundry.AssetStore (один метод, ничего не
// знает про аккаунты) и AssetService (проверяет право грузить в этот раздел
// библиотеки). Импорт делает ДМ, так что проверка всегда проходит, но идти
// мимо сервиса ради этого незачем.
type assetSaver struct {
	assets  AssetService
	account *domain.Account
}

func (s assetSaver) Save(ctx context.Context, kind, folder, filename string, r io.Reader) (string, error) {
	return s.assets.Upload(ctx, s.account, kind, folder, filename, r)
}
