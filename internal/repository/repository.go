// Package repository описывает контракты хранилищ данных (интерфейсы) —
// границу между service-слоем (бизнес-логика) и конкретным способом
// хранения. Сервисы зависят только от интерфейсов этого пакета, никогда от
// database/sql, os или конкретных подпакетов реализации (sqlite/scenefile/
// localfs/memory) напрямую — это и есть "связь через интерфейсы".
//
// Реализации лежат в подпакетах:
//   - sqlite    — Account/Character/Session/Playlist поверх database/sql (SQLite)
//   - scenefile — Scene поверх файлов JSON, по одному на сцену
//   - notefile  — Note поверх файлов .md, по одному на заметку
//   - journalfile — JournalEntry поверх файлов .md с шапкой прав, по одному на запись
//   - monsterfile — Monster поверх файлов .json, по одному на монстра
//   - spellfile — Spell поверх файлов .json, по одному на заклинание
//   - itemfile — Item поверх файлов .json, по одному на предмет
//   - conditionfile — Condition поверх файлов .json, по одному на состояние
//   - localfs   — Asset поверх файловой системы (загруженные карты/токены/аудио)
//   - memory    — in-memory реализации для unit-тестов service-слоя
package repository

import (
	"context"
	"io"

	"beacon-table/internal/domain"
)

// CompanyRepository — CRUD миров/компаний (domain.Company) плюс
// единственная запись о том, какой из них сейчас запущен на сервере (см.
// service.CompanyManager) — Foundry-модель, не несколько активных
// параллельно.
type CompanyRepository interface {
	Create(ctx context.Context, c *domain.Company) error
	List(ctx context.Context) ([]*domain.Company, error)
	ByID(ctx context.Context, id string) (*domain.Company, error)
	Delete(ctx context.Context, id string) error
	// ActiveID/SetActiveID — id компании, сейчас запущенной на сервере
	// (server_state, ключ "active_company_id"); пустая строка — ничего не
	// запущено (валидно на свежей установке до первого "Создать мир").
	ActiveID(ctx context.Context) (string, error)
	SetActiveID(ctx context.Context, id string) error
	// LegacyID/SetLegacyID — id компании, унаследовавшей данные
	// инсталляции, созданной ДО этой фичи (см. sqlite.MigrateLegacyCompany):
	// только она хранит файлы в старых корневых путях (data/, uploads/) без
	// подпапки companies/<id>/. Пустая строка — миграции не было (или
	// инсталляция изначально мультимировая).
	LegacyID(ctx context.Context) (string, error)
	SetLegacyID(ctx context.Context, id string) error
}

// AccountRepository — CRUD аккаунтов стола.
type AccountRepository interface {
	Create(ctx context.Context, a *domain.Account) error
	ByUsername(ctx context.Context, username string) (*domain.Account, error)
	ByID(ctx context.Context, id string) (*domain.Account, error)
	List(ctx context.Context) ([]*domain.Account, error)
	Delete(ctx context.Context, id string) error
	Approve(ctx context.Context, id string) error
	// SetPassword меняет пароль и (при mustChangePassword) требует смены при
	// следующем входе — используется и админ-сбросом, и сменой временного
	// пароля seed-admin'а.
	SetPassword(ctx context.Context, id, passwordHash string, mustChangePassword bool) error
}

