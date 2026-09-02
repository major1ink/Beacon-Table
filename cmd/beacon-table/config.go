package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"beacon-table/internal/quota"
)

// Config — всё, что настраивается снаружи. Значения берутся из четырёх
// источников, каждый следующий перебивает предыдущий:
//
//	значения по умолчанию → файл конфига → переменные окружения → флаги
//
// Такой порядок покрывает три способа запуска, не заставляя ни один из них
// подстраиваться под другой:
//
//   - двойной клик по exe рядом с папкой игры: всё работает без единого
//     аргумента, а рядом с программой появляется beacon.conf с пояснениями —
//     захотел сменить порт, открыл блокнотом;
//   - Docker: переменные окружения, как принято в контейнерах (BEACON_ADDR
//     и прочие) — тот же beacon.conf годится как --env-file;
//   - служба на сервере: тот же файл подключается к systemd-юниту через
//     EnvironmentFile, а разовое переопределение делается флагом.
//
// Имена в файле, в окружении и в флагах намеренно совпадают по смыслу:
// BEACON_ADDR ↔ --addr. Один и тот же файл читают и приложение, и docker, и
// systemd — потому формат простой, KEY=value, а не JSON.
type Config struct {
	// Addr — где слушать, в формате host:port. Пустой host (":8080") — все
	// интерфейсы: так стол виден с телевизора и телефонов в той же сети.
	// За обратным прокси разумно сузить до "127.0.0.1:8080", чтобы снаружи
	// нельзя было постучаться в обход него.
	Addr string
	// DataDir — база, заметки, журнал, сцены. UploadsDir — карты, токены,
	// аудио. В Docker это две смонтированные папки, на сервере — что-то
	// вроде /var/lib/beacon-table/{data,uploads}.
	DataDir    string
	UploadsDir string
	// BehindProxy — сервер стоит за HTTPS-прокси (Caddy, nginx). Включает
	// защиту, которая на голом HTTP только помешала бы: cookie сессии и
	// зрителя уходят с флагом Secure и не долетают по незашифрованному
	// соединению. Держать включённым, ТОЛЬКО если снаружи действительно
	// https — иначе войти не получится вовсе.
	BehindProxy bool
	// AllowedOrigins — дополнительные адреса, с которых разрешено открывать
	// стол (проверка Origin на WebSocket, см. ws.Options). Обычно пуст:
	// сервер и так узнаёт собственный адрес из запроса. Понадобится, если
	// обратный прокси не передаёт исходный Host — тогда сервер видит вместо
	// имени сайта что-то своё и отвергает собственные же страницы.
	AllowedOrigins []string

	// ---- резервное копирование ----
	// Снимок базы (VACUUM INTO) плюс архив каталогов данных и загрузок, по
	// расписанию. По умолчанию включено: потерять кампанию куда дороже места
	// под архивы.
	BackupEnabled bool
	// BackupDir — куда складывать архивы. Пусто — <DataDir>/backups.
	BackupDir string
	// BackupInterval — как часто; BackupKeep — сколько последних архивов
	// хранить.
	BackupInterval time.Duration
	BackupKeep     int

	// ---- журнал ----
	// LogLevel — debug, info, warn или error. debug добавляет строку на
	// каждый HTTP-запрос; на info журнал пишется только о событиях.
	LogLevel string
	// LogFormat — "text" (по умолчанию, читается глазами) или "json" для
	// систем сбора логов.
	LogFormat string
	// LogFile — куда дублировать журнал. Пусто — <DataDir>/beacon.log,
	// "off" — не писать в файл вовсе (в контейнере и под systemd журнал
	// собирают снаружи, второй экземпляр в файле там лишний).
	//
	// Файл журнала есть всегда, а не только когда его попросили: при
	// запуске двойным кликом окна консоли нет — весь вывод уходит в никуда
	// (в Linux в journald сеанса, в Windows в закрывшееся окно), и человеку
	// негде взять ни временный пароль ДМ, ни причину, по которой сервер не
	// поднялся.
	LogFile string

	// ---- запуск за своим компьютером ----
	// OpenBrowser — открывать ли стол в браузере сразу после старта:
	// "auto" (по умолчанию), "true" или "false". auto — открывать, когда
	// это похоже на домашний запуск: есть графический сеанс, и это не демо
	// и не сервер за прокси.
	OpenBrowser string

	// ---- место под загрузками ----
	// UploadsQuota — предел на весь каталог загрузок, UploadsWorldQuota — на
	// один мир. 0 в любом из них снимает соответствующий предел; по
	// умолчанию оба сняты, чтобы обновление не начало отказывать в загрузке
	// там, где места и так вдоволь.
	UploadsQuota      int64
	UploadsWorldQuota int64

	// ---- публичное демо ----
	// DemoMode — сервер работает витриной: на странице входа появляется
	// выбор «я ведущий / я игрок». Гость-ведущий получает права ДМ ВНУТРИ
	// стола (см. domain.AccountRoleDemo), гость-игрок — обычные права
	// игрока вместе с выданными ему персонажем и токеном (см.
	// domain.AccountRoleDemoPlayer); сервером не распоряжается ни тот, ни
	// другой. Стол один на всех, как на demo.foundryvtt.com: посетители
	// видят друг друга.
	DemoMode bool
	// DemoWorld — .zip эталонного мира (см. экспорт мира). К нему стол
	// возвращается при сбросе; без него сбрасывать не из чего.
	DemoWorld string
	// DemoReset — как часто возвращать стол к эталону вместе с чисткой
	// гостевых аккаунтов.
	DemoReset time.Duration
}

