// Package scenefile реализует repository.SceneRepository поверх JSON-файлов
package scenefile

import (
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"log"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"beacon-table/internal/domain"
)

// Store реализует repository.SceneRepository. dataDir — корневая папка
// данных приложения (по умолчанию "data"), внутри неё живут scenes/,
// room.json и migrations/.
type Store struct {
	dataDir       string
	scenesDir     string
	roomMetaFile  string
	combatFile    string // трекер инициативы, отдельный файл — не привязан к конкретной сцене (см. domain.CombatState)
	hubFile       string // хаб лута ДМ, отдельный файл — тот же принцип, что combatFile (см. domain.LootHub)
	legacyFile    string // формат до перехода на файл-на-карту — только для миграции
	migrationsDir string // сюда складываются файлы, отработавшие своё при миграциях формата
}

// NewStore создаёт репозиторий сцен с данными в dataDir/{scenes,room.json,...}.
func NewStore(dataDir string) *Store {
	return &Store{
		dataDir:       dataDir,
		scenesDir:     filepath.Join(dataDir, "scenes"),
		roomMetaFile:  filepath.Join(dataDir, "room.json"),
		combatFile:    filepath.Join(dataDir, "combat.json"),
		hubFile:       filepath.Join(dataDir, "hub.json"),
		legacyFile:    filepath.Join(dataDir, "scene.json"),
		migrationsDir: filepath.Join(dataDir, "migrations"),
	}
}

// roomMeta — единственное, что нужно хранить сверх самих сцен: какая из них
// открыта сейчас и в каком порядке они идут в переключателе DM. CurrentMap —
// легаси-поле для чтения room.json, сохранённого до перехода на сцены как
// самостоятельные сущности.
type roomMeta struct {
	CurrentSceneID string   `json:"currentSceneId,omitempty"`
	SceneOrder     []string `json:"sceneOrder,omitempty"`
	CurrentMap     string   `json:"currentMap,omitempty"`
}

var unsafeFileChars = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

func fnvHash(s string) uint32 {
	h := fnv.New32a()
	h.Write([]byte(s))
	return h.Sum32()
}

// sceneFileName — имя файла на диске для сцены по её ID. ID уже
// filesystem-safe (генерируется в виде "scene-<...>")
func sceneFileName(id string) string {
	safe := unsafeFileChars.ReplaceAllString(id, "_")
	if safe == "" {
		safe = "scene"
	}
	return safe + ".json"
}

// deriveSceneName подбирает человекочитаемое имя для сцены, у которой его
// ещё нет (миграция со старого формата, где сцены не имели имени вообще) —
// из URL карты, отрезая "<unixnano>-" префикс загрузки.
func deriveSceneName(mapURL string) string {
	if mapURL == "" {
		return "Без названия"
	}
	name := path.Base(mapURL)
	if idx := strings.Index(name, "-"); idx != -1 && idx+1 < len(name) {
		name = name[idx+1:]
	}
	return name
}

// finalizeLoadedScene закрепляет id/имя за сценой, прочитанной с диска (или
// мигрированной из легаси-формата), если их там ещё нет, и прогоняет её
// через sanitizeScene. fallbackID — то, что становится ID, если в самом
// файле поле "id" отсутствует (обычно — имя файла без расширения).
func finalizeLoadedScene(s *domain.SceneState, fallbackID string) {
	if s.ID == "" {
		s.ID = fallbackID
	}
	if s.Name == "" {
		s.Name = deriveSceneName(s.MapURL)
	}
	sanitizeScene(s)
}

