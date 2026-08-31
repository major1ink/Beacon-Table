package service

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"beacon-table/internal/domain"
	"beacon-table/internal/foundry"
	"beacon-table/internal/repository"
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
// картинки. Исключение — сцены и плейлисты: у них клиентского маппера нет
// (сцена живёт в Room, плейлист — в своём сервисе), их сервер раскладывает
// сам, см. foundry.ServerSideTargets. Журналы посередине: текст заметки и её
// папку готовит сервер, а заводит клиент — потому что при совпадении с уже
// существующей заметкой спрашивать надо ДМ (см. FoundryImport.Notes).
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
	// Installed — пакеты, хотя бы раз импортированные в этот мир (см.
	// repository.FoundryModuleRepository), для раздела "Настройки". Чисто из
	// хранилища, без сети — сама проверка новой версии в CheckUpdates.
	Installed(ctx context.Context) ([]*domain.FoundryModule, error)
	// CheckUpdates — для каждого установленного пакета заново скачивает его
	// манифест (по сохранённой ManifestURL, обычно она указывает на
	// "latest") и сравнивает версию с той, что была на момент импорта.
	// Пакет, манифест которого не открылся, не роняет всю проверку — как и в
	// Inspect, ошибка одного не должна прятать результат по остальным.
	CheckUpdates(ctx context.Context) ([]FoundryModuleUpdate, error)
	// Delete сносит установленный пакет целиком: карточки (существа/
	// заклинания/предметы/справочник/состояния), помеченные его id (см.
	// domain.Monster.FoundryModuleID и соседей), файлы, скопированные его
	// импортом в библиотеку загрузок (папка "foundry/<id>" во всех разделах),
	// и саму запись об установке. Сцены, плейлисты и заметки, заведённые тем
	// же импортом, НЕ трогает — источник у них не помечается тем же id (см.
	// package doc: у них нет клиентского маппера, сервер заводит их сам, и
	// заметка/сцена — не «карточка каталога», а контент мира, который ДМ мог
	// уже отредактировать) — их удаляет ДМ вручную, как и любые другие.
	Delete(ctx context.Context, account *domain.Account, id string) (*FoundryModuleDelete, error)
	// LinkSceneTokens сводит токены, приехавшие со сценами модуля, с
	// карточками бестиария по id актёра Foundry (см.
	// domain.Token.FoundryActorID) и возвращает, скольким токенам связь
	// проставили.
	//
	// Отдельный шаг, а не часть ImportPack, потому что порядок импорта
	// заранее неизвестен: карточки существ заводит КЛИЕНТ и уже после того,
	// как ImportPack вернул документы (см. package doc выше), а пак со
	// сценами и пак с актёрами — вообще разные запросы, и приехать они могут
	// в любом порядке. Поэтому клиент зовёт это один раз, когда весь импорт
	// закончен (см. web/src/pages/foundry-import.js). Вызов идемпотентен:
	// уже связанные токены пропускаются, так что повторить его безвредно.
	LinkSceneTokens(ctx context.Context) (int, error)
}

// FoundryModuleDelete — что снесла "Удалить модуль" (см. FoundryService.Delete).
type FoundryModuleDelete struct {
	// Cards — сколько карточек удалено, по разделам (foundry.Target*: "items",
	// "spells", "monsters", "references", "conditions").
	Cards map[string]int `json:"cards"`
	// Warnings — что не удалось снести (карточка/папка не поддались) — не
	// останавливает удаление остального.
	Warnings []string `json:"warnings,omitempty"`
}

