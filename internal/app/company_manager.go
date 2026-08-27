// Package app — композиционная логика вокруг миров/компаний (domain.Company):
// в отличие от internal/service, которому запрещено знать о конкретных
// реализациях repository (sqlite/scenefile/localfs/…, см. package-doc
// internal/repository/repository.go), CompanyManager как раз и есть то
// место, что решает, какие конкретные хранилища собрать под текущий
// запущенный мир — то же самое, что раньше один раз делал
// cmd/beacon-table/main.go, только теперь вызывается заново на каждое
// переключение мира (см. Launch), а не один раз при старте процесса.
package app

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository"
	"beacon-table/internal/repository/conditionfile"
	"beacon-table/internal/repository/itemfile"
	"beacon-table/internal/repository/journalfile"
	"beacon-table/internal/repository/localfs"
	"beacon-table/internal/repository/monsterfile"
	"beacon-table/internal/repository/notefile"
	"beacon-table/internal/repository/referencefile"
	"beacon-table/internal/repository/scenefile"
	"beacon-table/internal/repository/spellfile"
	"beacon-table/internal/repository/sqlite"
	"beacon-table/internal/service"
)

// ActiveWorld — снимок всех сервисов, собранных под ОДИН запущенный сейчас
// мир (компанию). Заменяется целиком на каждый CompanyManager.Launch —
// никогда не мутируется на месте, поэтому читатели, получившие указатель
// через CompanyManager.Current(), могут спокойно пользоваться им и после
// разблокировки мьютекса: следующий Launch создаст новый ActiveWorld, а не
// подменит поля этого.
type ActiveWorld struct {
	Company    *domain.Company
	Room       service.RoomService
	Characters service.CharacterService
	Pregens    service.PregenService
	Admin      service.AdminService
	Bestiary   service.BestiaryService
	Spells     service.SpellService
	Items      service.ItemService
	References service.ReferenceService
	Conditions service.ConditionService
	Notes      service.NoteService

	Journal   service.JournalService
	Playlists service.PlaylistService
	Assets    service.AssetService

	Foundry service.FoundryService
}

// CompanyManager — держит список миров и то, какой из них сейчас запущен на
// сервере (Foundry-модель: не несколько параллельно, см. domain.Company).
// Auth (аккаунты/сессии) сюда не входит — он полностью глобален и не
// пересобирается при переключении мира (см. cmd/beacon-table/main.go).
type CompanyManager struct {
	mu sync.Mutex

	db        *sql.DB
	companies repository.CompanyRepository
	accounts  repository.AccountRepository
	sessions  repository.SessionRepository
	dice      service.DiceRoller
	systemFS  fs.FS

	dataRoot    string // корень пользовательских данных легаси-компании, обычно "data"
	uploadsRoot string // корень загрузок легаси-компании, обычно "uploads"
	uploadsURL  string // префикс раздачи загрузок, обычно "/uploads/"

	legacyID string // см. repository.CompanyRepository.LegacyID — кэш, читается один раз в Bootstrap

	current *ActiveWorld
}

// NewCompanyManager собирает CompanyManager. dataRoot/uploadsRoot/uploadsURL —
// корни ЛЕГАСИ-компании (см. rootsFor) — той единственной, что унаследовала
// данные инсталляции, существовавшей до появления миров (см. Bootstrap);
// любая другая компания получает свои собственные подпапки внутри тех же
// корней.
func NewCompanyManager(db *sql.DB, companies repository.CompanyRepository, accounts repository.AccountRepository, sessions repository.SessionRepository, dice service.DiceRoller, systemFS fs.FS, dataRoot, uploadsRoot, uploadsURL string) *CompanyManager {
	return &CompanyManager{
		db: db, companies: companies, accounts: accounts, sessions: sessions, dice: dice, systemFS: systemFS,
		dataRoot: dataRoot, uploadsRoot: uploadsRoot, uploadsURL: uploadsURL,
	}
}

// newID — тот же принцип, что и service.newID (crypto/rand, 16 байт hex),
// но локальный: internal/service намеренно не экспортирует свой генератор,
// а заводить общий пакет ради одной функции избыточно на масштабе проекта.
func newID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		log.Fatal("crypto/rand недоступен:", err)
	}
	return hex.EncodeToString(b)
}

