package http

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"beacon-table/internal/domain"
)

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
