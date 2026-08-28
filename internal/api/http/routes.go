package http

import (
	"net/http"

	"beacon-table/internal/app"
	"beacon-table/internal/service"
)

// API — REST-поверхность Beacon Table. Auth — единственный глобальный
// сервис (аккаунты/сессии не привязаны к конкретному запущенному миру, см.
// domain.Account.CompanyID) — остальные (персонажи, бестиарий, заклинания,
// предметы, заметки, плейлисты, ассеты, ДМ-правки чужих персонажей) живут
// внутри Companies.Current() — снимка сервисов ТЕКУЩЕГО запущенного мира,
// который целиком меняется при переключении (см. internal/app.CompanyManager,
// requireWorld в middleware.go). Handler-у, которому нужен такой сервис,
// всегда сначала нужно получить world через requireWorld.
type API struct {
	Auth      service.AuthService
	Companies *app.CompanyManager
	// Version — версия сервера (см. cmd/beacon-table/version.go), отдаётся
	// как есть по GET /api/version; сюда, а не в service-слой, потому что
	// это не бизнес-логика, а факт про сам процесс/сборку.
	Version string
}

// NewAPI собирает REST-хендлеры поверх Auth (глобален) и Companies
// (переключаемый набор сервисов текущего мира).
func NewAPI(auth service.AuthService, companies *app.CompanyManager, version string) *API {
	return &API{Auth: auth, Companies: companies, Version: version}
}