// Current — снимок текущего запущенного мира, nil если ничего не запущено
// (валидно: свежая установка до первого "Создать мир", либо ДМ ещё не
// выбрал, какой из существующих миров поднять).
func (m *CompanyManager) Current() *ActiveWorld {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.current
}

// ActiveCompanyID — id компании текущего мира, "" если ничего не запущено.
func (m *CompanyManager) ActiveCompanyID() string {
	w := m.Current()
	if w == nil {
		return ""
	}
	return w.Company.ID
}

// AccountInActiveWorld — принадлежит ли acc тому миру, что сейчас запущен.
// Чистая проверка компании, БЕЗ особого случая для admin — единственный
// admin-аккаунт ("dm") не привязан ни к одной компании (CompanyID == "") и
// должен всегда проходить отдельной веткой у вызывающего (см.
// api/http/middleware.go: requireAccount, api/ws/routes.go), а не через этот
// метод.
func (m *CompanyManager) AccountInActiveWorld(acc *domain.Account) bool {
	w := m.Current()
	return w != nil && acc.CompanyID != "" && acc.CompanyID == w.Company.ID
}

// List — все миры сервера (для экрана выбора мира, см. worlds.html).
func (m *CompanyManager) List(ctx context.Context) ([]*domain.Company, error) {
	return m.companies.List(ctx)
}

const maxCompanyNameLen = 80

// Create заводит новый мир (ещё не запущенный — см. Launch). Пустые
// data/uploads-директории под него создаются лениво при первом Launch, не
// здесь.
func (m *CompanyManager) Create(ctx context.Context, name, system string) (*domain.Company, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > maxCompanyNameLen {
		return nil, &domain.ValidationError{Msg: "название мира — обязательно, до 80 символов"}
	}
	if !domain.ValidSystem(system) {
		return nil, &domain.ValidationError{Msg: "неизвестная система"}
	}
	c := &domain.Company{ID: newID(), Name: name, System: system}
	if err := m.companies.Create(ctx, c); err != nil {
		return nil, err
	}
	return c, nil
}

// Delete удаляет мир — только если он сейчас не запущен и в нём нет ни
// одного аккаунта (простое консервативное правило первой итерации: не
// потерять чужие данные одним кликом). Файлы на диске (data/companies/<id>,
// uploads/companies/<id>) НЕ удаляются — тем же принципом, что и delete_scene
// в Room не трогает файл сцены сразу (см. комментарий в domain), тут проще
// и безопаснее оставить осиротевшие файлы на диске, чем рисковать
// рекурсивным os.RemoveAll по данным, которые могли зваться иначе, чем
// ожидает код.
func (m *CompanyManager) Delete(ctx context.Context, id string) error {
	if id == m.ActiveCompanyID() {
		return domain.ErrForbidden
	}
	accs, err := m.accounts.List(ctx)
	if err != nil {
		return err
	}
	for _, a := range accs {
		if a.CompanyID == id {
			return domain.ErrConflict
		}
	}
	return m.companies.Delete(ctx, id)
}

// rootsFor — корневые пути на диске для компании: у легаси-компании (см.
// Bootstrap/repository.CompanyRepository.LegacyID) это те же корни, что были
// у инсталляции ДО появления миров (data/, uploads/, "/uploads/") — апгрейд
// существующей установки происходит без единого движения файлов на диске.
// У любой другой компании — своя подпапка внутри тех же корней.
func (m *CompanyManager) rootsFor(company *domain.Company) (dataRoot, uploadsRoot, uploadsURL string) {
	if m.legacyID != "" && company.ID == m.legacyID {
		return m.dataRoot, m.uploadsRoot, m.uploadsURL
	}
	dataRoot = filepath.Join(m.dataRoot, "companies", company.ID)
	uploadsRoot = filepath.Join(m.uploadsRoot, "companies", company.ID)
	uploadsURL = m.uploadsURL + "companies/" + company.ID + "/"
	return
}