// FoundryModuleUpdate — результат проверки одного установленного пакета на
// новую версию (см. FoundryService.CheckUpdates).
type FoundryModuleUpdate struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	// InstalledVersion — версия, что была на момент последнего импорта (см.
	// domain.FoundryModule.Version).
	InstalledVersion string `json:"installedVersion"`
	// LatestVersion — версия из манифеста прямо сейчас; пусто, если манифест
	// не открылся (см. Error).
	LatestVersion string `json:"latestVersion,omitempty"`
	// UpdateAvailable — LatestVersion получена и отличается от
	// InstalledVersion. Само по себе не значит "новее" (версии пакетов
	// Foundry не всегда строгий semver, чтобы сравнивать по порядку), но
	// ManifestURL — это, как правило, ссылка на "latest" самого пакета, так
	// что расхождение с тем, что стояло на момент импорта, и есть повод
	// предложить ДМ обновиться.
	UpdateAvailable bool   `json:"updateAvailable"`
	Error           string `json:"error,omitempty"`
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
	// Notes — журналы, уже переведённые в текст заметок (картинки из архива
	// перенесены, папка вычислена), но ещё НЕ заведённые. Их раскладывает
	// клиент, а не сервер: заметка с таким же названием в той же папке может
	// уже существовать, и тогда решение — перезаписать, оставить обе или
	// пропустить — принимает ДМ (см. web/src/pages/foundry-import.js).
	Notes []FoundryNote `json:"notes,omitempty"`
	// Applied — что сервер завёл сам (сцены и плейлисты).
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

// FoundryNote — одна запись журнала, подготовленная импортом к заведению
// клиентом (см. web/src/pages/foundry-import.js: importNotes → журнал стола).
type FoundryNote struct {
	// Folder — папка журнала: «модуль / компендиум / папки модуля» (см.
	// foundry.NoteFolder).
	Folder  string `json:"folder"`
	Title   string `json:"title"`
	Content string `json:"content"`
}

type foundryService struct {
	cache     *foundry.Cache
	assets    AssetService
	room      RoomService
	playlists PlaylistService
	// modules — установленные пакеты этого мира: список для раздела
	// "Настройки" и запись после каждого успешного ImportPack (см.
	// Installed/CheckUpdates ниже).
	modules repository.FoundryModuleRepository

	// bestiary/spells/items/references/conditions — для Delete: найти и
	// снести карточки, помеченные FoundryModuleID удаляемого пакета (см.
	// package doc Delete). Импорту они не нужны — тот создаёт карточки не
	// здесь, а через клиента (см. package-doc FoundryService); исключение —
	// bestiary, его читает ещё и LinkSceneTokens.
	bestiary   BestiaryService
	spells     SpellService
	items      ItemService
	references ReferenceService
	conditions ConditionService
	// pregens — только для Delete: снести пул-записи «готовых персонажей»
	// этого модуля (созданных из них персонажей игроков это не касается,
	// см. sqlite.PregenStore.DeleteBySource). Импорт складывает пре-генов
	// через клиента, как и остальные карточки.
	pregens repository.PregenRepository

	// links — индекс перекрёстных ссылок модуля (см. foundry.LinkIndex),
	// ключ — папка распакованного модуля. Строится обходом ВСЕХ паков, а
	// импорт идёт пак за паком — без кэша каждый пак перечитывал бы весь
	// модуль заново.
	linksMu sync.Mutex
	links   map[string]*foundry.LinkIndex
}

// foundryHTTPTimeout — потолок на скачивание манифеста и архива. Модуль с
// картами тянется долго даже на быстром канале, но час — это уже висящее
// соединение, а не медленная загрузка.
const foundryHTTPTimeout = time.Hour

// roomImportTimeout — сколько ждём, пока комната примет импортированные
// сцены (см. RoomService.ImportScenes).
const roomImportTimeout = 30 * time.Second

