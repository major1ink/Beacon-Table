package http

import (
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"os"

	"beacon-table/internal/app"
	"beacon-table/internal/domain"
)

// handleSceneExport — GET /api/scenes/{id}/export[?media=0]: сцена одним
// .zip (см. app.CompanyManager.ExportScene). media=0 — без картинок и
// звуков: дамп для отчёта о баге.
func (a *API) handleSceneExport(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	id := r.PathValue("id")
	cards, err := world.Room.ListScenes(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	name := ""
	for _, c := range cards {
		if c.ID == id {
			name = c.Name
		}
	}
	if name == "" {
		writeErr(w, http.StatusNotFound, "сцена не найдена")
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": app.ScenePackName(name)}))
	if err := a.Companies.ExportScene(r.Context(), id, a.Version, r.URL.Query().Get("media") != "0", w); err != nil {
		// Заголовки уже ушли — статус не поменять, клиент получит оборванный zip.
		//nolint:gosec // G706: id сверен со списком сцен выше
		slog.Error("Экспорт сцены оборвался", "scene_id", id, "err", err)
	}
}

// handleSceneImport — POST /api/scenes/import: .zip из handleSceneExport
// (multipart, поле "file") становится новой сценой запущенного мира.
func (a *API) handleSceneImport(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAdminAccount(w, r)
	if !ok {
		return
	}
	if _, ok := a.requireWorld(w); !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxWorldImportSize)
	//nolint:gosec // G120: тело уже ограничено MaxBytesReader выше
	if err := r.ParseMultipartForm(multipartMemoryBudget); err != nil {
		writeErr(w, http.StatusBadRequest, "файл слишком большой")
		return
	}
	file, _, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "нет файла")
		return
	}
	defer file.Close()

	tmp, err := os.CreateTemp("", "beacon-scene-*.zip")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
	}()
	size, err := io.Copy(tmp, file)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "не удалось прочитать файл")
		return
	}
	scene, err := a.Companies.ImportScene(r.Context(), acc, tmp, size)
	if err != nil {
		var verr *domain.ValidationError
		switch {
		case errors.As(err, &verr):
			writeErr(w, http.StatusBadRequest, verr.Msg)
		case errors.Is(err, domain.ErrForbidden):
			writeErr(w, http.StatusForbidden, "нет доступа")
		default:
			writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		}
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"id": scene.ID, "name": scene.Name})
}