// RegisterRoutes навешивает все /api/*, /upload и /assets хендлеры на mux.
// Паттерны с методом и {id} — фича net/http с Go 1.22+.
func (a *API) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/register", a.handleRegister)
	mux.HandleFunc("POST /api/login", a.handleLogin)
	mux.HandleFunc("POST /api/logout", a.handleLogout)
	mux.HandleFunc("GET /api/me", a.handleMe)
	mux.HandleFunc("PUT /api/me/password", a.handleChangeOwnPassword)
	mux.HandleFunc("GET /api/version", a.handleVersion)

	// Миры (компании) — управляет только ДМ, см. company_handlers.go.
	mux.HandleFunc("GET /api/companies", a.handleCompaniesList)
	mux.HandleFunc("POST /api/companies", a.handleCompanyCreate)
	mux.HandleFunc("POST /api/companies/{id}/launch", a.handleCompanyLaunch)
	mux.HandleFunc("DELETE /api/companies/{id}", a.handleCompanyDelete)
	// Экспорт мира в .beacon-world.zip и импорт из него (создаёт новый мир) —
	// см. company_handlers.go / app.CompanyManager.ExportWorld/ImportWorld.
	mux.HandleFunc("GET /api/companies/{id}/export", a.handleCompanyExport)
	mux.HandleFunc("POST /api/companies/import", a.handleCompanyImport)

	mux.HandleFunc("GET /api/characters", a.handleCharactersList)
	mux.HandleFunc("POST /api/characters", a.handleCharacterCreate)
	mux.HandleFunc("GET /api/characters/{id}", a.handleCharacterGet)
	mux.HandleFunc("PUT /api/characters/{id}", a.handleCharacterUpdate)
	mux.HandleFunc("PUT /api/characters/{id}/sheet", a.handleCharacterSheetUpdate)
	mux.HandleFunc("DELETE /api/characters/{id}", a.handleCharacterDelete)

	// «Готовые персонажи» — пул предгенерированных листов мира из
	// импортированных приключений Foundry (см. domain.Pregen). Игрок берёт
	// свободного, ДМ управляет пулом — см. pregen_handlers.go.
	mux.HandleFunc("GET /api/pregens", a.handlePregensList)
	mux.HandleFunc("GET /api/pregens/{id}", a.handlePregenGet)
	mux.HandleFunc("POST /api/pregens/{id}/claim", a.handlePregenClaim)

	// Инвентарь персонажа (см. domain.InventoryEntry) — своя sub-collection,
	// не часть /sheet выше (см. комментарий repository.CharacterRepository и
	// план фичи про гонку с автосейвом листа).
	mux.HandleFunc("GET /api/characters/{id}/inventory", a.handleCharacterInventoryList)
	mux.HandleFunc("PUT /api/characters/{id}/inventory/{entryId}", a.handleCharacterInventoryUpdate)
	mux.HandleFunc("DELETE /api/characters/{id}/inventory/{entryId}", a.handleCharacterInventoryDelete)

	mux.HandleFunc("GET /api/admin/accounts", a.handleAdminAccountsList)
	mux.HandleFunc("POST /api/admin/accounts", a.handleAdminAccountCreate)
	mux.HandleFunc("POST /api/admin/accounts/{id}/approve", a.handleAdminAccountApprove)
	mux.HandleFunc("DELETE /api/admin/accounts/{id}", a.handleAdminAccountDelete)
	mux.HandleFunc("POST /api/admin/accounts/{id}/password", a.handleAdminAccountPassword)
	mux.HandleFunc("GET /api/admin/characters", a.handleAdminCharactersList)
	mux.HandleFunc("GET /api/admin/characters/{id}", a.handleAdminCharacterGet)
	mux.HandleFunc("PUT /api/admin/characters/{id}", a.handleAdminCharacterUpdate)
	mux.HandleFunc("PUT /api/admin/characters/{id}/sheet", a.handleAdminCharacterSheetUpdate)

	// Пул «готовых персонажей» — ДМ: обзор, назначение аккаунту, возврат в
	// пул. POST/PUT без {id}/с {id} — покарточное заведение из экрана импорта
	// Foundry (ср. /api/bestiary). См. pregen_handlers.go.
	mux.HandleFunc("GET /api/admin/pregens", a.handleAdminPregensList)
	mux.HandleFunc("POST /api/admin/pregens", a.handleAdminPregenCreate)
	mux.HandleFunc("PUT /api/admin/pregens/{id}", a.handleAdminPregenUpdate)
	mux.HandleFunc("POST /api/admin/pregens/{id}/assign", a.handleAdminPregenAssign)
	mux.HandleFunc("POST /api/admin/pregens/{id}/release", a.handleAdminPregenRelease)
	mux.HandleFunc("DELETE /api/admin/pregens/{id}", a.handleAdminPregenDelete)

	mux.HandleFunc("GET /api/admin/playlists", a.handleAdminPlaylistsList)
	mux.HandleFunc("POST /api/admin/playlists", a.handleAdminPlaylistCreate)
	mux.HandleFunc("PUT /api/admin/playlists/{id}", a.handleAdminPlaylistRename)
	mux.HandleFunc("DELETE /api/admin/playlists/{id}", a.handleAdminPlaylistDelete)
	mux.HandleFunc("POST /api/admin/playlists/{id}/tracks", a.handleAdminPlaylistTrackAdd)
	mux.HandleFunc("PUT /api/admin/playlists/{id}/tracks/{trackId}", a.handleAdminPlaylistTrackUpdate)
	mux.HandleFunc("DELETE /api/admin/playlists/{id}/tracks/{trackId}", a.handleAdminPlaylistTrackDelete)
	mux.HandleFunc("POST /api/admin/playlists/{id}/tracks/{trackId}/move", a.handleAdminPlaylistTrackMove)

	mux.HandleFunc("GET /api/journal", a.handleJournalList)
	mux.HandleFunc("POST /api/journal", a.handleJournalCreate)
	mux.HandleFunc("GET /api/journal/members", a.handleJournalMembers)
	mux.HandleFunc("GET /api/journal/{id}", a.handleJournalGet)
	mux.HandleFunc("PUT /api/journal/{id}", a.handleJournalUpdate)
	mux.HandleFunc("PUT /api/journal/{id}/access", a.handleJournalAccess)
	mux.HandleFunc("PUT /api/journal/{id}/folder", a.handleJournalMove)
	mux.HandleFunc("DELETE /api/journal/{id}", a.handleJournalDelete)

	mux.HandleFunc("GET /api/journal-folders", a.handleJournalFoldersList)
	mux.HandleFunc("POST /api/journal-folders", a.handleJournalFolderCreate)
	mux.HandleFunc("PUT /api/journal-folders", a.handleJournalFolderRename)
	mux.HandleFunc("DELETE /api/journal-folders", a.handleJournalFolderDelete)

	mux.HandleFunc("GET /api/bestiary", a.handleBestiaryList)
	mux.HandleFunc("POST /api/bestiary", a.handleMonsterCreate)
	mux.HandleFunc("GET /api/bestiary/{id}", a.handleMonsterGet)
	mux.HandleFunc("PUT /api/bestiary/{id}", a.handleMonsterUpdate)
	mux.HandleFunc("DELETE /api/bestiary/{id}", a.handleMonsterDelete)

	mux.HandleFunc("GET /api/spells", a.handleSpellsList)
	mux.HandleFunc("POST /api/spells", a.handleSpellCreate)
	mux.HandleFunc("GET /api/spells/{id}", a.handleSpellGet)
	mux.HandleFunc("PUT /api/spells/{id}", a.handleSpellUpdate)
	mux.HandleFunc("DELETE /api/spells/{id}", a.handleSpellDelete)

	mux.HandleFunc("GET /api/items", a.handleItemsList)
	mux.HandleFunc("POST /api/items", a.handleItemCreate)
	mux.HandleFunc("GET /api/items/{id}", a.handleItemGet)
	mux.HandleFunc("PUT /api/items/{id}", a.handleItemUpdate)
	mux.HandleFunc("DELETE /api/items/{id}", a.handleItemDelete)

	mux.HandleFunc("GET /api/references", a.handleReferencesList)
	mux.HandleFunc("POST /api/references", a.handleReferenceCreate)
	mux.HandleFunc("GET /api/references/{id}", a.handleReferenceGet)
	mux.HandleFunc("PUT /api/references/{id}", a.handleReferenceUpdate)
	mux.HandleFunc("DELETE /api/references/{id}", a.handleReferenceDelete)

	mux.HandleFunc("GET /api/modifier-targets", a.handleModifierTargets)

	// Импорт компендиумов Foundry VTT по ссылке на манифест — только ДМ,
	// см. foundry_handlers.go.
	mux.HandleFunc("POST /api/foundry/inspect", a.handleFoundryInspect)
	mux.HandleFunc("POST /api/foundry/import", a.handleFoundryImport)
	mux.HandleFunc("GET /api/foundry/modules", a.handleFoundryModules)
	mux.HandleFunc("POST /api/foundry/modules/check", a.handleFoundryModulesCheck)
	mux.HandleFunc("POST /api/foundry/link-scene-tokens", a.handleFoundryLinkSceneTokens)
	mux.HandleFunc("DELETE /api/foundry/modules/{id}", a.handleFoundryModuleDelete)

	mux.HandleFunc("GET /api/conditions", a.handleConditionsList)
	mux.HandleFunc("POST /api/conditions", a.handleConditionCreate)
	mux.HandleFunc("GET /api/conditions/{id}", a.handleConditionGet)
	mux.HandleFunc("PUT /api/conditions/{id}", a.handleConditionUpdate)
	mux.HandleFunc("DELETE /api/conditions/{id}", a.handleConditionDelete)

	// /upload и /assets — без ограничения метода в паттерне (как и раньше):
	// /upload сам проверяет r.Method == POST и пишет 405 иначе; /assets
	// отвечает только на GET по факту использования, но исторически не
	// валидировал метод явно — сохраняем как есть.
	mux.HandleFunc("/upload", a.handleUpload)
	mux.HandleFunc("/assets", a.handleAssets)

	// Папки библиотеки ассетов (см. AssetService.CreateFolder/DeleteFolder)
	// и удаление отдельного файла — уже полноценные /api/*-эндпоинты, в
	// отличие от легаси /upload и /assets выше.
	mux.HandleFunc("POST /api/asset-folders", a.handleAssetFolderCreate)
	mux.HandleFunc("DELETE /api/asset-folders", a.handleAssetFolderDelete)
	mux.HandleFunc("DELETE /api/assets", a.handleAssetDelete)
}
