// Beacon Table — сервер виртуального стола для настольных ролевых игр.

package main

import (
	"context"
	"embed"
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
	apiws.RegisterRoutes(mux, companies, authSvc, broadcastSvc)

	// Ловим Ctrl+C/остановку службы и сохраняем текущий мир перед выходом
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigCh
		log.Println("завершение работы, сохраняю мир...")
		companies.Shutdown()
		db.Close()
		os.Exit(0)
	}()

	addr := ":8080"
	log.Println("Beacon Table сервер запущен на", addr)
	printAccessURLs()
	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Fatal(srv.ListenAndServe())
}
