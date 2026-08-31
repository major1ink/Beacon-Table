// Beacon Table — сервер виртуального стола для настольных ролевых игр.

package main

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	apihttp "beacon-table/internal/api/http"
	apiws "beacon-table/internal/api/ws"
	"beacon-table/internal/app"
	"beacon-table/internal/repository/sqlite"
	"beacon-table/internal/service"
)

//go:embed static
var staticFiles embed.FS

// systemFiles — каталог монстров/заклинаний/предметов "из коробки", зашитый
// в бинарник на этапе компиляции (см. internal/repository/monsterfile.SystemStore/
// spellfile.SystemStore/itemfile.SystemStore), под подпапкой на систему
// (systemdata/bestiary/<system>/…, см. cmd/beacon-table/systemdata/README.md) —
// правится только правкой файлов в systemdata/ и пересборкой, а не через
// API/UI, в отличие от пользовательской библиотеки в dataDir. Отдельная
// директива embed от staticFiles (не заворачиваем сюда же) — разное
// назначение и время жизни, static раздаётся как есть http.FS'ом, а
// systemdata парсится JSON'ом в конкретные структуры.
//
//go:embed systemdata
var systemFiles embed.FS

const (
	dataDir         = "data"
	dbPath          = "data/beacon.db"
	uploadsDir      = "uploads"
	uploadsURL      = "/uploads/"
	systemAssetsURL = "/system-assets/"
)

func main() {
	ctx := context.Background()
	version := serverVersion()
	log.Println("Beacon Table версия:", version)

	if err := os.MkdirAll(dataDir, 0o750); err != nil {
		log.Fatal(err)
	}

	db, err := sqlite.Open(dbPath)
	if err != nil {
		log.Fatal("не удалось открыть базу аккаунтов:", err)
	}
	accountRepo := sqlite.NewAccountStore(db)
	sessionRepo := sqlite.NewSessionStore(db, accountRepo)
	companyRepo := sqlite.NewCompanyStore(db)
	stateRepo := sqlite.NewServerStateStore(db)
	dice := service.NewDiceRoller()

	// ---- CompanyManager: собирает per-мировые репозитории/сервисы (сцены,
	// бестиарий/заклинания/предметы, персонажи, плейлисты, заметки, ассеты,
	// Room) заново при каждом переключении мира — см. internal/app. Auth
	// (аккаунты/сессии) — единственный полностью глобальный сервис, живёт
	// здесь, а не внутри неё (см. её package-doc).
	companies := app.NewCompanyManager(db, companyRepo, accountRepo, sessionRepo, dice, systemFiles, dataDir, uploadsDir, uploadsURL)

	authSvc := service.NewAuthService(accountRepo, sessionRepo)
	broadcastSvc := service.NewBroadcastService(stateRepo)
	if err := authSvc.SeedAdmin(ctx); err != nil {
		log.Fatal("не удалось создать/проверить аккаунт ДМ:", err)
	}
	if err := companies.Bootstrap(ctx); err != nil {
		log.Fatal("не удалось поднять миры:", err)
	}

	mux := http.NewServeMux()

	sub, err := fs.Sub(staticFiles, "static")
	if err != nil {
		log.Fatal(err)
	}
	static := http.FileServer(http.FS(sub))
	mux.Handle("/", static)

	api := apihttp.NewAPI(authSvc, broadcastSvc, companies, version)

	mux.Handle("GET /broadcast.html", api.BroadcastEntry(static))

	mux.Handle(uploadsURL, api.RequireViewer(
		http.StripPrefix(uploadsURL, http.FileServer(apihttp.NoDirListing{FS: http.Dir(uploadsDir)})),
	))

	systemAssets, err := fs.Sub(systemFiles, "systemdata/assets")
	if err != nil {
		log.Fatal(err)
	}
	mux.Handle(systemAssetsURL, http.StripPrefix(systemAssetsURL, http.FileServer(http.FS(systemAssets))))

	api.RegisterRoutes(mux)
	gateway := apiws.RegisterRoutes(mux, companies, authSvc, broadcastSvc)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)

	addr := ":8080"
	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()
	log.Println("Beacon Table сервер запущен на", addr)
	printAccessURLs()

	<-sigCh
	shutdown(srv, gateway, companies, db)
}

// shutdownTimeout — сколько ждём запросы, начатые до остановки. Пятнадцать
// секунд: столько может занять сохранение листа персонажа или разбор
// загруженной карты, а systemd по умолчанию даёт на остановку девяносто.
const shutdownTimeout = 15 * time.Second

// shutdown останавливает сервер по порядку, в котором каждый следующий шаг
// не может помешать предыдущему:
//
//  1. перестаём принимать новое и даём договорить уже начатым HTTP-запросам —
//     иначе загрузка карты или сохранение листа рвались бы на середине;
//  2. закрываем WS: http.Server.Shutdown их не ждёт (после апгрейда
//     соединение hijacked), поэтому прощаемся сами, а не бросаем сокет;
//  3. только теперь сохраняем мир — правки к этому моменту уже не приходят
//     ни по HTTP, ни по WS, так что на диск ложится итоговое состояние;
//  4. закрываем базу: на закрытии последнего соединения SQLite сливает WAL
//     в основной файл, и рядом с beacon.db не остаётся -wal с данными.
func shutdown(srv *http.Server, gateway *apiws.Gateway, companies *app.CompanyManager, db *sql.DB) {
	log.Println("завершение работы, сохраняю мир...")

	ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		// Не дождались — дальше всё равно закрываемся: мир сохранить важнее,
		// чем дотерпеть зависший запрос.
		log.Println("не все запросы успели завершиться:", err)
	}
	gateway.CloseAll()
	companies.Shutdown()
	if err := db.Close(); err != nil {
		log.Println("ошибка закрытия базы:", err)
	}
	log.Println("сервер остановлен")
}
