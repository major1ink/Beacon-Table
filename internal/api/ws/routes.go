package ws

import (
	"net/http"

	"beacon-table/internal/app"
	"beacon-table/internal/domain"
	"beacon-table/internal/service"
)

// RegisterRoutes навешивает /ws/dm, /ws/view, /ws/player на mux. Роль и
// личность резолвятся из cookie-сессии (см. auth.AccountBySession), а не из
// query-параметров: браузер сам прикладывает cookie к WS-хендшейку на том же
// origin, клиенту незачем таскать секрет в адресной строке.
//
// mgr — какой Room обслуживать сейчас, резолвится на КАЖДЫЙ хендшейк (не
// один раз при регистрации маршрутов), потому что Room целиком меняется при
// переключении мира (см. app.CompanyManager.Launch) — если сейчас ничего не
// запущено, отвечаем 503, а не паникуем на nil.
func RegisterRoutes(mux *http.ServeMux, mgr *app.CompanyManager, auth service.AuthService, broadcast service.BroadcastService) {
	mux.HandleFunc("/ws/dm", func(w http.ResponseWriter, r *http.Request) {
		acc, err := sessionAccount(auth, r)
		if err != nil || !acc.IsActive() || !acc.IsAdmin() {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		world := mgr.Current()
		if world == nil {
			http.Error(w, "world not running", http.StatusServiceUnavailable)
			return
		}
		serveWs(world.Room, w, r, domain.RoleDM, acc.ID, acc.Username)
	})
	// /ws/view — зритель (ТВ/проектор): аккаунта у него нет по устройству
	// сценария, вместо него — ключ трансляции, выданный ДМ (см.
	// service.BroadcastService). Раньше канал был открыт вообще всем, что на
	// локальном доверенном экране безобидно, а на публичном адресе означало,
	// что стол ДМ в реальном времени видит любой, кто знает адрес сервера.
	//
	// Аккаунт тоже пускаем: ДМ должен иметь возможность открыть трансляцию
	// у себя и убедиться, что на экране в комнате видно то же самое.
	mux.HandleFunc("/ws/view", func(w http.ResponseWriter, r *http.Request) {
		if !viewerAllowed(auth, broadcast, r) {
			http.Error(w, "нужна ссылка трансляции от ДМ", http.StatusForbidden)
			return
		}
		world := mgr.Current()
		if world == nil {
			http.Error(w, "world not running", http.StatusServiceUnavailable)
			return
		}
		serveWs(world.Room, w, r, domain.RoleTV, "", "")
	})
	mux.HandleFunc("/ws/player", func(w http.ResponseWriter, r *http.Request) {
		acc, err := sessionAccount(auth, r)
		if err != nil || !acc.IsActive() || acc.Role != domain.AccountRolePlayer {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if !mgr.AccountInActiveWorld(acc) {
			http.Error(w, "мир сейчас не запущен ДМ", http.StatusForbidden)
			return
		}
		world := mgr.Current()
		if world == nil {
			http.Error(w, "world not running", http.StatusServiceUnavailable)
			return
		}
		serveWs(world.Room, w, r, domain.RolePlayer, acc.ID, acc.Username)
	})
}

// viewerAllowed — то же правило, что и у api/http для /uploads/ (см.
// API.viewerAllowed): любой активный аккаунт либо телевизор с ключом
// трансляции. Ключ берём из cookie, а если её нет — из адреса: страница
// трансляции открывает WebSocket сама и ключ приложить может, даже когда
// cookie до встроенного браузера приставки не доехала.
func viewerAllowed(auth service.AuthService, broadcast service.BroadcastService, r *http.Request) bool {
	if acc, err := sessionAccount(auth, r); err == nil && acc.IsActive() {
		return true
	}
	key := r.URL.Query().Get(domain.BroadcastKeyParam)
	if c, err := r.Cookie(domain.BroadcastCookieName); err == nil && c.Value != "" {
		key = c.Value
	}
	return broadcast.Valid(r.Context(), key)
}

func sessionAccount(auth service.AuthService, r *http.Request) (*domain.Account, error) {
	c, err := r.Cookie(domain.SessionCookieName)
	if err != nil {
		return nil, domain.ErrNotFound
	}
	return auth.AccountBySession(r.Context(), c.Value)
}
