package http

import (
	"context"
	"log/slog"
	"net/http"
	"time"
)

// healthTimeout — сколько ждём ответа базы. Мониторинг опрашивает часто, и
// висящая проверка хуже честного «плохо»: две секунды достаточно, чтобы
// отличить занятую базу от мёртвой.
const healthTimeout = 2 * time.Second

// Pinger — то, что умеет ответить «база жива». Реализуется *sql.DB.
type Pinger interface {
	PingContext(ctx context.Context) error
}

// handleHealth — GET /healthz для мониторинга и автоперезапуска: 200, если
// база отвечает, 503 если нет. Без авторизации — проверять живость должен
// уметь и systemd, и docker healthcheck, у которых аккаунта нет; ничего,
// кроме факта работоспособности и версии, ручка не сообщает.
//
// Запущенный мир НЕ проверяется: «ни один мир не запущен» — нормальное
// состояние свежей установки, сервер при этом жив и ждёт ДМ.
func (a *API) handleHealth(w http.ResponseWriter, r *http.Request) {
	resp := map[string]string{"status": "ok", "version": a.Version}

	if a.Health != nil {
		ctx, cancel := context.WithTimeout(r.Context(), healthTimeout)
		defer cancel()
		if err := a.Health.PingContext(ctx); err != nil {
			slog.Error("проверка живости: база не отвечает", "err", err)
			resp["status"] = "база не отвечает"
			writeJSON(w, http.StatusServiceUnavailable, resp)
			return
		}
	}
	writeJSON(w, http.StatusOK, resp)
}
