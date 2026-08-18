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

	mux.HandleFunc("GET /api/characters", a.handleCharactersList)
	mux.HandleFunc("POST /api/characters", a.handleCharacterCreate)
	mux.HandleFunc("GET /api/characters/{id}", a.handleCharacterGet)
	mux.HandleFunc("PUT /api/characters/{id}", a.handleCharacterUpdate)
	mux.HandleFunc("PUT /api/characters/{id}/sheet", a.handleCharacterSheetUpdate)
	mux.HandleFunc("DELETE /api/characters/{id}", a.handleCharacterDelete)

	// Инвентарь персонажа (см. domain.InventoryEntry) — своя sub-collection,
	// не часть /sheet выше (см. комментарий repository.CharacterRepository и
	// план фичи про гонку с автосейвом листа).
	mux.HandleFunc("GET /api/characters/{id}/inventory", a.handleCharacterInventoryList)
	mux.HandleFunc("POST /api/characters/{id}/inventory", a.handleCharacterInventoryAdd)
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

	mux.HandleFunc("GET /api/admin/playlists", a.handleAdminPlaylistsList)
	mux.HandleFunc("POST /api/admin/playlists", a.handleAdminPlaylistCreate)
	mux.HandleFunc("PUT /api/admin/playlists/{id}", a.handleAdminPlaylistRename)
	mux.HandleFunc("DELETE /api/admin/playlists/{id}", a.handleAdminPlaylistDelete)
	mux.HandleFunc("POST /api/admin/playlists/{id}/tracks", a.handleAdminPlaylistTrackAdd)
	mux.HandleFunc("PUT /api/admin/playlists/{id}/tracks/{trackId}", a.handleAdminPlaylistTrackUpdate)
	mux.HandleFunc("DELETE /api/admin/playlists/{id}/tracks/{trackId}", a.handleAdminPlaylistTrackDelete)
	mux.HandleFunc("POST /api/admin/playlists/{id}/tracks/{trackId}/move", a.handleAdminPlaylistTrackMove)

	mux.HandleFunc("GET /api/notes", a.handleNotesList)
	mux.HandleFunc("POST /api/notes", a.handleNoteCreate)
	mux.HandleFunc("GET /api/notes/{id}", a.handleNoteGet)
	mux.HandleFunc("PUT /api/notes/{id}", a.handleNoteUpdate)
	mux.HandleFunc("DELETE /api/notes/{id}", a.handleNoteDelete)

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