// CharacterRepository — CRUD персонажей игроков.
type CharacterRepository interface {
	Create(ctx context.Context, c *domain.Character) error
	ByID(ctx context.Context, id string) (*domain.Character, error)
	ByAccount(ctx context.Context, accountID string) ([]*domain.Character, error)
	// All — персонажи всех аккаунтов разом (для ДМ-контекстного меню токена).
	All(ctx context.Context) ([]*domain.Character, error)
	Update(ctx context.Context, id, accountID, name, avatarURL string) (bool, error)
	// UpdateSheet перезаписывает структурированный лист персонажа (см.
	// domain.CharacterSheet), не трогая имя/аватар.
	UpdateSheet(ctx context.Context, id, accountID string, sheet domain.CharacterSheet) (bool, error)
	// UpdateSheetHP правит ТОЛЬКО хиты в листе (текущие/временные/максимум),
	// не трогая остальной sheet_json, и без accountID: хиты персонажа правит
	// не только его владелец, но и ДМ из трекера инициативы (см.
	// service.Room.syncCharacterHP) — у него своей сессии игрока нет.
	//
	// Отдельным точечным методом, а не UpdateSheet целиком, ровно по той же
	// причине, по которой инвентарь живёт отдельной таблицей (см. ниже):
	// полная перезапись листа устаревшей копией затирала бы чужую правку —
	// а во время боя хиты меняются с двух сторон одновременно.
	UpdateSheetHP(ctx context.Context, id string, hpCurrent, hpTemp, hpMax int) (bool, error)
	Delete(ctx context.Context, id, accountID string) (bool, error)

	// ---- инвентарь персонажа (domain.InventoryEntry) — СВОЯ таблица, не
	// часть sheet_json (см. комментарий CharacterSheet и план фичи): пишется
	// не только владельцем (ДМ через хаб, service.Room при луте трупа), а
	// полная перезапись sheet_json по debounce-автосейву листа не должна
	// откатывать выданный лут устаревшей копией. Тот же принцип, что у
	// PlaylistRepository.AddTrack/UpdateTrack/DeleteTrack — точечные мутации
	// sub-collection, а не whole-blob replace. ----

	ListInventory(ctx context.Context, characterID string) ([]*domain.InventoryEntry, error)
	// AddInventoryEntry добавляет запись инвентаря. Если entry.ItemID != ""
	// и у персонажа уже есть запись с таким же ItemID — количество
	// СУММИРУЕТСЯ в существующую запись (апсерт), а не плодит вторую строку;
	// записи без ItemID (ручные/осиротевшие) всегда добавляются новой
	// строкой. accountID — тот же принцип защиты, что и у Update/UpdateSheet/
	// Delete: запись видна только если character действительно принадлежит
	// этому accountID (и этой компании).
	AddInventoryEntry(ctx context.Context, characterID, accountID string, entry domain.InventoryEntry) (*domain.InventoryEntry, error)
	// UpdateInventoryEntry возвращает false, если записи с таким entryID нет
	// у ЭТОГО персонажа/аккаунта.
	UpdateInventoryEntry(ctx context.Context, characterID, accountID, entryID string, quantity int, equipped bool, notes string) (bool, error)
	// RemoveInventoryEntry возвращает false, если записи с таким entryID нет.
	RemoveInventoryEntry(ctx context.Context, characterID, accountID, entryID string) (bool, error)
}

// SessionRepository — сессии логина (cookie-токен → аккаунт).
type SessionRepository interface {
	Create(ctx context.Context, token, accountID string) error
	AccountByToken(ctx context.Context, token string) (*domain.Account, error)
	Delete(ctx context.Context, token string) error
	DeleteForAccount(ctx context.Context, accountID string) error
}

// PlaylistRepository — библиотека плейлистов канала ДМ.
type PlaylistRepository interface {
	Create(ctx context.Context, id, name string) error
	Rename(ctx context.Context, id, name string) (bool, error)
	Delete(ctx context.Context, id string) error
	// List — все плейлисты с уже подгруженными треками одним заходом.
	List(ctx context.Context) ([]*domain.Playlist, error)
	AddTrack(ctx context.Context, id, playlistID, url, name string, volume float64, loop bool) error
	UpdateTrack(ctx context.Context, id, playlistID, name string, volume float64, loop bool) (bool, error)
	DeleteTrack(ctx context.Context, id, playlistID string) (bool, error)
	// MoveTrack переставляет трек на одну позицию: dir<0 — вверх, dir>0 — вниз.
	MoveTrack(ctx context.Context, playlistID, trackID string, dir int) error
}

