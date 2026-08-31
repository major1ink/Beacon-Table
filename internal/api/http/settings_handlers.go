package http

import (
	"encoding/json"
	"net/http"
)

// Откуда взялось действующее значение настройки.
const (
	SourceFlag    = "flag"
	SourceEnv     = "env"
	SourceFile    = "file"
	SourceDefault = "default"
)

// Setting — одна настройка глазами ДМ.
type Setting struct {
	Key string `json:"key"`
	// Section — заголовок группы, в которую поле попадает в форме.
	Section string   `json:"section"`
	Title   string   `json:"title"`
	Hint    string   `json:"hint"`
	Kind    string   `json:"kind"`
	Options []string `json:"options,omitempty"`
	Value   string   `json:"value"`
	// Source — flag/env/file/default: показывает, почему поле может быть
	// недоступно для правки.
	Source string `json:"source"`
	// Editable — можно ли менять отсюда; Locked — почему нельзя.
	Editable bool   `json:"editable"`
	Locked   string `json:"locked,omitempty"`
	// AppliesNow — применится сразу, без перезапуска сервера.
	AppliesNow bool `json:"appliesNow"`
}

// SettingsStore — работа с настройками со стороны композиционного корня:
// api-слой не знает ни про формат файла, ни про то, где он лежит.
type SettingsStore interface {
	// List — текущее состояние всех настроек.
	List() []Setting
	// Save записывает изменения в файл настроек и применяет те, что можно
	// применить на лету. Возвращает имена настроек, которым нужен
	// перезапуск, чтобы форма сказала об этом честно.
	Save(values map[string]string) (needRestart []string, err error)
}

// handleSettingsList — GET /api/settings (только ДМ).
func (a *API) handleSettingsList(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	if a.Settings == nil {
		writeErr(w, http.StatusServiceUnavailable, "настройки недоступны")
		return
	}
	writeJSON(w, http.StatusOK, a.Settings.List())
}

// handleSettingsSave — PUT /api/settings (только ДМ): {"BEACON_LOG_LEVEL":
// "debug", ...}. Проверка значений и запрет на закрытые настройки — на
// стороне SettingsStore: полагаться на то, что форма не пришлёт лишнего,
// нельзя.
func (a *API) handleSettingsSave(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdminAccount(w, r); !ok {
		return
	}
	if a.Settings == nil {
		writeErr(w, http.StatusServiceUnavailable, "настройки недоступны")
		return
	}
	var values map[string]string
	if err := json.NewDecoder(r.Body).Decode(&values); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	needRestart, err := a.Settings.Save(values)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":      "ok",
		"needRestart": needRestart,
		"settings":    a.Settings.List(),
	})
}
