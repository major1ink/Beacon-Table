// Beacon Table — сервер виртуального стола для настольных ролевых игр.

package main

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"flag"
	"io/fs"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	apihttp "beacon-table/internal/api/http"
	apiws "beacon-table/internal/api/ws"
	"beacon-table/internal/app"
	"beacon-table/internal/backup"
	"beacon-table/internal/quota"
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

// Пути раздачи — не настройка: адреса внутри приложения, на них завязаны
// ссылки в базе (см. app.CompanyManager.rootsFor) и код фронтенда.
const (
	uploadsURL      = "/uploads/"
	systemAssetsURL = "/system-assets/"
)

func main() {
	ctx := context.Background()

	// Подкоманда `beacon-table backup` — один бэкап и выход, аргументы после
	// неё разбираются как обычные (--data, --config).
	if len(os.Args) > 1 && os.Args[1] == "backup" {
		runBackupCommand(os.Args[2:])
		return
	}

	// Настройки разбираем до всего остального: с --help программа должна
	// напечатать справку и выйти молча, не создавая каталогов и не печатая
	// ничего лишнего.
	cfg, configFile, err := loadConfig(os.Args[1:])
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return // справку flag напечатал сам
		}
		log.Fatal(err) // журнал ещё не настроен — печатаем как есть
	}

	logLevel := setupLogging(cfg)
	settingsFile = configFile

	version := serverVersion()
	log.Println("Beacon Table версия:", version)
	if configFile != "" {
		//nolint:gosec // G706: путь пришёл из аргументов запуска/окружения,
		// не по сети — подставить в него перевод строки может только тот,
		// кто и так запускает процесс.
		log.Println("настройки из файла:", configFile)

		// Файл создаётся один раз, а настройки в новых версиях прибавляются:
		// дописываем недостающие, чтобы обновивший бинарник о них узнал.
		// Ошибку не считаем фатальной — файл может лежать только для чтения.
		if added, err := syncConfigFile(configFile); err != nil {
			slog.Warn("не удалось дописать новые настройки в файл", "file", configFile, "err", err)
		} else if len(added) > 0 {
			slog.Info("в файл настроек добавлены новые параметры",
				"file", configFile, "параметры", strings.Join(added, ", "))
		}
	}

	if err := os.MkdirAll(cfg.DataDir, 0o750); err != nil {
		fatal("не удалось создать каталог данных", "путь", cfg.DataDir, "err", err)
	}

	db, err := sqlite.Open(cfg.DBPath())
	if err != nil {
		fatal("не удалось открыть базу", "путь", cfg.DBPath(), "err", err)
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
	//
	// За обратным прокси (сервер в интернете) импорт модулей Foundry не
	// должен ходить в приватную сеть — там нет ни локального зеркала, ни
	// причин туда стучаться, зато есть служебные адреса облака.

	// Учёт места под загрузками: один трекер на сервер, у каждого мира свой
	// вид на него (см. internal/quota). Считаем каталог сразу — первая же
	// загрузка должна знать реальную картину, а не начинать с нуля.
	uploadQuota := quota.New(cfg.UploadsDir, cfg.UploadsQuota, cfg.UploadsWorldQuota)
	if cfg.UploadsQuota > 0 || cfg.UploadsWorldQuota > 0 {
		if err := uploadQuota.Scan(); err != nil {
			fatal("не удалось посчитать занятое место в каталоге загрузок", "путь", cfg.UploadsDir, "err", err)
		}
		slog.Info("квота загрузок",
			"занято", quota.FormatSize(uploadQuota.TotalUsed()),
			"предел", quota.FormatSize(cfg.UploadsQuota),
			"на мир", quota.FormatSize(cfg.UploadsWorldQuota))
	}

	companies := app.NewCompanyManager(db, companyRepo, accountRepo, sessionRepo, dice, systemFiles, cfg.DataDir, cfg.UploadsDir, uploadsURL, !cfg.BehindProxy, uploadQuota)

	authSvc := service.NewAuthService(accountRepo, sessionRepo)
	broadcastSvc := service.NewBroadcastService(stateRepo)
	if err := authSvc.SeedAdmin(ctx); err != nil {
		fatal("не удалось создать или проверить аккаунт ДМ", "err", err)
	}
	if err := companies.Bootstrap(ctx); err != nil {
		fatal("не удалось поднять миры", "err", err)
	}

	mux := http.NewServeMux()

	sub, err := fs.Sub(staticFiles, "static")
	if err != nil {
		fatal("не удалось открыть встроенный фронтенд", "err", err)
	}
	static := http.FileServer(http.FS(sub))
	mux.Handle("/", static)

	api := apihttp.NewAPI(authSvc, broadcastSvc, companies, version, cfg.BehindProxy, db)
	// Форма настроек в разделе «Настройки» у ДМ: пишет в тот же beacon.conf
	// и применяет на лету то, что можно (см. settings.go).
	api.Settings = newSettingsStore(cfg, os.Args[1:], logLevel, uploadQuota)
	api.DemoMode = cfg.DemoMode
	// Уборщик гостей — только в демо-режиме 
	var guests *app.GuestKeeper
	if cfg.DemoMode {
		guests = app.NewGuestKeeper(companies, accountRepo)
		api.Guests = guests
	}

	mux.Handle("GET /broadcast.html", api.BroadcastEntry(static))

	mux.Handle(uploadsURL, api.RequireViewer(
		http.StripPrefix(uploadsURL, http.FileServer(apihttp.NoDirListing{FS: http.Dir(cfg.UploadsDir)})),
	))

	systemAssets, err := fs.Sub(systemFiles, "systemdata/assets")
	if err != nil {
		fatal("не удалось открыть встроенный каталог", "err", err)
	}
	mux.Handle(systemAssetsURL, http.StripPrefix(systemAssetsURL, http.FileServer(http.FS(systemAssets))))

	api.RegisterRoutes(mux)
	gateway := apiws.RegisterRoutes(mux, companies, authSvc, broadcastSvc, apiws.Options{
		BehindProxy:    cfg.BehindProxy,
		AllowedOrigins: cfg.AllowedOrigins,
		Guests:         guests,
	})

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)

	bgCtx, stopBackground := context.WithCancel(context.Background())

	if cfg.DemoMode {
		if cfg.DemoWorld == "" {
			fatal("демо-режим включён, но не задан BEACON_DEMO_WORLD",
				"что делать", "выгрузите мир кнопкой ⬇ на экране миров и укажите путь к .zip в BEACON_DEMO_WORLD")
		}
		if _, err := os.Stat(cfg.DemoWorld); err != nil {
			// Самая частая ошибка настройки демо: файла нет или он лежит не
			// там, где его ищут (путь считается от рабочего каталога).
			// Говорим прямо, где искали и что туда положить.
			abs, _ := filepath.Abs(cfg.DemoWorld)
			fatal("не найден эталонный мир для демо",
				"BEACON_DEMO_WORLD", cfg.DemoWorld,
				"искали по пути", abs,
				"что делать", "выгрузите мир кнопкой ⬇ на экране миров и положите .zip по этому пути")
		}
		demo := newDemoResetter(companies, accountRepo, cfg.DemoWorld, cfg.DemoReset)
		// Сбрасываем сразу на старте: сервер мог упасть посреди чужой партии,
		// и витрина должна открыться в известном состоянии, а не в том, где
		// её оставил последний гость.
		if err := demo.Reset(ctx); err != nil {
			fatal("не удалось поднять демо-стол из эталона", "эталон", cfg.DemoWorld, "err", err)
		}
		go demo.Run(bgCtx)
		// Уборка ушедших гостей — отдельно от сброса стола и много чаще:
		// сброс возвращает мир к эталону раз в несколько часов, а место в
		// очереди должно освобождаться сразу за человеком (см. app.GuestKeeper).
		go guests.Run(bgCtx)
		slog.Info("демо-режим включён",
			"эталон", cfg.DemoWorld, "сброс каждые", cfg.DemoReset.String())
	}

	if cfg.BackupEnabled {
		go backup.Run(bgCtx, cfg.BackupInterval, backupOptions(cfg, db))
	} else {
		log.Println("резервное копирование выключено (BEACON_BACKUP_ENABLED=false)")
	}

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           apihttp.LogRequests(api.LimitAPIBodies(mux)),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			fatal("не удалось слушать адрес", "адрес", cfg.Addr, "err", err)
		}
	}()
	log.Println("Beacon Table сервер запущен на", cfg.Addr)
	printAccessURLs(cfg.Addr)

	<-sigCh
	stopBackground()
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
		slog.Warn("не все запросы успели завершиться", "err", err)
	}
	gateway.CloseAll()
	companies.Shutdown()
	if err := db.Close(); err != nil {
		slog.Error("ошибка закрытия базы", "err", err)
	}
	log.Println("сервер остановлен")
}