// Load implements repository.SceneRepository. Сканирует scenesDir (по файлу
// на сцену) плюс roomMetaFile (какая активна и в каком порядке). Если
// вместо новой раскладки на диске всё ещё старый однофайловый формат —
// мигрирует его перед чтением. Битый/нечитаемый файл ОДНОЙ сцены не роняет
// загрузку остальных — теряется максимум одна сцена, а не вся библиотека.
func (s *Store) Load(ctx context.Context) (*domain.RoomSnapshot, error) {
	if rs := s.migrateLegacyIfNeeded(); rs != nil {
		return rs, nil
	}

	scenes := make(map[string]*domain.SceneState)
	var diskOrder []string

	entries, err := os.ReadDir(s.scenesDir)
	if err != nil && !os.IsNotExist(err) {
		log.Println("не удалось прочитать папку сцен, начинаю с пустой библиотеки:", err)
	}
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		p := filepath.Join(s.scenesDir, e.Name())
		//nolint:gosec // G304: e.Name() — имя файла из os.ReadDir(s.scenesDir)
		data, err := os.ReadFile(p)
		if err != nil {
			log.Println("не удалось прочитать сцену, пропускаю:", p, err)
			continue
		}
		sc := &domain.SceneState{}
		if err := json.Unmarshal(data, sc); err != nil {
			log.Println("сцена повреждена, пропускаю:", p, err)
			continue
		}
		stem := strings.TrimSuffix(e.Name(), ".json")
		needsResave := sc.ID == "" // старый файл без id/name — раньше сцена была равна URL карты
		finalizeLoadedScene(sc, stem)
		if needsResave {
			if err := s.SaveScene(ctx, sc.ID, sc); err != nil {
				log.Println("не удалось пересохранить мигрированную сцену:", sc.ID, err)
			}
		}
		scenes[sc.ID] = sc
		diskOrder = append(diskOrder, sc.ID)
	}

	var meta roomMeta
	if data, err := os.ReadFile(s.roomMetaFile); err == nil {
		if err := json.Unmarshal(data, &meta); err != nil {
			log.Println("не удалось разобрать room.json:", err)
		}
	}

	if len(scenes) == 0 {
		sc := domain.NewScene("scene-default", "Сцена 1")
		scenes[sc.ID] = sc
		diskOrder = []string{sc.ID}
		meta = roomMeta{CurrentSceneID: sc.ID, SceneOrder: diskOrder}
	}

	order := dedupeOrder(meta.SceneOrder, scenes, diskOrder)
	if len(order) == 0 {
		sort.Slice(diskOrder, func(i, j int) bool { return scenes[diskOrder[i]].Name < scenes[diskOrder[j]].Name })
		order = diskOrder
	}

	currentID := meta.CurrentSceneID
	if currentID == "" && meta.CurrentMap != "" {
		for id, sc := range scenes {
			if sc.MapURL == meta.CurrentMap {
				currentID = id
				break
			}
		}
	}
	if _, ok := scenes[currentID]; !ok {
		if len(order) > 0 {
			currentID = order[0]
		} else {
			for id := range scenes {
				currentID = id
				break
			}
		}
	}

	log.Printf("состояние загружено: сцен — %d, активна %q", len(scenes), currentID)
	return &domain.RoomSnapshot{CurrentSceneID: currentID, SceneOrder: order, Scenes: scenes, Combat: s.loadCombat(), Hub: s.loadHub()}, nil
}

// loadCombat читает трекер инициативы (см. domain.CombatState) из его
// отдельного файла. Отсутствующий файл (первый запуск) и битый JSON
// (ручное редактирование) одинаково трактуются как "начать с пустого
// трекера" — как и остальной Load.
func (s *Store) loadCombat() *domain.CombatState {
	combat := domain.NewCombatState()
	data, err := os.ReadFile(s.combatFile)
	if err != nil {
		return combat
	}
	if err := json.Unmarshal(data, combat); err != nil {
		log.Println("трекер инициативы повреждён, начинаю с пустого:", err)
		return domain.NewCombatState()
	}
	if combat.Combatants == nil {
		combat.Combatants = make(map[string]*domain.Combatant)
	}
	return combat
}

// SaveCombat implements repository.SceneRepository. Атомарно сохраняет
// трекер инициативы — тот же приём, что SaveScene.
func (s *Store) SaveCombat(ctx context.Context, combat *domain.CombatState) error {
	if err := os.MkdirAll(s.dataDir, 0o750); err != nil {
		return err
	}
	data, err := json.MarshalIndent(combat, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.combatFile + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.combatFile)
}

// loadHub читает хаб лута ДМ (см. domain.LootHub) из его отдельного файла —
// тот же принцип, что и loadCombat: отсутствующий файл/битый JSON трактуются
// как "начать с пустого хаба".
func (s *Store) loadHub() *domain.LootHub {
	hub := domain.NewLootHub()
	data, err := os.ReadFile(s.hubFile)
	if err != nil {
		return hub
	}
	if err := json.Unmarshal(data, hub); err != nil {
		log.Println("хаб лута повреждён, начинаю с пустого:", err)
		return domain.NewLootHub()
	}
	if hub.Entries == nil {
		hub.Entries = make(map[string]*domain.InventoryEntry)
	}
	return hub
}

