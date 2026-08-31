package http

import (
	"encoding/json"
	"errors"
	"net/http"

	"beacon-table/internal/domain"
)

// maxUploadSize — лимит на файл в /upload. Поднят с прежних 20 MB под
// музыкальные треки, а затем до 200 MB под mp4-видео-карты (анимированный
// фон сцены) — короткий (10-30 сек) луп в приличном качестве в этот лимит
// укладывается, DM сам сжимает более тяжёлые.
const maxUploadSize = 200 << 20

// handleUpload принимает файл (multipart/form-data, поле "file") — карту,
// токен-арт, аватар персонажа, ассет карты или аудио-трек — сохраняет через
// service.AssetService текущего мира и возвращает URL, по которому его тут
// же можно раздать статикой. Поле "kind" ("maps"/"tokens"/"audio"/"props")
// решает, в какую подпапку класть файл; необязательное поле "folder" — в
// какую вложенную папку внутри kind (сейчас реально используется только у
// "props", см. web/dm.html: раздел "Ассеты"). Правило "maps/audio/props —
// только ДМ" применяет сам AssetService (см. его комментарий), здесь только
// транспорт.
func (a *API) handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	acc, err := a.sessionAccount(r)
	if err != nil || !acc.IsActive() {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if !acc.IsAdmin() && !a.Companies.AccountInActiveWorld(acc) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	world := a.Companies.Current()
	if world == nil {
		http.Error(w, "world not running", http.StatusServiceUnavailable)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize)
	//nolint:gosec // G120: тело уже ограничено MaxBytesReader выше — gosec
	// не умеет это распознавать (его taint-анализ ParseMultipartForm не
	// знает про MaxBytesReader как санитайзер), см. github.com/securego/gosec.
	if err := r.ParseMultipartForm(maxUploadSize); err != nil {
		http.Error(w, "file too large", http.StatusBadRequest)
		return
	}
	kind := r.FormValue("kind")
	folder := r.FormValue("folder")

	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "no file", http.StatusBadRequest)
		return
	}
	defer file.Close()

	url, err := world.Assets.Upload(r.Context(), acc, kind, folder, header.Filename, file)
	if err != nil {
		switch {
		case errors.Is(err, domain.ErrForbidden):
			http.Error(w, "forbidden", http.StatusForbidden)
		case errors.Is(err, domain.ErrNoSpace):
			// 507: данные верные, не хватило места — сообщение с цифрами
			// формирует quota, фронт показывает его как есть.
			http.Error(w, err.Error(), http.StatusInsufficientStorage)
		default:
			http.Error(w, "save failed", http.StatusInternalServerError)
		}
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"url": url})
}

// handleAssets отдаёт список уже загруженных карт/токенов/аудио/пропов
// текущего мира, чтобы DM мог выбрать файл повторно (например на следующей
// сессии) вместо того, чтобы заново лезть в проводник и аплоадить его ещё
// раз. Только ДМ — это его библиотека карт/NPC-токенов/ассетов, игрокам она
// не нужна. Кроме плоских списков файлов (ключи — kind, как и раньше) ответ
// несёт "folders" — карту kind → список папок (включая пустые), см.
// domain.AssetFolder.
func (a *API) handleAssets(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	files, err := world.Assets.List(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	folders, err := world.Assets.FoldersAll(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	resp := make(map[string]any, len(files)+2)
	for kind, items := range files {
		resp[kind] = items
	}
	resp["folders"] = folders
	// Место под загрузками — чтобы ДМ видел запас заранее, а не упирался в
	// «места нет» посреди игры. Без заданных квот блок не отдаётся вовсе.
	if q := a.Companies.UploadQuota(world.Company); q.Limit() > 0 || q.TotalLimit() > 0 {
		resp["storage"] = map[string]any{
			"worldUsed":  q.Used(),
			"worldLimit": q.Limit(),
			"totalUsed":  q.TotalUsed(),
			"totalLimit": q.TotalLimit(),
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

// handleAssetFolderCreate создаёt подпапку библиотеки ассетов — POST
// /api/asset-folders, тело {kind, path}. path — полный путь от корня kind
// (см. domain.AssetFolder.Path), UI обычно шлёт "текущая-папка/новое-имя".
func (a *API) handleAssetFolderCreate(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAdminAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	var req struct{ Kind, Path string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	if err := world.Assets.CreateFolder(r.Context(), acc, req.Kind, req.Path); err != nil {
		if errors.Is(err, domain.ErrForbidden) {
			writeErr(w, http.StatusForbidden, "forbidden")
			return
		}
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"status": "ok"})
}

// handleAssetFolderDelete удаляет подпапку библиотеки ассетов вместе со
// всем содержимым — DELETE /api/asset-folders?kind=..&path=...
func (a *API) handleAssetFolderDelete(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAdminAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	kind := r.URL.Query().Get("kind")
	path := r.URL.Query().Get("path")
	if err := world.Assets.DeleteFolder(r.Context(), acc, kind, path); err != nil {
		if errors.Is(err, domain.ErrForbidden) {
			writeErr(w, http.StatusForbidden, "forbidden")
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleAssetDelete удаляет один файл библиотеки ассетов — DELETE
// /api/assets?kind=..&url=...
func (a *API) handleAssetDelete(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAdminAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	kind := r.URL.Query().Get("kind")
	url := r.URL.Query().Get("url")
	if err := world.Assets.DeleteAsset(r.Context(), acc, kind, url); err != nil {
		if errors.Is(err, domain.ErrForbidden) {
			writeErr(w, http.StatusForbidden, "forbidden")
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