// Launch переключает сервер на company: гасит текущий Room (синхронный
// flush на диск, как и раньше делал только SIGINT/SIGTERM, см.
// cmd/beacon-table/main.go), собирает файловые репозитории на корне этой
// компании (см. rootsFor) и company-scoped sqlite-сторы, поднимает новый
// Room и атомарно подменяет ActiveWorld.
//
// На время между "погасили старый Room" и "подняли новый" Current()
// намеренно отдаёт nil (а не полу-мёртвый старый ActiveWorld с уже
// остановленным Room — Join/Dispatch/Leave на нём заблокировались бы
// навсегда, некому читать из его каналов) — вызывающая сторона (api/http,
// api/ws) уже умеет трактовать nil как "мир сейчас не запущен".
func (m *CompanyManager) Launch(ctx context.Context, companyID string) error {
	company, err := m.companies.ByID(ctx, companyID)
	if err != nil {
		return err
	}

	m.mu.Lock()
	prev := m.current
	m.current = nil
	m.mu.Unlock()
	if prev != nil {
		prev.Room.Shutdown()
	}

	dataRoot, uploadsRoot, uploadsURL := m.rootsFor(company)

	sceneRepo := scenefile.NewStore(filepath.Join(dataRoot, "scenes"))
	noteRepo := notefile.NewStore(filepath.Join(dataRoot, "notes"))
	journalRepo := journalfile.NewStore(filepath.Join(dataRoot, "journal"))
	monsterRepo := monsterfile.NewCatalog(
		monsterfile.NewStore(filepath.Join(dataRoot, "bestiary")),
		monsterfile.NewSystemStore(m.systemFS, "systemdata/bestiary/"+company.System),
	)
	spellRepo := spellfile.NewCatalog(
		spellfile.NewStore(filepath.Join(dataRoot, "spells")),
		spellfile.NewSystemStore(m.systemFS, "systemdata/spells/"+company.System),
	)
	itemRepo := itemfile.NewCatalog(
		itemfile.NewStore(filepath.Join(dataRoot, "items")),
		itemfile.NewSystemStore(m.systemFS, "systemdata/items/"+company.System),
	)
	referenceRepo := referencefile.NewCatalog(
		referencefile.NewStore(filepath.Join(dataRoot, "references")),
		referencefile.NewSystemStore(m.systemFS, "systemdata/references/"+company.System),
	)
	// conditionRepo — библиотека состояний, тот же каталог «из коробки» +
	// пользовательская библиотека, что и у остальных четырёх. Подпапка
	// systemdata/conditions/<system> — единственное место, где реализовано
	// требование «статусы делятся по игровым системам»: у мира на D&D 2014
	// своё истощение, у мира на 2024 — своё.
	conditionRepo := conditionfile.NewCatalog(
		conditionfile.NewStore(filepath.Join(dataRoot, "conditions")),
		conditionfile.NewSystemStore(m.systemFS, "systemdata/conditions/"+company.System),
	)
	assetRepo := localfs.NewStore(uploadsRoot, uploadsURL)
	if err := assetRepo.EnsureDirs(); err != nil {
		return err
	}

	characterRepo := sqlite.NewCharacterStore(m.db, company.ID, company.System)
	pregenRepo := sqlite.NewPregenStore(m.db, company.ID)
	playlistRepo := sqlite.NewPlaylistStore(m.db, company.ID)
	foundryModuleRepo := sqlite.NewFoundryModuleStore(m.db, company.ID)

	room, err := service.NewRoom(sceneRepo, m.dice, characterRepo, monsterRepo, itemRepo, conditionRepo)
	if err != nil {
		return err
	}

	if err := m.companies.SetActiveID(ctx, company.ID); err != nil {
		room.Shutdown()
		return err
	}

	notes := service.NewNoteService(noteRepo)
	journal := service.NewJournalService(journalRepo)
	playlists := service.NewPlaylistService(playlistRepo)
	assets := service.NewAssetService(assetRepo)
	bestiary := service.NewBestiaryService(monsterRepo)
	spells := service.NewSpellService(spellRepo)
	items := service.NewItemService(itemRepo)
	references := service.NewReferenceService(referenceRepo)
	conditions := service.NewConditionService(conditionRepo)

	world := &ActiveWorld{
		Company:    company,
		Room:       room,
		Characters: service.NewCharacterService(characterRepo),
		Pregens:    service.NewPregenService(pregenRepo, characterRepo),
		Admin:      service.NewAdminService(m.accounts, m.sessions, characterRepo, company.ID),
		Bestiary:   bestiary,
		Spells:     spells,
		Items:      items,
		References: references,
		Conditions: conditions,
		Notes:      notes,
		Journal:    journal,
		Playlists:  playlists,
		Assets:     assets,
		Foundry: service.NewFoundryService(
			filepath.Join(dataRoot, "foundry-cache"), assets, room, playlists, foundryModuleRepo,
			bestiary, spells, items, references, conditions, pregenRepo,
		),
	}

	m.mu.Lock()
	m.current = world
	m.mu.Unlock()
	log.Println("мир запущен:", company.Name, "("+company.System+")")
	return nil
}

