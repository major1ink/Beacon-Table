package main

import (
	"fmt"
	"log/slog"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	apihttp "beacon-table/internal/api/http"
	"beacon-table/internal/quota"
)

// settingsFile — путь к beacon.conf, который сейчас в ходу (пусто, если
// файла нет). Запоминается при старте: форма настроек пишет именно в него.
var settingsFile string

// flagsSet — какие настройки заданы флагами запуска. Флаг перебивает файл,
// поэтому форма показывает такое поле как «задано при запуске» и не делает
// вид, что сохранение подействует.
var flagsSet = map[string]bool{}

// settingsSnapshot собирает то, что видит ДМ: значение каждой настройки, её
// источник и можно ли её менять отсюда.
func settingsSnapshot(cfg Config) []apihttp.Setting {
	fileValues := map[string]string{}
	if settingsFile != "" {
		if v, err := readConfigFile(settingsFile); err == nil {
			fileValues = v
		}
	}

	out := make([]apihttp.Setting, 0, len(configEntries))
	for _, e := range configEntries {
		s := apihttp.Setting{
			Key:        e.key,
			Section:    e.section,
			Title:      e.title,
			Hint:       e.hint,
			Kind:       e.kind,
			Options:    e.options,
			Value:      currentValue(cfg, e.key),
			Source:     settingSource(e.key, fileValues),
			AppliesNow: e.appliesNow,
		}
		// Менять из веба можно только то, что не закрыто по существу и не
		// перекрыто снаружи: запись в файл всё равно не пересилит окружение
		// или флаг, и «сохранено» было бы обманом.
		s.Editable = !e.readOnly && s.Source != apihttp.SourceEnv && s.Source != apihttp.SourceFlag
		if e.readOnly {
			// Отдельной пометки у каждого поля не даём: вся группа «Пути и
			// порт» и так подписана в форме — иначе одно и то же
			// предупреждение повторялось бы под каждой строкой.
			s.Locked = ""
		} else if s.Source == apihttp.SourceEnv {
			s.Locked = "задано переменной окружения — файл настроек её не пересилит"
		} else if s.Source == apihttp.SourceFlag {
			s.Locked = "задано флагом при запуске — файл настроек его не пересилит"
		}
		out = append(out, s)
	}
	return out
}

// settingSource — откуда взялось действующее значение. Порядок тот же, что
// и при загрузке: флаг → окружение → файл → умолчание.
func settingSource(key string, fileValues map[string]string) string {
	if flagsSet[key] {
		return apihttp.SourceFlag
	}
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return apihttp.SourceEnv
	}
	if v, ok := fileValues[key]; ok && v != "" {
		return apihttp.SourceFile
	}
	return apihttp.SourceDefault
}

// currentValue — действующее значение настройки в том же виде, в каком его
// пишут в файл.
func currentValue(cfg Config, key string) string {
	switch key {
	case envAddr:
		return cfg.Addr
	case envDataDir:
		return cfg.DataDir
	case envUploadsDir:
		return cfg.UploadsDir
	case envBehindProxy:
		return strconv.FormatBool(cfg.BehindProxy)
	case envAllowedOrigins:
		return strings.Join(cfg.AllowedOrigins, ",")
	case envBackupEnabled:
		return strconv.FormatBool(cfg.BackupEnabled)
	case envBackupDir:
		return cfg.BackupPath()
	case envBackupInterval:
		// 24h0m0s → 24h: в файле пишут коротко, и обратно оно читается так же.
		return strings.TrimSuffix(strings.TrimSuffix(cfg.BackupInterval.String(), "0s"), "0m")
	case envBackupKeep:
		return strconv.Itoa(cfg.BackupKeep)
	case envLogLevel:
		return cfg.LogLevel
	case envLogFormat:
		return cfg.LogFormat
	case envUploadsQuota:
		return quota.FormatCompact(cfg.UploadsQuota)
	case envUploadsWorldQuota:
		return quota.FormatCompact(cfg.UploadsWorldQuota)
	default:
		return ""
	}
}

// validateSetting проверяет значение так же, как это делает загрузка
// конфигурации: форма не должна уметь записать в файл то, с чем сервер потом
// не поднимется.
func validateSetting(key, value string) error {
	value = strings.TrimSpace(value)
	switch key {
	case envBehindProxy, envBackupEnabled:
		if _, err := strconv.ParseBool(value); err != nil {
			return fmt.Errorf("ожидалось true или false")
		}
	case envBackupInterval:
		d, err := time.ParseDuration(value)
		if err != nil || d <= 0 {
			return fmt.Errorf("ожидалась длительность вроде 24h или 30m")
		}
	case envBackupKeep:
		n, err := strconv.Atoi(value)
		if err != nil || n < 1 {
			return fmt.Errorf("ожидалось целое число не меньше 1")
		}
	case envLogLevel:
		if !validLogLevel(strings.ToLower(value)) {
			return fmt.Errorf("ожидалось debug, info, warn или error")
		}
	case envLogFormat:
		if v := strings.ToLower(value); v != "text" && v != "json" {
			return fmt.Errorf("ожидалось text или json")
		}
	case envUploadsQuota, envUploadsWorldQuota:
		if _, err := quota.ParseSize(value); err != nil {
			return fmt.Errorf("ожидался размер вроде 20GB или 500MB")
		}
	}
	return nil
}

