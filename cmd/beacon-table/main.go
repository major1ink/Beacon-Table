// Beacon Table — сервер виртуального стола для настольных ролевых игр.
//
// Это композиционный корень приложения: единственное место (вместе с
// internal/app, который делает то же самое заново при переключении мира,
// см. app.CompanyManager.Launch), где известны конкретные реализации
// (SQLite, файловая система) и где они собираются в сервисы, а сервисы — в
// HTTP/WS API. Ни один из внутренних пакетов (internal/service, internal/api/...)
// не знает про internal/repository/sqlite или internal/repository/scenefile
// напрямую — только про интерфейсы internal/repository, которые здесь и
// подключаются.
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

	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		log.Fatal(err)
	}

	db, err := sqlite.Open(dbPath)
	if err != nil {
		log.Fatal("не удалось открыть базу аккаунтов:", err)
	}
	accountRepo := sqlite.NewAccountStore(db)
	sessionRepo := sqlite.NewSessionStore(db, accountRepo)
	companyRepo := sqlite.NewCompanyStore(db)
	dice := service.NewDiceRoller()

	// ---- CompanyManager: собирает per-мировые репозитории/сервисы (сцены,
	// бестиарий/заклинания/предметы, персонажи, плейлисты, заметки, ассеты,
	// Room) заново при каждом переключении мира — см. internal/app. Auth
	// (аккаунты/сессии) — единственный полностью глобальный сервис, живёт
	// здесь, а не внутри неё (см. её package-doc).
	companies := app.NewCompanyManager(db, companyRepo, accountRepo, sessionRepo, dice, systemFiles, dataDir, uploadsDir, uploadsURL)

	authSvc := service.NewAuthService(accountRepo, sessionRepo)
	if err := authSvc.SeedAdmin(ctx); err != nil {
		log.Fatal("не удалось создать/проверить аккаунт ДМ:", err)
	}
	if err := companies.Bootstrap(ctx); err != nil {
		log.Fatal("не удалось поднять миры:", err)
	}

	// ---- api-слой: HTTP/WS транспорт поверх интерфейсов service ----
	mux := http.NewServeMux()

	sub, err := fs.Sub(staticFiles, "static")
	if err != nil {
		log.Fatal(err)
	}
	mux.Handle("/", http.FileServer(http.FS(sub))) // static/index.html — единая точка входа (логин/регистрация)

	// Загруженные карты/токены живут на диске, а не в embed.FS — embed
	// зашивается только на этапе компиляции, рантайм-аплоады физически не
	// могут туда попасть. Один и тот же корень "uploads" обслуживает все
	// миры разом (см. app.CompanyManager.rootsFor) — новые миры пишут в
	// свою подпапку uploads/companies/<id>/, легаси — прямо в корень, но
	// раздача статикой в обоих случаях идёт этим одним хендлером.
	mux.Handle(uploadsURL, http.StripPrefix(uploadsURL, http.FileServer(http.Dir(uploadsDir))))

	// system-assets — картинки каталога "из коробки" (systemdata/assets/<system>/...,
	// см. cmd/beacon-table/systemdata/README.md), зашитые в бинарник вместе с
	// остальным systemFiles: Item/Monster/Reference.ImageURL карточек "из
	// коробки" указывают сюда (в отличие от uploads/ — этот каталог только на
	// чтение и целиком собирается на этапе компиляции, рантайм в него не
	// пишет).
	systemAssets, err := fs.Sub(systemFiles, "systemdata/assets")
	if err != nil {
		log.Fatal(err)
	}
	mux.Handle(systemAssetsURL, http.StripPrefix(systemAssetsURL, http.FileServer(http.FS(systemAssets))))

	apihttp.NewAPI(authSvc, companies, version).RegisterRoutes(mux)
	apiws.RegisterRoutes(mux, companies, authSvc)

	// Ловим Ctrl+C/остановку службы и сохраняем текущий мир перед выходом, а
	// не полагаемся только на автосейв по таймеру — иначе последние секунды
	// правок (стены, туман, позиции токенов) терялись бы при штатном
	// перезапуске сервера.
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
	log.Fatal(http.ListenAndServe(addr, mux))
}
