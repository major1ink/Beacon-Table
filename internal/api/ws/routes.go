package ws

import (
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"beacon-table/internal/app"
	"beacon-table/internal/domain"
	"beacon-table/internal/service"
)

// Gateway — все живые WS-подключения стола. Нужен ровно для одного:
// закрыть их при остановке сервера. http.Server.Shutdown этого не сделает —
// после апгрейда соединение hijacked, сервер его больше не отслеживает, и
// без Gateway оно просто обрывалось бы на выходе процесса, а браузер видел
// бы разрыв TCP вместо внятного «сервер перезапускается».
type Gateway struct {
	// upgrader держит проверку Origin (см. origin.go) — она зависит от
	// настроек запуска, поэтому живёт здесь, а не в пакетной переменной.
	upgrader websocket.Upgrader

	mu    sync.Mutex
	conns map[*websocket.Conn]struct{}
	// closing — сервер уже останавливается: новые подключения принимать
	// поздно, иначе соединение, проскочившее между CloseAll и выходом
	// процесса, снова повисло бы необорванным.
	closing bool
}

func newGateway(opts Options) *Gateway {
	return &Gateway{
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return checkOrigin(r, opts) },
		},
		conns: map[*websocket.Conn]struct{}{},
	}
}

// track берёт соединение под присмотр. false — сервер уже останавливается,
// вызывающему остаётся закрыть соединение и уйти.
func (g *Gateway) track(conn *websocket.Conn) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closing {
		return false
	}
	g.conns[conn] = struct{}{}
	return true
}

func (g *Gateway) untrack(conn *websocket.Conn) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.conns, conn)
}

// CloseAll вежливо прощается со всеми экранами: код 1012 «сервис
// перезапускается» — тот самый случай, для которого он в стандарте и
// заведён. Браузер получает закрытие сразу, а не по таймауту мёртвого
// соединения. Ошибки записи игнорируются намеренно: половина соединений на
// этом этапе может быть уже мертва, и делать с этим всё равно нечего —
// соединение закрывается следом в любом случае.
func (g *Gateway) CloseAll() {
	g.mu.Lock()
	g.closing = true
	conns := make([]*websocket.Conn, 0, len(g.conns))
	for conn := range g.conns {
		conns = append(conns, conn)
	}
	g.conns = map[*websocket.Conn]struct{}{}
	g.mu.Unlock()

	bye := websocket.FormatCloseMessage(websocket.CloseServiceRestart, "сервер перезапускается")
	for _, conn := range conns {
		_ = conn.WriteControl(websocket.CloseMessage, bye, time.Now().Add(time.Second))
		_ = conn.Close()
	}
}

// RegisterRoutes навешивает /ws/dm, /ws/view, /ws/player на mux. Роль и
// личность резолвятся из cookie-сессии (см. auth.AccountBySession), а не из
// query-параметров: браузер сам прикладывает cookie к WS-хендшейку на том же
// origin, клиенту незачем таскать секрет в адресной строке.
//
// mgr — какой Room обслуживать сейчас, резолвится на КАЖДЫЙ хендшейк (не
// один раз при регистрации маршрутов), потому что Room целиком меняется при
// переключении мира (см. app.CompanyManager.Launch) — если сейчас ничего не
// запущено, отвечаем 503, а не паникуем на nil.
func RegisterRoutes(mux *http.ServeMux, mgr *app.CompanyManager, auth service.AuthService, broadcast service.BroadcastService, opts Options) *Gateway {
	gw := newGateway(opts)
	mux.HandleFunc("/ws/dm", func(w http.ResponseWriter, r *http.Request) {
		acc, err := sessionAccount(auth, r)
		if err != nil || !acc.IsActive() || !acc.IsGM() {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		world := mgr.Current()
		if world == nil {
			http.Error(w, "world not running", http.StatusServiceUnavailable)
			return
		}
		serveWs(gw, world.Room, w, r, domain.RoleDM, acc.ID, acc.Username)
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
		serveWs(gw, world.Room, w, r, domain.RoleTV, "", "")
	})
	mux.HandleFunc("/ws/player", func(w http.ResponseWriter, r *http.Request) {
		acc, err := sessionAccount(auth, r)
		if err != nil || !acc.IsActive() || !acc.IsPlayer() {
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
		serveWs(gw, world.Room, w, r, domain.RolePlayer, acc.ID, acc.Username)
	})
	return gw
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