// SceneRepository — персистентность библиотеки сцен комнаты (файл на
// сцену + метаданные "какая активна сейчас/в каком порядке").
type SceneRepository interface {
	// Load поднимает всю библиотеку сцен с диска, мигрируя старый формат при
	// необходимости. Никогда не возвращает пустую библиотеку — если на диске
	// ничего нет, создаёт и сохраняет сцену по умолчанию.
	Load(ctx context.Context) (*domain.RoomSnapshot, error)
	SaveScene(ctx context.Context, id string, s *domain.SceneState) error
	DeleteScene(ctx context.Context, id string) error
	SaveMeta(ctx context.Context, currentSceneID string, order []string) error
	// SaveCombat персистит трекер инициативы (domain.CombatState) — он не
	// привязан к конкретной сцене (см. domain.RoomSnapshot.Combat), поэтому
	// живёт в своём собственном файле, а не внутри SaveMeta/SaveScene.
	SaveCombat(ctx context.Context, combat *domain.CombatState) error
	// SaveHub персистит хаб лута ДМ (domain.LootHub) — тем же принципом, что
	// и SaveCombat: свой файл, не привязан к сцене/бою.
	SaveHub(ctx context.Context, hub *domain.LootHub) error
}

// NoteRepository — библиотека заметок ДМ, файл-на-заметку (см.
// internal/repository/notefile) — реальные .md на диске, а не строки в БД.
type NoteRepository interface {
	// List — метаданные всех заметок (без Content — как AssetRepository.List,
	// не тащим содержимое ради списка).
	List(ctx context.Context) ([]*domain.Note, error)
	Get(ctx context.Context, id string) (*domain.Note, error)
	// Create кладёт заметку в папку folder ("" — корень, см.
	// domain.Note.Folder); папка создаётся, если её ещё нет.
	Create(ctx context.Context, id, folder, content string) error
	// Update возвращает false, если заметки с таким id нет. Папку не трогает
	// — правка текста не переносит файл (см. Move).
	Update(ctx context.Context, id, content string) (bool, error)
	// Move переносит заметку в другую папку; false, если такой заметки нет.
	Move(ctx context.Context, id, folder string) (bool, error)
	Delete(ctx context.Context, id string) error

	// Folders — все папки библиотеки, включая ПУСТЫЕ (тем же соображением,
	// что и AssetRepository.Folders: только что созданная папка не должна
	// пропадать из панели до того, как в неё что-то положили).
	Folders(ctx context.Context) ([]string, error)
	CreateFolder(ctx context.Context, folder string) error
	// DeleteFolder удаляет папку СО ВСЕМ содержимым (вложенные папки и
	// заметки), как AssetRepository.DeleteFolder — предупредить ДМ обязан
	// вызывающий.
	DeleteFolder(ctx context.Context, folder string) error
	// RenameFolder переименовывает/переносит папку вместе с содержимым.
	RenameFolder(ctx context.Context, from, to string) error
}