func defaultConfig() Config {
	return Config{
		Addr:           ":8080",
		DataDir:        "data",
		UploadsDir:     "uploads",
		BehindProxy:    false,
		BackupEnabled:  true,
		BackupInterval: 24 * time.Hour,
		BackupKeep:     7,
		LogLevel:       "info",
		LogFormat:      "text",
		OpenBrowser:    "auto",
		DemoReset:      3 * time.Hour,
	}
}

// logOff — значения BEACON_LOG_FILE, выключающие файл журнала.
func logOff(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "off", "no", "none", "-", "false":
		return true
	}
	return false
}

// LogPath — файл журнала с учётом значения по умолчанию. Пусто — не писать.
func (c Config) LogPath() string {
	if logOff(c.LogFile) {
		return ""
	}
	if c.LogFile != "" {
		return c.LogFile
	}
	return filepath.Join(c.DataDir, "beacon.log")
}

// BackupPath — куда пишутся архивы с учётом значения по умолчанию.
func (c Config) BackupPath() string {
	if c.BackupDir != "" {
		return c.BackupDir
	}
	return filepath.Join(c.DataDir, "backups")
}

// DBPath — файл базы внутри каталога данных.
func (c Config) DBPath() string { return filepath.Join(c.DataDir, "beacon.db") }

// Имена настроек. Одна константа на настройку: в файле и в окружении это имя
// как есть, во флаге — его же нижний регистр без префикса (см. bindFlags).
const (
	envAddr           = "BEACON_ADDR"
	envDataDir        = "BEACON_DATA_DIR"
	envUploadsDir     = "BEACON_UPLOADS_DIR"
	envBehindProxy    = "BEACON_BEHIND_PROXY"
	envAllowedOrigins = "BEACON_ALLOWED_ORIGINS"

	envBackupEnabled  = "BEACON_BACKUP_ENABLED"
	envBackupDir      = "BEACON_BACKUP_DIR"
	envBackupInterval = "BEACON_BACKUP_INTERVAL"
	envBackupKeep     = "BEACON_BACKUP_KEEP"

	envLogLevel  = "BEACON_LOG_LEVEL"
	envLogFormat = "BEACON_LOG_FORMAT"
	envLogFile   = "BEACON_LOG_FILE"

	envOpenBrowser = "BEACON_OPEN_BROWSER"

	envUploadsQuota      = "BEACON_UPLOADS_QUOTA"
	envUploadsWorldQuota = "BEACON_UPLOADS_WORLD_QUOTA"

	envDemoMode  = "BEACON_DEMO_MODE"
	envDemoWorld = "BEACON_DEMO_WORLD"
	envDemoReset = "BEACON_DEMO_RESET"
	// envConfig — где лежит файл конфига, если не там, где его ищут по
	// умолчанию (см. findConfigFile).
	envConfig = "BEACON_CONFIG"
)

