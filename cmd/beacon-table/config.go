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
	}
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
				_ = writeExampleConfig(configPath)
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
	return nil
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
	origins := fs.String("allowed-origins", strings.Join(cfg.AllowedOrigins, ","), "дополнительные адреса, с которых разрешено открывать стол, через запятую")
	fs.String("config", "", "путь к файлу настроек (по умолчанию "+configFileName+" рядом с программой)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg.AllowedOrigins = splitOrigins(*origins)
	return nil
}

// exampleConfig — то, что кладётся рядом с программой при первом запуске.
// Всё закомментировано: файл ничего не меняет, пока его не тронули, и
// служит подсказкой, что вообще можно настроить.
const exampleConfig = `# Настройки Beacon Table.
#
# Формат — ИМЯ=значение. Уберите # в начале строки, чтобы настройка
# заработала, и перезапустите программу.
#
# Этот же файл понимают docker (--env-file beacon.conf) и systemd
# (EnvironmentFile=/etc/beacon-table/beacon.conf).

# Адрес и порт, на которых открыт стол.
# ":8080" — все сетевые интерфейсы: стол виден с телевизора и телефонов
# в той же сети. За обратным прокси лучше "127.0.0.1:8080", чтобы снаружи
# нельзя было подключиться в обход него.
#BEACON_ADDR=:8080

# Каталог данных: база аккаунтов, журнал, сцены, заметки.
#BEACON_DATA_DIR=data

# Каталог загрузок: карты, токены, аудио.
#BEACON_UPLOADS_DIR=uploads

# Сервер стоит за HTTPS-прокси (Caddy, nginx).
# Включает Secure у cookie — они перестают ходить по незашифрованному
# соединению. Включайте, ТОЛЬКО если снаружи действительно https, иначе
# войти не получится вовсе.
#BEACON_BEHIND_PROXY=false

# Дополнительные адреса, с которых разрешено открывать стол, через запятую.
# Обычно не нужно: сервер узнаёт свой адрес из самого запроса и принимает
# подключения только со страниц, открытых по нему же. Понадобится, если
# обратный прокси не передаёт исходный Host — тогда стол не откроется, а в
# журнале будет «отклонён WS-хендшейк».
#BEACON_ALLOWED_ORIGINS=стол.example.com,192.168.1.10:8080

# Резервное копирование: снимок базы (VACUUM INTO) плюс архив каталогов
# данных и загрузок. Делается при старте и дальше по интервалу; каждый архив
# проверяется на восстановимость. Хранятся последние BEACON_BACKUP_KEEP штук.
#BEACON_BACKUP_ENABLED=true
#BEACON_BACKUP_DIR=data/backups
#BEACON_BACKUP_INTERVAL=24h
#BEACON_BACKUP_KEEP=7
`

// writeExampleConfig создаёт файл-подсказку, если его ещё нет. Ошибку
// вызывающий игнорирует намеренно: в контейнере с файловой системой только
// для чтения писать некуда, и это не повод не запускаться.
func writeExampleConfig(path string) error {
	//nolint:gosec // G703: путь конфига приходит из аргументов запуска или
	// из окружения — его задаёт тот, кто и так запускает этот процесс, а не
	// пользователь по сети. Ограничивать его каталогом бессмысленно: файл
	// настроек как раз и кладут туда, куда удобно администратору.
	if _, err := os.Stat(path); err == nil {
		return nil
	}
	//nolint:gosec // G703: см. выше.
	return os.WriteFile(path, []byte(exampleConfig), 0o600)
}