// editableSetting — можно ли записывать эту настройку из веба. Проверяется
// на сервере отдельно от того, что показала форма: клиент мог прислать что
// угодно.
func editableSetting(key string) bool {
	for _, e := range configEntries {
		if e.key == key {
			return !e.readOnly
		}
	}
	return false
}

// settingsStore — реализация apihttp.SettingsStore. Держит текущий конфиг
// (он же — источник значений для формы) и то, что умеет применяться на лету.
type settingsStore struct {
	cfg Config
	// args — аргументы, с которыми запустили сервер. Хранятся явно, а не
	// берутся из os.Args: перечитывание файла после сохранения должно
	// повторять ровно тот же разбор, что и при старте.
	args     []string
	logLevel *slog.LevelVar
	quota    *quota.Tracker
}

func newSettingsStore(cfg Config, args []string, logLevel *slog.LevelVar, q *quota.Tracker) *settingsStore {
	return &settingsStore{cfg: cfg, args: args, logLevel: logLevel, quota: q}
}

// List implements apihttp.SettingsStore.
func (s *settingsStore) List() []apihttp.Setting { return settingsSnapshot(s.cfg) }

// Save implements apihttp.SettingsStore: проверяет значения, пишет их в
// beacon.conf и применяет те, что не требуют перезапуска.
func (s *settingsStore) Save(values map[string]string) ([]string, error) {
	if settingsFile == "" {
		return nil, fmt.Errorf("файл настроек не используется — менять нечего")
	}

	clean := make(map[string]string, len(values))
	for key, value := range values {
		if !editableSetting(key) {
			return nil, fmt.Errorf("настройку %s нельзя менять отсюда", key)
		}
		// Флаг и окружение перебивают файл: записать-то можно, но эффекта не
		// будет, а форма отрапортует об успехе. Отказываем честно.
		if flagsSet[key] {
			return nil, fmt.Errorf("%s задана флагом при запуске — файл её не пересилит", key)
		}
		if v, ok := os.LookupEnv(key); ok && v != "" {
			return nil, fmt.Errorf("%s задана переменной окружения — файл её не пересилит", key)
		}
		value = strings.TrimSpace(value)
		if err := validateSetting(key, value); err != nil {
			return nil, fmt.Errorf("%s: %w", key, err)
		}
		clean[key] = value
	}
	if len(clean) == 0 {
		return nil, nil
	}

	if err := updateConfigFile(settingsFile, clean); err != nil {
		return nil, fmt.Errorf("не удалось сохранить файл настроек: %w", err)
	}

	// Перечитываем файл целиком, а не правим Config по кусочкам: так
	// действующие значения ровно те же, что увидит сервер после перезапуска.
	updated, _, err := loadConfig(s.args)
	if err != nil {
		return nil, fmt.Errorf("файл сохранён, но перечитать его не удалось: %w", err)
	}
	s.cfg = updated

	return s.apply(updated, clean), nil
}

// apply применяет то, что можно применить без перезапуска, и возвращает
// имена настроек, которым перезапуск всё-таки нужен.
func (s *settingsStore) apply(cfg Config, changed map[string]string) []string {
	var needRestart []string
	for key := range changed {
		switch key {
		case envLogLevel:
			if s.logLevel != nil {
				s.logLevel.Set(parseLevel(cfg.LogLevel))
			}
		case envUploadsQuota, envUploadsWorldQuota:
			s.quota.SetLimits(cfg.UploadsQuota, cfg.UploadsWorldQuota)
		default:
			needRestart = append(needRestart, key)
		}
	}
	sort.Strings(needRestart)
	return needRestart
}

// updateConfigFile переписывает значения в beacon.conf, сохраняя всё
// остальное: комментарии, порядок строк, чужие настройки. Настройка,
// лежавшая закомментированной, включается на месте — там же, где её описание.
func updateConfigFile(path string, values map[string]string) error {
	//nolint:gosec // G304: путь конфига задаёт тот, кто запускает сервер.
	body, err := os.ReadFile(path)
	if err != nil {
		return err
	}

	left := make(map[string]string, len(values))
	for k, v := range values {
		left[k] = v
	}

	lines := strings.Split(string(body), "\n")
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		bare := strings.TrimSpace(strings.TrimLeft(trimmed, "#"))
		key, _, found := strings.Cut(bare, "=")
		if !found {
			continue
		}
		key = strings.TrimSpace(key)
		value, ok := left[key]
		if !ok {
			continue
		}
		lines[i] = key + "=" + value
		delete(left, key)
	}

	// Не нашлось в файле — дописываем в конец.
	if len(left) > 0 {
		out := strings.Join(lines, "\n")
		if !strings.HasSuffix(out, "\n") {
			out += "\n"
		}
		var b strings.Builder
		b.WriteString(out)
		b.WriteString("\n# --- Изменено из раздела «Настройки» ---\n")
		// Порядок — как в configEntries, а не как пришло из формы: файл
		// должен читаться так же, как написанный руками.
		for _, e := range configEntries {
			if v, ok := left[e.key]; ok {
				fmt.Fprintf(&b, "%s=%s\n", e.key, v)
			}
		}
		//nolint:gosec // G306: как и при создании файла — 0600.
		return os.WriteFile(path, []byte(b.String()), 0o600)
	}

	//nolint:gosec // G306: как и при создании файла — 0600.
	return os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0o600)
}