const configFileName = "beacon.conf"

// loadConfig собирает конфигурацию из всех источников. Возвращает ещё и путь
// к прочитанному файлу — чтобы сказать в логе, откуда взялись настройки
// (пусто, если файла не было).
func loadConfig(args []string) (Config, string, error) {
	cfg := defaultConfig()

	// --config должен быть разобран раньше остальных флагов: от него зависит,
	// какой файл вообще читать. Отдельный проход по args, а не flag-пакет:
	// полноценный набор флагов ещё не собран, их значения по умолчанию как
	// раз и придут из файла.
	configPath := configPathFromArgs(args)
	if configPath == "" {
		configPath = os.Getenv(envConfig)
	}
	explicit := configPath != ""
	if configPath == "" {
		configPath = findConfigFile()
	}

	used := ""
	if configPath != "" {
		values, err := readConfigFile(configPath)
		if err != nil {
			if os.IsNotExist(err) && !explicit {
				// Файла нет и никто его не обещал — это норма (Docker, где
				// всё в окружении). Заведём пример, чтобы человеку было что
				// открыть, но настаивать не будем.
				//
				// Удачно созданный файл сразу считаем действующим: он весь
				// закомментирован, поведения не меняет, зато форма настроек
				// у ДМ знает, куда писать, — иначе она заработала бы только
				// со второго запуска.
				if writeExampleConfig(configPath) == nil {
					used = configPath
				}
			} else {
				return cfg, "", fmt.Errorf("конфиг %s: %w", configPath, err)
			}
		} else {
			if err := applyValues(&cfg, values, configPath); err != nil {
				return cfg, "", err
			}
			used = configPath
		}
	}

	if err := applyValues(&cfg, envValues(), "переменные окружения"); err != nil {
		return cfg, used, err
	}

	if err := bindFlags(&cfg, args); err != nil {
		return cfg, used, err
	}
	return cfg, used, nil
}

// configPathFromArgs выуживает --config/-config из аргументов, не трогая
// остальные: обе формы записи, и "--config=путь", и "--config путь".
func configPathFromArgs(args []string) string {
	for i, a := range args {
		switch {
		case a == "--config" || a == "-config":
			if i+1 < len(args) {
				return args[i+1]
			}
		case strings.HasPrefix(a, "--config="):
			return strings.TrimPrefix(a, "--config=")
		case strings.HasPrefix(a, "-config="):
			return strings.TrimPrefix(a, "-config=")
		}
	}
	return ""
}

// findConfigFile — где искать beacon.conf, когда его не указали явно:
// сначала в рабочем каталоге, потом рядом с самой программой. Второе — ради
// Windows: ярлык на рабочем столе запускает exe с каким угодно рабочим
// каталогом, а человек ожидает, что настройки лежат в папке с программой.
func findConfigFile() string {
	if _, err := os.Stat(configFileName); err == nil {
		return configFileName
	}
	exe, err := os.Executable()
	if err != nil {
		return configFileName
	}
	beside := filepath.Join(filepath.Dir(exe), configFileName)
	if _, err := os.Stat(beside); err == nil {
		return beside
	}
	// Ни там, ни там: вернём путь в рабочем каталоге — по нему ляжет пример.
	return configFileName
}