// Shutdown — синхронно сохраняет текущий мир перед остановкой процесса (см.
// cmd/beacon-table/main.go: обработчик SIGINT/SIGTERM). Nil-safe: если
// ничего не запущено, ничего не делает.
func (m *CompanyManager) Shutdown() {
	if w := m.Current(); w != nil {
		w.Room.Shutdown()
	}
}

// looksLikeLegacyInstall — есть ли на диске/в БД следы инсталляции,
// существовавшей ДО появления миров: хоть один аккаунт-игрок (admin
// заводится всегда, см. SeedAdmin, поэтому непоказателен сам по себе) или
// каталог легаси-сцен. Используется только в Bootstrap, чтобы отличить
// апгрейд существующей установки от честно свежей.
func (m *CompanyManager) looksLikeLegacyInstall(ctx context.Context) (bool, error) {
	accs, err := m.accounts.List(ctx)
	if err != nil {
		return false, err
	}
	for _, a := range accs {
		if !a.IsAdmin() {
			return true, nil
		}
	}
	if _, err := os.Stat(filepath.Join(m.dataRoot, "scenes")); err == nil {
		return true, nil
	}
	return false, nil
}

// Bootstrap поднимает CompanyManager при старте сервера — вызывается ровно
// один раз из main.go, до открытия HTTP/WS-портов.
//
//   - Компаний ещё нет и похоже на апгрейд (см. looksLikeLegacyInstall) —
//     заводим единственную "Мир по умолчанию" (D&D 2024 — лист персонажа до
//     этой фичи был жёстко под неё), помечаем её легаси-компанией (унаследует
//     старые корневые пути без переноса файлов, см. rootsFor), одним UPDATE
//     усыновляем всех существующих аккаунтов/персонажей/плейлисты
//     (sqlite.MigrateLegacyCompany) и сразу запускаем.
//   - Компаний ещё нет и признаков апгрейда нет — честно свежая установка,
//     ничего не запускаем, Current() == nil, ДМ создаёт первый мир сам через
//     /worlds.html.
//   - Компании уже есть — поднимаем тот, что был активен на момент прошлой
//     остановки сервера (server_state), если он всё ещё существует.
func (m *CompanyManager) Bootstrap(ctx context.Context) error {
	companies, err := m.companies.List(ctx)
	if err != nil {
		return err
	}
	legacyID, err := m.companies.LegacyID(ctx)
	if err != nil {
		return err
	}
	m.legacyID = legacyID

	if len(companies) == 0 {
		isUpgrade, err := m.looksLikeLegacyInstall(ctx)
		if err != nil {
			return err
		}
		if !isUpgrade {
			log.Println("миров ещё нет — войди под ДМ и создай первый мир на /worlds.html")
			return nil
		}
		company := &domain.Company{ID: newID(), Name: "Мир по умолчанию", System: domain.SystemDnD5e2024}
		if err := m.companies.Create(ctx, company); err != nil {
			return err
		}
		if err := m.companies.SetLegacyID(ctx, company.ID); err != nil {
			return err
		}
		m.legacyID = company.ID
		if err := sqlite.MigrateLegacyCompany(ctx, m.db, company.ID, company.System); err != nil {
			return err
		}
		log.Println("существующая инсталляция мигрирована в мир по умолчанию:", company.Name)
		return m.Launch(ctx, company.ID)
	}

	activeID, err := m.companies.ActiveID(ctx)
	if err != nil {
		return err
	}
	if activeID == "" {
		log.Println("ни один мир не запущен — войди под ДМ и выбери мир на /worlds.html")
		return nil
	}
	if _, err := m.companies.ByID(ctx, activeID); err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			log.Println("ранее активный мир больше не существует — войди под ДМ и выбери мир на /worlds.html")
			return nil
		}
		return err
	}
	return m.Launch(ctx, activeID)
}