// JournalRepository — журнал стола, файл-на-запись (см.
// internal/repository/journalfile) — те же .md на диске, что и у
// NoteRepository, но с шапкой: автор и раздача прав (domain.JournalEntry).
// Права репозиторий только ХРАНИТ — решает по ним service.JournalService,
// репозиторий отдаёт все записи подряд, кто бы ни спрашивал.
type JournalRepository interface {
	// List — метаданные всех записей (без Content, как NoteRepository.List).
	List(ctx context.Context) ([]*domain.JournalEntry, error)
	Get(ctx context.Context, id string) (*domain.JournalEntry, error)
	// Create кладёт запись целиком (id/папка/текст/автор/права уже
	// заполнены вызывающим).
	Create(ctx context.Context, e *domain.JournalEntry) error
	// Update меняет ТОЛЬКО текст, не трогая шапку; false — записи нет.
	Update(ctx context.Context, id, content string) (bool, error)
	// SetAccess меняет ТОЛЬКО раздачу прав, не трогая текст; false — записи
	// нет. Отдельно от Update по той же причине, по какой у заметок отдельный
	// Move: текст автосейвится по таймеру при наборе, и класть в тот же
	// запрос ещё и права значило бы гонять их туда-сюда на каждое нажатие
	// клавиши (а гонка двух окон — затирать только что выданный доступ).
	SetAccess(ctx context.Context, id string, def domain.JournalAccess, access map[string]domain.JournalAccess) (bool, error)
	// Move переносит запись в другую папку; false, если такой записи нет.
	Move(ctx context.Context, id, folder string) (bool, error)
	Delete(ctx context.Context, id string) error

	// Folders — все папки журнала, включая пустые (см. NoteRepository.Folders).
	Folders(ctx context.Context) ([]string, error)
	CreateFolder(ctx context.Context, folder string) error
	// DeleteFolder удаляет папку СО ВСЕМ содержимым — проверить, что
	// удаляющему это вообще можно, обязан вызывающий (см.
	// service.JournalService.DeleteFolder).
	DeleteFolder(ctx context.Context, folder string) error
	RenameFolder(ctx context.Context, from, to string) error
}

// MonsterRepository — библиотека карточек бестиария ДМ, файл-на-монстра (см.
// internal/repository/monsterfile) — тот же принцип, что и NoteRepository,
// но контент структурированный JSON (domain.Monster), а не markdown.
type MonsterRepository interface {
	// List — все монстры библиотеки целиком (карточки маленькие, в отличие
	// от заметок нет смысла отдельно резать тяжёлые поля ради списка).
	List(ctx context.Context) ([]*domain.Monster, error)
	Get(ctx context.Context, id string) (*domain.Monster, error)
	Create(ctx context.Context, id string, m *domain.Monster) error
	// Update возвращает false, если монстра с таким id нет.
	Update(ctx context.Context, id string, m *domain.Monster) (bool, error)
	Delete(ctx context.Context, id string) error
}

// SpellRepository — библиотека карточек заклинаний, общая на весь стол,
// файл-на-заклинание (см. internal/repository/spellfile) — тот же принцип,
// что и MonsterRepository, но не привязана к ДМ: и ДМ, и игроки читают и
// пишут одну и ту же библиотеку.
type SpellRepository interface {
	List(ctx context.Context) ([]*domain.Spell, error)
	Get(ctx context.Context, id string) (*domain.Spell, error)
	Create(ctx context.Context, id string, s *domain.Spell) error
	// Update возвращает false, если заклинания с таким id нет.
	Update(ctx context.Context, id string, s *domain.Spell) (bool, error)
	Delete(ctx context.Context, id string) error
}

// ItemRepository — библиотека карточек предметов, общая на весь стол,
// файл-на-предмет (см. internal/repository/itemfile) — тот же принцип, что и
// SpellRepository: не привязана к ДМ, и ДМ, и игроки читают и пишут одну и ту
// же библиотеку.
type ItemRepository interface {
	List(ctx context.Context) ([]*domain.Item, error)
	Get(ctx context.Context, id string) (*domain.Item, error)
	Create(ctx context.Context, id string, it *domain.Item) error
	// Update возвращает false, если предмета с таким id нет.
	Update(ctx context.Context, id string, it *domain.Item) (bool, error)
	Delete(ctx context.Context, id string) error
}

