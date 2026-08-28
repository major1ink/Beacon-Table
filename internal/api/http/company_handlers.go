package http

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"beacon-table/internal/domain"
)

// maxWorldImportSize — потолок на загружаемый .zip мира. Миры с видео-картами
// бывают тяжёлыми, поэтому лимит выше, чем у обычного /upload.
const maxWorldImportSize = 1 << 30

// ---- ДМ: миры (компании), см. internal/app.CompanyManager — экран
// worlds.html, аналог Foundry Setup ----

func (a *API) handleCompaniesList(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	companies, err := a.Companies.List(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	activeID := a.Companies.ActiveCompanyID()
	out := make([]map[string]any, 0, len(companies))
	for _, c := range companies {
		out = append(out, map[string]any{
			"id": c.ID, "name": c.Name, "system": c.System,
			"active": c.ID == activeID, "createdAt": c.CreatedAt.Format(time.RFC3339),
		})
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *API) handleCompanyCreate(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	var req struct{ Name, System string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	c, err := a.Companies.Create(r.Context(), req.Name, req.System)
	if err != nil {
		var verr *domain.ValidationError
		if errors.As(err, &verr) {
			writeErr(w, http.StatusBadRequest, verr.Msg)
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": c.ID, "name": c.Name, "system": c.System, "active": false})
}

// handleCompanyLaunch — переключает сервер на этот мир (см.
// app.CompanyManager.Launch: гасит текущий Room с flush на диск, поднимает
// новый). Синхронный — ответ уходит только после того, как новый мир
// реально поднялся.
func (a *API) handleCompanyLaunch(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	if err := a.Companies.Launch(r.Context(), r.PathValue("id")); err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "мир не найден")
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (a *API) handleCompanyDelete(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	if err := a.Companies.Delete(r.Context(), r.PathValue("id")); err != nil {
		switch {
		case errors.Is(err, domain.ErrForbidden):
			writeErr(w, http.StatusBadRequest, "нельзя удалить запущенный мир — сначала запусти другой")
		case errors.Is(err, domain.ErrConflict):
			writeErr(w, http.StatusConflict, "в этом мире ещё есть аккаунты — сначала удали их")
		default:
			writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleCompanyExport — GET /api/companies/{id}/export — отдаёт мир одним
// .beacon-world.zip (см. app.CompanyManager.ExportWorld): сцены, журнал,
// библиотеки, плейлисты, преген-персонажи, загрузки. Без аккаунтов и
// персонажей игроков.
func (a *API) handleCompanyExport(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	c, err := a.Companies.CompanyByID(r.Context(), r.PathValue("id"))
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "мир не найден")
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.beacon-world.zip"`, worldFileSlug(c.Name)))
	if err := a.Companies.ExportWorld(r.Context(), c.ID, a.Version, w); err != nil {
		// Заголовки уже ушли — HTTP-статус не поменять; клиент получит
		// оборванный zip. Логируем, чтобы причина не потерялась.
		//nolint:gosec // G706: c.ID — 32-hex id из companies.ByID, не пользовательский ввод
		log.Printf("экспорт мира %s: %v", c.ID, err)
	}
}

// handleCompanyImport — POST /api/companies/import — принимает .zip
// (multipart, поле "file") и создаёт из него новый мир (см.
// app.CompanyManager.ImportWorld). Запускать мир ДМ должен сам на /worlds.html.
func (a *API) handleCompanyImport(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxWorldImportSize)
	//nolint:gosec // G120: тело уже ограничено MaxBytesReader выше
	if err := r.ParseMultipartForm(maxWorldImportSize); err != nil {
		writeErr(w, http.StatusBadRequest, "файл слишком большой")
		return
	}
	file, _, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "нет файла")
		return
	}
	defer file.Close()

	tmp, err := os.CreateTemp("", "beacon-world-*.zip")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	_, copyErr := io.Copy(tmp, file)
	closeErr := tmp.Close()
	if copyErr != nil || closeErr != nil {
		writeErr(w, http.StatusBadRequest, "не удалось прочитать файл")
		return
	}

	c, err := a.Companies.ImportWorld(r.Context(), tmp.Name())
	if err != nil {
		var verr *domain.ValidationError
		if errors.As(err, &verr) {
			writeErr(w, http.StatusBadRequest, verr.Msg)
			return
		}
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": c.ID, "name": c.Name, "system": c.System, "active": false})
}

// worldFileSlug — безопасное ASCII-имя файла экспорта из названия мира
// (Content-Disposition filename нелатиницу не гарантирует). Нелатинские
// названия дадут "world" — сам архив от имени файла не зависит.
func worldFileSlug(name string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(name) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		case r == ' ':
			b.WriteRune('-')
		}
		if b.Len() >= 60 {
			break
		}
	}
	slug := strings.Trim(b.String(), "-")
	if slug == "" {
		return "world"
	}
	return slug
}
