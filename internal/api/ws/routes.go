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
func RegisterRoutes(mux *http.ServeMux, mgr *app.CompanyManager, auth service.AuthService) {
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
	// /ws/view — без авторизации: зритель (TV/проектор на локальном
	// доверенном экране, см. README) — всегда видит тот мир, что сейчас
	// запущен на сервере, безотносительно какого-либо аккаунта.
	mux.HandleFunc("/ws/view", func(w http.ResponseWriter, r *http.Request) {
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

func sessionAccount(auth service.AuthService, r *http.Request) (*domain.Account, error) {
	c, err := r.Cookie(domain.SessionCookieName)
	if err != nil {
		return nil, domain.ErrNotFound
	}
	return auth.AccountBySession(r.Context(), c.Value)
}