// readConfigFile читает KEY=value с решёточными комментариями — тот самый
// формат, который понимают и docker --env-file, и systemd EnvironmentFile.
func readConfigFile(path string) (map[string]string, error) {
	f, err := os.Open(path) //nolint:gosec // G304: путь задаёт тот, кто запускает сервер
	if err != nil {
		return nil, err
	}
	defer f.Close()

	values := map[string]string{}
	scanner := bufio.NewScanner(f)
	line := 0
	for scanner.Scan() {
		line++
		text := strings.TrimSpace(scanner.Text())
		if text == "" || strings.HasPrefix(text, "#") {
			continue
		}
		key, value, found := strings.Cut(text, "=")
		if !found {
			return nil, fmt.Errorf("строка %d: ожидалось ИМЯ=значение, а не %q", line, text)
		}
		values[strings.TrimSpace(key)] = strings.TrimSpace(value)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return values, nil
}

func envValues() map[string]string {
	values := map[string]string{}
	for _, key := range []string{
		envAddr, envDataDir, envUploadsDir, envBehindProxy, envAllowedOrigins,
		envBackupEnabled, envBackupDir, envBackupInterval, envBackupKeep,
		envLogLevel, envLogFormat, envLogFile,
		envOpenBrowser,
		envUploadsQuota, envUploadsWorldQuota,
		envDemoMode, envDemoWorld, envDemoReset,
	} {
		if v, ok := os.LookupEnv(key); ok {
			values[key] = v
		}
	}
	return values
}

// unquote снимает кавычки вокруг значения — привычка из .env-файлов, где
// путь с пробелом («C:\Program Files\…») пишут в кавычках.
//
// Снимается и в файле, и в переменных окружения намеренно: тот же beacon.conf
// читает не только приложение, но и docker --env-file, а он кавычки НЕ
// снимает и передаёт их в переменную как есть. Не сними мы их здесь —
// каталог назывался бы «"/data"» вместе с кавычками, и разница между
// запуском в контейнере и без него вылезла бы в самом неудобном месте.
func unquote(v string) string {
	if len(v) >= 2 && (v[0] == '"' && v[len(v)-1] == '"' || v[0] == '\'' && v[len(v)-1] == '\'') {
		return v[1 : len(v)-1]
	}
	return v
}

// applyValues накладывает набор значений на конфиг. source — откуда они, для
// текста ошибки: «BEACON_BEHIND_PROXY в beacon.conf: ...».
func applyValues(cfg *Config, values map[string]string, source string) error {
	if v, ok := values[envAddr]; ok && v != "" {
		cfg.Addr = unquote(v)
	}
	if v, ok := values[envDataDir]; ok && v != "" {
		cfg.DataDir = unquote(v)
	}
	if v, ok := values[envUploadsDir]; ok && v != "" {
		cfg.UploadsDir = unquote(v)
	}
	if v, ok := values[envBehindProxy]; ok && v != "" {
		b, err := strconv.ParseBool(unquote(v))
		if err != nil {
			return fmt.Errorf("%s в %s: %q — ожидалось true или false", envBehindProxy, source, v)
		}
		cfg.BehindProxy = b
	}
	if v, ok := values[envAllowedOrigins]; ok && v != "" {
		cfg.AllowedOrigins = splitOrigins(unquote(v))
	}
	if v, ok := values[envBackupEnabled]; ok && v != "" {
		b, err := strconv.ParseBool(unquote(v))
		if err != nil {
			return fmt.Errorf("%s в %s: %q — ожидалось true или false", envBackupEnabled, source, v)
		}
		cfg.BackupEnabled = b
	}
	if v, ok := values[envBackupDir]; ok && v != "" {
		cfg.BackupDir = unquote(v)
	}
	if v, ok := values[envBackupInterval]; ok && v != "" {
		d, err := time.ParseDuration(unquote(v))
		if err != nil || d <= 0 {
			return fmt.Errorf("%s в %s: %q — ожидалась длительность вроде 24h или 30m", envBackupInterval, source, v)
		}
		cfg.BackupInterval = d
	}
	if v, ok := values[envBackupKeep]; ok && v != "" {
		n, err := strconv.Atoi(unquote(v))
		if err != nil || n < 1 {
			return fmt.Errorf("%s в %s: %q — ожидалось целое число не меньше 1", envBackupKeep, source, v)
		}
		cfg.BackupKeep = n
	}
	if v, ok := values[envLogLevel]; ok && v != "" {
		level := strings.ToLower(unquote(v))
		if !validLogLevel(level) {
			return fmt.Errorf("%s в %s: %q — ожидалось debug, info, warn или error", envLogLevel, source, v)
		}
		cfg.LogLevel = level
	}
	if v, ok := values[envLogFormat]; ok && v != "" {
		format := strings.ToLower(unquote(v))
		if format != "text" && format != "json" {
			return fmt.Errorf("%s в %s: %q — ожидалось text или json", envLogFormat, source, v)
		}
		cfg.LogFormat = format
	}
	if v, ok := values[envLogFile]; ok && v != "" {
		cfg.LogFile = unquote(v)
	}
	if v, ok := values[envOpenBrowser]; ok && v != "" {
		mode, err := parseOpenBrowser(unquote(v))
		if err != nil {
			return fmt.Errorf("%s в %s: %q — ожидалось auto, true или false", envOpenBrowser, source, v)
		}
		cfg.OpenBrowser = mode
	}
	for _, q := range []struct {
		key string
		dst *int64
	}{
		{envUploadsQuota, &cfg.UploadsQuota},
		{envUploadsWorldQuota, &cfg.UploadsWorldQuota},
	} {
		v, ok := values[q.key]
		if !ok || v == "" {
			continue
		}
		n, err := quota.ParseSize(unquote(v))
		if err != nil {
			return fmt.Errorf("%s в %s: %q — ожидался размер вроде 20GB или 500MB", q.key, source, v)
		}
		*q.dst = n
	}
	if v, ok := values[envDemoMode]; ok && v != "" {
		b, err := strconv.ParseBool(unquote(v))
		if err != nil {
			return fmt.Errorf("%s в %s: %q — ожидалось true или false", envDemoMode, source, v)
		}
		cfg.DemoMode = b
	}
	if v, ok := values[envDemoWorld]; ok && v != "" {
		cfg.DemoWorld = unquote(v)
	}
	if v, ok := values[envDemoReset]; ok && v != "" {
		d, err := time.ParseDuration(unquote(v))
		if err != nil || d <= 0 {
			return fmt.Errorf("%s в %s: %q — ожидалась длительность вроде 3h", envDemoReset, source, v)
		}
		cfg.DemoReset = d
	}
	return nil
}

// parseOpenBrowser приводит значение к auto/true/false. Кроме них принимает
// всё, что понимает strconv.ParseBool (1/0/yes нет, но on/off людям в голову
// приходит реже, чем true/false) — иначе настройка-переключатель отличалась
// бы от соседних булевых по строгости без всякой причины.
func parseOpenBrowser(v string) (string, error) {
	v = strings.ToLower(strings.TrimSpace(v))
	if v == "auto" {
		return "auto", nil
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return "", err
	}
	return strconv.FormatBool(b), nil
}

func validLogLevel(v string) bool {
	switch v {
	case "debug", "info", "warn", "error":
		return true
	}
	return false
}

// splitOrigins разбирает список через запятую, пропуская пустые куски: с
// «a.example.com, b.example.com,» человек не должен получить пустой адрес в
// списке разрешённых.
func splitOrigins(v string) []string {
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// bindFlags разбирает аргументы командной строки. Значения по умолчанию у
// флагов — уже собранные из файла и окружения, поэтому флаг перебивает их
// просто тем, что его указали, а --help заодно показывает, что действует
// сейчас.
func bindFlags(cfg *Config, args []string) error {
	fs := flag.NewFlagSet("beacon-table", flag.ContinueOnError)
	fs.StringVar(&cfg.Addr, "addr", cfg.Addr, "адрес и порт, где слушать (host:port)")
	fs.StringVar(&cfg.DataDir, "data", cfg.DataDir, "каталог данных: база, журнал, сцены")
	fs.StringVar(&cfg.UploadsDir, "uploads", cfg.UploadsDir, "каталог загрузок: карты, токены, аудио")
	fs.BoolVar(&cfg.BehindProxy, "behind-proxy", cfg.BehindProxy, "сервер стоит за HTTPS-прокси (включает Secure у cookie)")
	fs.BoolVar(&cfg.BackupEnabled, "backup", cfg.BackupEnabled, "делать резервные копии по расписанию")
	fs.StringVar(&cfg.BackupDir, "backup-dir", cfg.BackupDir, "куда складывать архивы бэкапов (по умолчанию <data>/backups)")
	fs.DurationVar(&cfg.BackupInterval, "backup-interval", cfg.BackupInterval, "как часто делать бэкап")
	fs.IntVar(&cfg.BackupKeep, "backup-keep", cfg.BackupKeep, "сколько последних архивов хранить")
	fs.StringVar(&cfg.LogLevel, "log-level", cfg.LogLevel, "подробность журнала: debug, info, warn, error")
	fs.StringVar(&cfg.LogFormat, "log-format", cfg.LogFormat, "формат журнала: text или json")
	fs.StringVar(&cfg.LogFile, "log-file", cfg.LogFile, "файл журнала (по умолчанию <data>/beacon.log, off — не писать)")
	openBrowser := fs.String("open-browser", cfg.OpenBrowser, "открыть стол в браузере после запуска: auto, true, false")
	fs.BoolVar(&cfg.DemoMode, "demo", cfg.DemoMode, "режим публичного демо: гостевой вход с правами ДМ внутри стола")
	fs.StringVar(&cfg.DemoWorld, "demo-world", cfg.DemoWorld, "путь к .zip эталонного мира для демо")
	fs.DurationVar(&cfg.DemoReset, "demo-reset", cfg.DemoReset, "как часто возвращать демо-стол к эталону")
	uploadsQuota := fs.String("uploads-quota", quota.FormatFlag(cfg.UploadsQuota), "предел на весь каталог загрузок, например 20GB (0 — без предела)")
	worldQuota := fs.String("uploads-world-quota", quota.FormatFlag(cfg.UploadsWorldQuota), "предел на загрузки одного мира, например 5GB (0 — без предела)")
	origins := fs.String("allowed-origins", strings.Join(cfg.AllowedOrigins, ","), "дополнительные адреса, с которых разрешено открывать стол, через запятую")
	fs.String("config", "", "путь к файлу настроек (по умолчанию "+configFileName+" рядом с программой)")
	showVersion := fs.Bool("version", false, "напечатать версию и выйти")
	if err := fs.Parse(args); err != nil {
		return err
	}

	if *showVersion {
		printVersion()
		return errShowVersion
	}
	// Запоминаем, что задано флагом: флаг перебивает файл, и форма настроек
	// не должна делать вид, что запись в файл на это повлияет.
	flagToEnv := map[string]string{
		"addr": envAddr, "data": envDataDir, "uploads": envUploadsDir,
		"behind-proxy": envBehindProxy, "allowed-origins": envAllowedOrigins,
		"backup": envBackupEnabled, "backup-dir": envBackupDir,
		"backup-interval": envBackupInterval, "backup-keep": envBackupKeep,
		"log-level": envLogLevel, "log-format": envLogFormat, "log-file": envLogFile,
		"open-browser":  envOpenBrowser,
		"uploads-quota": envUploadsQuota, "uploads-world-quota": envUploadsWorldQuota,
	}
	fs.Visit(func(f *flag.Flag) {
		if key, ok := flagToEnv[f.Name]; ok {
			flagsSet[key] = true
		}
	})
	cfg.AllowedOrigins = splitOrigins(*origins)

	// Флаги проверяем здесь: значения из файла и окружения уже проверил
	// applyValues, но флаг приходит мимо него.
	cfg.LogLevel = strings.ToLower(cfg.LogLevel)
	if !validLogLevel(cfg.LogLevel) {
		return fmt.Errorf("--log-level %q: ожидалось debug, info, warn или error", cfg.LogLevel)
	}
	cfg.LogFormat = strings.ToLower(cfg.LogFormat)
	if cfg.LogFormat != "text" && cfg.LogFormat != "json" {
		return fmt.Errorf("--log-format %q: ожидалось text или json", cfg.LogFormat)
	}
	mode, err := parseOpenBrowser(*openBrowser)
	if err != nil {
		return fmt.Errorf("--open-browser %q: ожидалось auto, true или false", *openBrowser)
	}
	cfg.OpenBrowser = mode
	if cfg.UploadsQuota, err = quota.ParseSize(*uploadsQuota); err != nil {
		return fmt.Errorf("--uploads-quota %q: ожидался размер вроде 20GB", *uploadsQuota)
	}
	if cfg.UploadsWorldQuota, err = quota.ParseSize(*worldQuota); err != nil {
		return fmt.Errorf("--uploads-world-quota %q: ожидался размер вроде 5GB", *worldQuota)
	}
	return nil
}