// ReferenceRepository — библиотека карточек справочника (классы/архетипы/
// происхождения/виды/черты — см. domain.Reference.Kind), общая на весь стол,
// файл-на-запись (см. internal/repository/referencefile) — тот же принцип,
// что и ItemRepository/SpellRepository: не привязана к ДМ, и ДМ, и игроки
// читают и пишут одну и ту же библиотеку.
type ReferenceRepository interface {
	List(ctx context.Context) ([]*domain.Reference, error)
	Get(ctx context.Context, id string) (*domain.Reference, error)
	Create(ctx context.Context, id string, ref *domain.Reference) error
	// Update возвращает false, если записи с таким id нет.
	Update(ctx context.Context, id string, ref *domain.Reference) (bool, error)
	Delete(ctx context.Context, id string) error
}

// ConditionRepository — библиотека карточек состояний (ослепление/испуг/
// истощение и самодельные метки ДМ — см. domain.Condition), общая на весь
// стол, файл-на-состояние (см. internal/repository/conditionfile) — тот же
// принцип, что и ReferenceRepository: не привязана к ДМ, игрок тоже читает
// её (чтобы понимать, что на нём висит) и может завести своё состояние.
type ConditionRepository interface {
	List(ctx context.Context) ([]*domain.Condition, error)
	Get(ctx context.Context, id string) (*domain.Condition, error)
	Create(ctx context.Context, id string, c *domain.Condition) error
	// Update возвращает false, если карточки с таким id нет.
	Update(ctx context.Context, id string, c *domain.Condition) (bool, error)
	Delete(ctx context.Context, id string) error
}

// AssetRepository — хранилище загруженных файлов (карты/токены/аудио/пропы
// карты) на диске, вне embed.FS: рантайм-аплоады не могут попасть в бинарник.
type AssetRepository interface {
	// Save сохраняет содержимое r под именем, уникализированным относительно
	// filename, в подпапку kind/folder ("" folder — корень kind), и
	// возвращает публичный URL для раздачи.
	Save(ctx context.Context, kind, folder, filename string, r io.Reader) (url string, err error)
	// List — все файлы kind рекурсивно по всем подпапкам (см.
	// domain.AssetInfo.Path), новые сверху.
	List(ctx context.Context, kind string) ([]domain.AssetInfo, error)
	// Folders — все подпапки kind, включая пустые (см. domain.AssetFolder).
	Folders(ctx context.Context, kind string) ([]domain.AssetFolder, error)
	// CreateFolder создаёт папку folder (и недостающих родителей) внутри kind.
	CreateFolder(ctx context.Context, kind, folder string) error
	// DeleteFolder рекурсивно удаляет папку folder внутри kind вместе со
	// всем содержимым.
	DeleteFolder(ctx context.Context, kind, folder string) error
	// DeleteAsset удаляет один файл по его публичному URL (как вернул Save/
	// List) — реализация сама проверяет, что URL действительно указывает
	// внутрь kind, и отклоняет всё остальное.
	DeleteAsset(ctx context.Context, kind, url string) error
}

// FoundryModuleRepository — какие пакеты Foundry VTT (модули/системы) ДМ уже
// импортировал в этот мир (см. domain.FoundryModule), для раздела
// "Настройки": список установленного и проверка обновлений по сохранённой
// ManifestURL (см. service.FoundryService.Installed/CheckUpdates).
type FoundryModuleRepository interface {
	// Upsert запоминает/обновляет пакет по m.ID — вызывается после каждого
	// успешного импорта пака этого модуля (см. FoundryService.ImportPack), с
	// той версией и ссылкой на манифест, что были использованы.
	Upsert(ctx context.Context, m domain.FoundryModule) error
	// List — все запомненные пакеты этого мира, новые сверху.
	List(ctx context.Context) ([]*domain.FoundryModule, error)
	// ByID — один пакет; domain.ErrNotFound, если такого не устанавливали
	// (или уже удалили) в этом мире.
	ByID(ctx context.Context, id string) (*domain.FoundryModule, error)
	// Delete забывает пакет как установленный (см. FoundryService.Delete) —
	// сами карточки/файлы, заведённые его импортом, это НЕ трогает, тем же
	// разделением, что и у Upsert.
	Delete(ctx context.Context, id string) error
}
