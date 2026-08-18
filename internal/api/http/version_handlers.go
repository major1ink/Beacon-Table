package http

import "net/http"

// handleVersion — версия сервера (см. cmd/beacon-table/version.go).
// Без авторизации: отображается на экранах логина/настроек и до, и после
// входа, ничего чувствительного не раскрывает (это commit hash, не секрет).
func (a *API) handleVersion(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"version": a.Version})
}