func (s *Store) SaveHub(ctx context.Context, hub *domain.LootHub) error {
	if err := os.MkdirAll(s.dataDir, 0o750); err != nil {
		return err
	}
	data, err := json.MarshalIndent(hub, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.hubFile + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.hubFile)
}

// dedupeOrder фильтрует сохранённый порядок сцен до тех, что реально
// существуют, и дописывает в конец найденные на диске сцены, которых в
// сохранённом порядке почему-то не было (ручное редактирование, гонка при
// падении процесса между записью файла сцены и room.json и т.п.).
func dedupeOrder(saved []string, scenes map[string]*domain.SceneState, diskOrder []string) []string {
	if len(saved) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(saved))
	out := make([]string, 0, len(scenes))
	for _, id := range saved {
		if _, ok := scenes[id]; ok && !seen[id] {
			out = append(out, id)
			seen[id] = true
		}
	}
	for _, id := range diskOrder {
		if !seen[id] {
			out = append(out, id)
			seen[id] = true
		}
	}
	return out
}

// migrateLegacyIfNeeded переносит данные со старого однофайлового формата
// (data/scene.json, одним JSON на всю комнату, где сцена была равна URL
// карты) в раскладку файл-на-сцену с явными id/именами. Возвращает nil, если
// переносить было нечего — обычный путь на новых установках и при повторных
// запусках после того, как миграция уже прошла.
func (s *Store) migrateLegacyIfNeeded() *domain.RoomSnapshot {
	if _, err := os.Stat(s.scenesDir); err == nil {
		return nil // новая раскладка уже на диске — миграция не нужна
	}
	data, err := os.ReadFile(s.legacyFile)
	if err != nil {
		return nil // и старого файла нет — это первый запуск вообще
	}

	type legacyRoomState struct {
		CurrentMap string                        `json:"currentMap"`
		Scenes     map[string]*domain.SceneState `json:"scenes"`
	}

	byURL := map[string]*domain.SceneState{}
	currentMapURL := ""

	var legacy legacyRoomState
	single := &domain.SceneState{}
	if err := json.Unmarshal(data, &legacy); err == nil && len(legacy.Scenes) > 0 {
		byURL, currentMapURL = legacy.Scenes, legacy.CurrentMap
	} else if json.Unmarshal(data, single) == nil && hasContent(single) {
		// совсем древний формат — один SceneState без деления по картам вообще
		byURL[single.MapURL] = single
		currentMapURL = single.MapURL
	} else {
		log.Println("старый файл состояния повреждён, миграция пропущена:", s.legacyFile)
		return nil
	}

	scenes := make(map[string]*domain.SceneState, len(byURL))
	order := make([]string, 0, len(byURL))
	currentID := ""
	for url, sc := range byURL {
		id := fmt.Sprintf("legacy-%08x", fnvHash(url)) // стабильный id из старого ключа-URL
		if sc.MapURL == "" {
			sc.MapURL = url
		}
		finalizeLoadedScene(sc, id)
		scenes[sc.ID] = sc
		order = append(order, sc.ID)
		if url == currentMapURL {
			currentID = sc.ID
		}
		if err := s.SaveScene(context.Background(), sc.ID, sc); err != nil {
			log.Println("миграция: не удалось сохранить сцену", url, err)
		}
	}
	sort.Strings(order) // детерминированный порядок вместо случайного порядка map-итерации
	if currentID == "" && len(order) > 0 {
		currentID = order[0]
	}

	if err := s.SaveMeta(context.Background(), currentID, order); err != nil {
		log.Println("миграция: не удалось сохранить активную сцену:", err)
	}

	// убираем старый файл с дороги, а не удаляем — если миграция где-то
	// ошиблась, есть что руками сверить/докатить назад.
	if err := s.backupToMigrations(s.legacyFile); err != nil {
		log.Println("миграция: не удалось убрать старый файл в бэкап:", err)
	}
	log.Printf("состояние мигрировано в %s (сцен: %d)", s.scenesDir, len(scenes))

	return &domain.RoomSnapshot{CurrentSceneID: currentID, SceneOrder: order, Scenes: scenes, Combat: s.loadCombat(), Hub: s.loadHub()}
}

// backupToMigrations убирает отработавший своё файл формата не в мусор, а в
// data/migrations/<дата-время>/<исходное-имя> — с датой в имени папки
// всегда, без вариантов "забыли проставить". Так по мере развития проекта
// (новые миграции формата state будут копиться и дальше) в data/migrations/
// остаётся история "что и когда мигрировали".
func (s *Store) backupToMigrations(srcPath string) error {
	dir := filepath.Join(s.migrationsDir, time.Now().Format("2006-01-02_15-04-05"))
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return err
	}
	return os.Rename(srcPath, filepath.Join(dir, filepath.Base(srcPath)))
}