// NewFoundryService — cacheDir: папка под скачанные архивы (чистится по TTL
// самим кэшем, см. foundry.Cache). modules — где запоминаются установленные
// пакеты этого мира (см. Installed/CheckUpdates). bestiary/spells/items/
// references/conditions — те же сервисы этого мира, нужны только Delete
// (см. её комментарий).
// allowPrivateNetwork — пускать ли импорт в приватные диапазоны сети (см.
// foundry.GuardedTransport). Для сервера в интернете — нет; для локальной
// установки — да, там законно тянуть модуль с соседней машины.
func NewFoundryService(
	cacheDir string,
	assets AssetService, room RoomService, playlists PlaylistService, modules repository.FoundryModuleRepository,
	bestiary BestiaryService, spells SpellService, items ItemService, references ReferenceService, conditions ConditionService,
	pregens repository.PregenRepository,
	allowPrivateNetwork bool,
) FoundryService {
	client := &http.Client{
		Timeout:   foundryHTTPTimeout,
		Transport: foundry.GuardedTransport(allowPrivateNetwork),
		// Редиректы транспорт проверяет тем же дозвоном, что и первый запрос
		// (см. GuardedTransport); тут только предел на их число, чтобы цепочка
		// перенаправлений не съедала часовой таймаут.
		CheckRedirect: func(_ *http.Request, via []*http.Request) error {
			if len(via) >= 8 {
				return fmt.Errorf("слишком много перенаправлений")
			}
			return nil
		},
	}
	return &foundryService{
		cache:      foundry.NewCache(cacheDir, client),
		assets:     assets,
		room:       room,
		playlists:  playlists,
		modules:    modules,
		bestiary:   bestiary,
		spells:     spells,
		items:      items,
		references: references,
		conditions: conditions,
		pregens:    pregens,
		links:      map[string]*foundry.LinkIndex{},
	}
}

// linkIndex — индекс перекрёстных ссылок этого модуля, с кэшем по папке
// распаковки (кэш модуля живёт два часа, см. foundry.Cache — индекс живёт
// столько же, сколько процесс, и это тот же порядок).
func (s *foundryService) linkIndex(mod *foundry.Module, moduleTitle string) *foundry.LinkIndex {
	s.linksMu.Lock()
	defer s.linksMu.Unlock()
	if ix, ok := s.links[mod.Dir]; ok {
		return ix
	}
	ix := foundry.BuildLinkIndex(mod, moduleTitle)
	s.links[mod.Dir] = ix
	return ix
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
		contents, err := mod.ReadPack(p)
		if err != nil {
			info.Error = err.Error()
			out.Packs = append(out.Packs, info)
			continue
		}
		for _, e := range foundry.Expand(contents.Docs, p.DocType()) {
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
	contents, err := mod.ReadPack(pack)
	if err != nil {
		return nil, &domain.ValidationError{Msg: err.Error()}
	}

	packageID := mod.Manifest.PackageID()
	moduleTitle := mod.Manifest.DisplayTitle()
	moduleVersion := mod.Manifest.Version
	if mod.ArchiveManifest != nil && mod.ArchiveManifest.PackageID() != "" {
		packageID = mod.ArchiveManifest.PackageID()
		moduleTitle = mod.ArchiveManifest.DisplayTitle()
	}
	// Версия — из архива, если она там есть: это версия того, что реально
	// распаковано и импортируется, манифест по ссылке (обычно "latest")
	// иногда успевает уйти вперёд между "скачали" и "распаковали".
	if mod.ArchiveManifest != nil && mod.ArchiveManifest.Version != "" {
		moduleVersion = mod.ArchiveManifest.Version
	}
	packLabel := pack.Label
	if packLabel == "" {
		packLabel = pack.Name
	}
	assets := foundry.NewAssets(mod, &assetSaver{assets: s.assets, account: account}, "foundry/"+sanitizeFolderName(packageID))
	// Ссылки внутри текстов («см. @UUID[…]{Перемещение через существ}») —
	// на документы этого же модуля: переводим их в ссылки Beacon Table, пока
	// известно, что куда едет (см. foundry.LinkIndex).
	links := s.linkIndex(mod, moduleTitle)

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
	for _, e := range foundry.Expand(contents.Docs, pack.DocType()) {
		if e.Target == foundry.TargetSkipped || (len(wanted) > 0 && !wanted[e.Target]) {
			result.Skipped++
			continue
		}
		switch e.Target {
		case foundry.TargetScenes:
			scenes = append(scenes, foundry.MapScene(ctx, e.Doc, assets, links))
		case foundry.TargetPlaylists:
			if err := s.applyPlaylist(ctx, foundry.MapPlaylist(ctx, e.Doc, assets)); err != nil {
				result.Warnings = appendWarning(result.Warnings, err.Error())
				continue
			}
			result.Applied[foundry.TargetPlaylists]++
		case foundry.TargetNotes:
			// Папка журнала в модуле → папка библиотеки заметок. Сама
			// заметка тут не создаётся: см. FoundryImport.Notes.
			folder := foundry.NoteFolder(moduleTitle, packLabel, contents.Folders.Path(foundry.DocFolderID(e.Doc)))
			journal := foundry.MapJournal(ctx, e.Doc, folder, assets)
			result.Notes = append(result.Notes, FoundryNote{
				Folder:  journal.Folder,
				Title:   journal.Title,
				Content: links.Rewrite(journal.Content),
			})
		default:
			assets.RewriteDoc(ctx, e.Doc)
			foundry.RewriteDocMacros(e.Doc, links)
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
	if result.Applied[foundry.TargetPlaylists] > 0 {
		// Панель "Плейлисты" (см. web/src/pages/dm.js), если уже открыта в
		// другой вкладке ДМ, сама перечитает список — без этого новые
		// плейлисты появлялись бы только после ручной перезагрузки страницы.
		s.room.NotifyPlaylistsChanged()
	}
	result.Assets = assets.Count()
	result.AssetsMissing = assets.Missing

	// Запоминаем пакет как установленный — после успешного импорта пака, а
	// не только разведки (Inspect ничего не пишет: ДМ мог посмотреть и
	// передумать). Промах здесь не должен ронять уже сделанный импорт —
	// только предупреждает: список установленного в настройках останется
	// неполным, но карточки/сцены/заметки этого пака уже на месте.
	if err := s.modules.Upsert(ctx, domain.FoundryModule{
		ID:          packageID,
		Title:       moduleTitle,
		Version:     moduleVersion,
		ManifestURL: strings.TrimSpace(manifestURL),
		ImportedAt:  time.Now(),
	}); err != nil {
		result.Warnings = appendWarning(result.Warnings, "не удалось запомнить установленный пакет: "+err.Error())
	}
	return result, nil
}

// Installed implements FoundryService.
func (s *foundryService) Installed(ctx context.Context) ([]*domain.FoundryModule, error) {
	return s.modules.List(ctx)
}

// checkUpdateConcurrency — сколько манифестов проверяем одновременно.
// Установленных пакетов у одного ДМ обычно единицы-десятки — потолок здесь
// не про throughput, а про то, чтобы не открыть сходу полсотни соединений на
// чужие сайты одним кликом по "Проверить обновления".
const checkUpdateConcurrency = 4

// CheckUpdates implements FoundryService.
func (s *foundryService) CheckUpdates(ctx context.Context) ([]FoundryModuleUpdate, error) {
	installed, err := s.modules.List(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]FoundryModuleUpdate, len(installed))
	sem := make(chan struct{}, checkUpdateConcurrency)
	var wg sync.WaitGroup
	for i, m := range installed {
		i, m := i, m
		out[i] = FoundryModuleUpdate{ID: m.ID, Title: m.Title, InstalledVersion: m.Version}
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			man, err := s.cache.Manifest(ctx, m.ManifestURL)
			if err != nil {
				out[i].Error = err.Error()
				return
			}
			out[i].LatestVersion = man.Version
			out[i].UpdateAvailable = man.Version != "" && man.Version != m.Version
		}()
	}
	wg.Wait()
	return out, nil
}

// deletableAssetKinds — разделы библиотеки загрузок, куда импорт модуля
// вообще кладёт файлы (см. internal/foundry: assets.go/scene.go/journal.go/
// playlist.go) — kind "props" импорт не использует, чистить его незачем.
var deletableAssetKinds = []string{domain.AssetKindMaps, domain.AssetKindTokens, domain.AssetKindAudio, domain.AssetKindNotes}

// Delete implements FoundryService.
func (s *foundryService) Delete(ctx context.Context, account *domain.Account, id string) (*FoundryModuleDelete, error) {
	// ByID — не только чтобы отдать 404 на чужой/неизвестный id (см.
	// handleFoundryModuleDelete), но и источник правды, что "foundry/<id>"
	// вообще стоило чистить: сама папка строится из id ниже.
	if _, err := s.modules.ByID(ctx, id); err != nil {
		return nil, err
	}

	result := &FoundryModuleDelete{Cards: map[string]int{}}

	// Карточки — только те, что заведены/перезаписаны ИМЕННО этим импортом
	// (см. domain.Monster.FoundryModuleID и соседей): ручная правка карточки
	// после импорта сохраняет отметку (Update целиком перезаписывает
	// карточку, включая это поле, тем же значением, что пришло) — снести
	// такую карточку тоже, раз она всё ещё числится за модулем, это осознанно
	// выбранное поведение, а не недосмотр.
	type cardSet struct {
		target string
		list   func(ctx context.Context) ([]string, error) // id карточек этого модуля
		del    func(ctx context.Context, id string) error
	}
	sets := []cardSet{
		{foundry.TargetMonsters, func(ctx context.Context) ([]string, error) { return matchingMonsters(ctx, s.bestiary, id) }, s.bestiary.Delete},
		{foundry.TargetSpells, func(ctx context.Context) ([]string, error) { return matchingSpells(ctx, s.spells, id) }, s.spells.Delete},
		{foundry.TargetItems, func(ctx context.Context) ([]string, error) { return matchingItems(ctx, s.items, id) }, s.items.Delete},
		{foundry.TargetReferences, func(ctx context.Context) ([]string, error) { return matchingReferences(ctx, s.references, id) }, s.references.Delete},
		{foundry.TargetConditions, func(ctx context.Context) ([]string, error) { return matchingConditions(ctx, s.conditions, id) }, s.conditions.Delete},
	}
	for _, set := range sets {
		ids, err := set.list(ctx)
		if err != nil {
			result.Warnings = appendWarning(result.Warnings, fmt.Sprintf("%s: не удалось прочитать библиотеку — %s", set.target, err.Error()))
			continue
		}
		for _, cardID := range ids {
			if err := set.del(ctx, cardID); err != nil {
				result.Warnings = appendWarning(result.Warnings, fmt.Sprintf("%s %s: %s", set.target, cardID, err.Error()))
				continue
			}
			result.Cards[set.target]++
		}
	}

	// Пул «готовых персонажей» этого модуля — одним запросом (в отличие от
	// карточек выше, у пре-генов нет отдельного сервиса с List/Delete).
	// Персонажей игроков, уже созданных захватом пре-генов, это не касается —
	// они живут отдельными строками characters (см. domain.Pregen).
	if n, err := s.pregens.DeleteBySource(ctx, id); err != nil {
		result.Warnings = appendWarning(result.Warnings, fmt.Sprintf("%s: %s", foundry.TargetPregens, err.Error()))
	} else if n > 0 {
		result.Cards[foundry.TargetPregens] = n
	}

	// Файлы — вся папка "foundry/<id>" во всех разделах, куда импорт вообще
	// пишет (см. deletableAssetKinds); DeleteFolder молча ничего не делает,
	// если в этом разделе для модуля папки не было (os.RemoveAll на
	// несуществующий путь — не ошибка), так что звать его для всех разделов
	// разом дешевле, чем сперва проверять, что там реально лежало.
	folder := "foundry/" + sanitizeFolderName(id)
	for _, kind := range deletableAssetKinds {
		if err := s.assets.DeleteFolder(ctx, account, kind, folder); err != nil {
			result.Warnings = appendWarning(result.Warnings, fmt.Sprintf("файлы (%s): %s", kind, err.Error()))
		}
	}

	if err := s.modules.Delete(ctx, id); err != nil {
		result.Warnings = appendWarning(result.Warnings, "запись об установке не удалилась: "+err.Error())
	}
	return result, nil
}

// LinkSceneTokens — см. FoundryService. Ключ карты — Monster.FoundryActorID;
// карточки без него (заведённые руками или импортом одиночного файла)
// просто не участвуют, и ни один токен на них не сошлётся.
//
// Дубликат id актёра в бестиарии (одного и того же монстра импортировали
// дважды — например, ДМ переустановил модуль поверх, выбрав "создать новую"
// вместо "перезаписать") разрешается в пользу ПЕРВОЙ карточки: выбор всё
// равно произволен, а стабильность важнее — повторный запуск связывания не
// должен раз за разом перекидывать токены между копиями.
func (s *foundryService) LinkSceneTokens(ctx context.Context) (int, error) {
	monsters, err := s.bestiary.List(ctx)
	if err != nil {
		return 0, err
	}
	byActor := make(map[string]string, len(monsters))
	for _, m := range monsters {
		if m == nil || m.FoundryActorID == "" {
			continue
		}
		if _, exists := byActor[m.FoundryActorID]; exists {
			continue
		}
		byActor[m.FoundryActorID] = m.ID
	}
	if len(byActor) == 0 {
		return 0, nil
	}
	// Тот же таймаут и по той же причине, что у ImportScenes выше: комнату
	// могло погасить переключение мира, её горутина тогда не читает канал.
	roomCtx, cancel := context.WithTimeout(ctx, roomImportTimeout)
	defer cancel()
	return s.room.LinkTokensToMonsters(roomCtx, byActor)
}

// matchingMonsters/matchingSpells/matchingItems/matchingReferences/
// matchingConditions — id карточек библиотеки, помеченных moduleID (см.
// Delete выше). Карточки каталога «из коробки» в отметке не нуждаются: у
// них System=true и FoundryModuleID всегда пусто (проставляется только
// клиентским импортом, см. web/src/pages/foundry-import.js), так что
// отдельно исключать их незачем — фильтр по непустому совпадению их и так
// не заденет.
func matchingMonsters(ctx context.Context, svc BestiaryService, moduleID string) ([]string, error) {
	all, err := svc.List(ctx)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, x := range all {
		if x.FoundryModuleID == moduleID {
			out = append(out, x.ID)
		}
	}
	return out, nil
}

func matchingSpells(ctx context.Context, svc SpellService, moduleID string) ([]string, error) {
	all, err := svc.List(ctx)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, x := range all {
		if x.FoundryModuleID == moduleID {
			out = append(out, x.ID)
		}
	}
	return out, nil
}

func matchingItems(ctx context.Context, svc ItemService, moduleID string) ([]string, error) {
	all, err := svc.List(ctx)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, x := range all {
		if x.FoundryModuleID == moduleID {
			out = append(out, x.ID)
		}
	}
	return out, nil
}

func matchingReferences(ctx context.Context, svc ReferenceService, moduleID string) ([]string, error) {
	all, err := svc.List(ctx)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, x := range all {
		if x.FoundryModuleID == moduleID {
			out = append(out, x.ID)
		}
	}
	return out, nil
}

func matchingConditions(ctx context.Context, svc ConditionService, moduleID string) ([]string, error) {
	all, err := svc.List(ctx)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, x := range all {
		if x.FoundryModuleID == moduleID {
			out = append(out, x.ID)
		}
	}
	return out, nil
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
//
// Плюс к переходнику — узнаёт уже перенесённые файлы: имя файла импорт
// строит из хэша пути внутри модуля (см. foundry.assetFileName), так что
// повторный импорт того же модуля не копирует картинки заново и, главное,
// отдаёт на них ТЕ ЖЕ ссылки. Иначе каждая заметка/карточка с картинкой
// после второго импорта выглядела бы изменившейся (см. importNotes на
// клиенте: сравнение содержимого).
type assetSaver struct {
	assets  AssetService
	account *domain.Account

	// known — "kind/папка/имя" → ссылка; строится один раз при первом
	// сохранении из библиотеки загрузок этого мира.
	known map[string]string
}

func (s *assetSaver) Save(ctx context.Context, kind, folder, filename string, r io.Reader) (string, error) {
	if err := s.index(ctx); err != nil {
		return "", err
	}
	key := kind + "/" + folder + "/" + filename
	if url, ok := s.known[key]; ok {
		return url, nil // такой файл из этого модуля уже переносили
	}
	url, err := s.assets.Upload(ctx, s.account, kind, folder, filename, r)
	if err != nil {
		return "", err
	}
	s.known[key] = url
	return url, nil
}

func (s *assetSaver) index(ctx context.Context) error {
	if s.known != nil {
		return nil
	}
	s.known = map[string]string{}
	all, err := s.assets.List(ctx)
	if err != nil {
		return err
	}
	for kind, items := range all {
		for _, item := range items {
			s.known[kind+"/"+item.Path+"/"+item.Name] = item.URL
		}
	}
	return nil
}