// hasContent отличает "легаси-файл реально что-то хранил" от "пустой/не в
// этом формате вообще" — иначе неудачную миграцию было бы не отличить от
// легитимной пустой сцены.
func hasContent(s *domain.SceneState) bool {
	return s.MapURL != "" || len(s.Tokens) > 0 || len(s.NoteMarkers) > 0 || len(s.Walls) > 0 || len(s.FogAreas) > 0 || len(s.Buildings) > 0
}

// sanitizeScene защищает от nil-карт внутри сцены (если в файле их не было —
// ручное редактирование/старый формат) — иначе первая же мутация упадёт
// записью в nil map. Заодно подставляет дефолты для полей, которых не было в
// старых файлах сцен (Width/Height/FogOfWar/Grid.*) — специально ТАК, чтобы
// уже существующие карты DM не поменяли вид после апгрейда: сетка остаётся
// белой полупрозрачной (как рисовалась раньше хардкодом в клиенте), а не
// перекрашивается в новый дефолт для только что созданных сцен.
func sanitizeScene(s *domain.SceneState) {
	if s.Tokens == nil {
		s.Tokens = make(map[string]*domain.Token)
	}
	if s.NoteMarkers == nil {
		s.NoteMarkers = make(map[string]*domain.NoteMarker)
	}
	if s.Walls == nil {
		s.Walls = make(map[string]*domain.Wall)
	}
	if s.FogAreas == nil {
		s.FogAreas = make(map[string]*domain.FogArea)
	}
	if s.Buildings == nil {
		s.Buildings = make(map[string]*domain.Building)
	}
	if s.Width <= 0 {
		s.Width = 1280
	}
	if s.Height <= 0 {
		s.Height = 720
	}
	if s.FogOfWar == nil {
		t := true
		s.FogOfWar = &t
	}
	if s.Grid.Visible == nil {
		t := true
		s.Grid.Visible = &t
	}
	if s.Grid.Unit == "" {
		s.Grid.Unit = "ft"
	}
	if s.Grid.UnitsPerCell <= 0 {
		s.Grid.UnitsPerCell = 5
	}
	if s.Grid.LineColor == "" {
		s.Grid.LineColor = "#ffffff" // сохраняем прежний хардкод-вид старых карт
		s.Grid.LineOpacity = 0.28
	}
	if s.AmbientVolume <= 0 {
		s.AmbientVolume = 0.6 // карты, сохранённые до появления аудио, получают тот же дефолт, что и NewScene
	}
}

// SaveScene implements repository.SceneRepository. Атомарно сохраняет ОДНУ
// сцену в её собственный файл: пишет во временный файл и переименовывает
// поверх целевого, чтобы падение/убийство процесса посреди записи не
// оставляло битый файл именно этой сцены (а не портило заодно и остальную
// библиотеку, как было бы с одним общим файлом).
func (s *Store) SaveScene(ctx context.Context, id string, scene *domain.SceneState) error {
	if err := os.MkdirAll(s.scenesDir, 0o750); err != nil {
		return err
	}
	data, err := json.MarshalIndent(scene, "", "  ")
	if err != nil {
		return err
	}
	p := filepath.Join(s.scenesDir, sceneFileName(id))
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// DeleteScene implements repository.SceneRepository. Убирает файл удалённой
// сцены с диска сразу (не дожидаясь автосейва) — иначе при следующем запуске
// сервера удалённая сцена "воскресла" бы из своего файла на диске.
func (s *Store) DeleteScene(ctx context.Context, id string) error {
	err := os.Remove(filepath.Join(s.scenesDir, sceneFileName(id)))
	if err != nil && os.IsNotExist(err) {
		return nil
	}
	return err
}

// SaveMeta implements repository.SceneRepository. Атомарно сохраняет, какая
// сцена сейчас активна и в каком порядке они идут в переключателе DM.
func (s *Store) SaveMeta(ctx context.Context, currentSceneID string, order []string) error {
	if err := os.MkdirAll(s.dataDir, 0o750); err != nil {
		return err
	}
	data, err := json.MarshalIndent(roomMeta{CurrentSceneID: currentSceneID, SceneOrder: order}, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.roomMetaFile + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.roomMetaFile)
}
