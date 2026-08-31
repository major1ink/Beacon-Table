package main

import (
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"beacon-table/internal/quota"
)

// settingsFixture — сервер с файлом настроек, как после первого запуска.
// Глобальные settingsFile/flagsSet восстанавливаются после теста.
func settingsFixture(t *testing.T, body string) (*settingsStore, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), configFileName)
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	prevFile, prevFlags := settingsFile, flagsSet
	settingsFile, flagsSet = path, map[string]bool{}
	t.Cleanup(func() { settingsFile, flagsSet = prevFile, prevFlags })

	args := []string{"--config", path}
	cfg, _, err := loadConfig(args)
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	return newSettingsStore(cfg, args, new(slog.LevelVar), quota.New(t.TempDir(), 0, 0)), path
}

// TestSettingsListMarksReadOnly — пути и порт видно, но менять их из веба
// нельзя: это уровень машины, а ДМ — администратор игры.
func TestSettingsListMarksReadOnly(t *testing.T) {
	store, _ := settingsFixture(t, "BEACON_ADDR=127.0.0.1:9000\n")

	byKey := map[string]bool{}
	section := map[string]string{}
	for _, s := range store.List() {
		byKey[s.Key] = s.Editable
		section[s.Key] = s.Section
	}
	for _, key := range []string{envAddr, envDataDir, envUploadsDir, envBackupDir} {
		if byKey[key] {
			t.Errorf("%s доступна для правки из веба", key)
		}
		// Объяснение даёт заголовок группы, а не пометка под каждым полем:
		// иначе одно и то же предупреждение повторяется четыре раза подряд.
		if section[key] != "Пути и порт" {
			t.Errorf("%s не в группе «Пути и порт», а в %q", key, section[key])
		}
	}
	for _, key := range []string{envLogLevel, envBackupKeep, envUploadsQuota} {
		if !byKey[key] {
			t.Errorf("%s должна быть доступна для правки", key)
		}
	}
}

// TestSettingsSaveWritesFileKeepingComments — сохранение меняет значение на
// месте, не трогая ни комментарии, ни чужие строки.
func TestSettingsSaveWritesFileKeepingComments(t *testing.T) {
	store, path := settingsFixture(t, `# мой конфиг
BEACON_ADDR=127.0.0.1:9000

# журнал
#BEACON_LOG_LEVEL=info
`)

	if _, err := store.Save(map[string]string{envLogLevel: "debug"}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	body := readFile(t, path)
	if !strings.Contains(body, "BEACON_LOG_LEVEL=debug") {
		t.Fatalf("значение не записано:\n%s", body)
	}
	if strings.Contains(body, "#BEACON_LOG_LEVEL=") {
		t.Fatalf("настройка осталась закомментированной:\n%s", body)
	}
	for _, keep := range []string{"# мой конфиг", "# журнал", "BEACON_ADDR=127.0.0.1:9000"} {
		if !strings.Contains(body, keep) {
			t.Errorf("потеряно: %q", keep)
		}
	}
	// Значение действительно перечитано, а не только записано.
	for _, s := range store.List() {
		if s.Key == envLogLevel && s.Value != "debug" {
			t.Fatalf("после сохранения значение %q", s.Value)
		}
	}
}

// TestSettingsSaveRejectsReadOnly — закрытую настройку не записать, даже
// если её прислали в обход формы.
func TestSettingsSaveRejectsReadOnly(t *testing.T) {
	store, path := settingsFixture(t, "BEACON_ADDR=127.0.0.1:9000\n")
	before := readFile(t, path)

	if _, err := store.Save(map[string]string{envDataDir: "/etc"}); err == nil {
		t.Fatal("каталог данных изменён из веба")
	}
	if readFile(t, path) != before {
		t.Fatal("файл изменён, хотя настройку менять нельзя")
	}
}

// TestSettingsSaveRejectsBadValue — значение, с которым сервер не поднимется,
// в файл попасть не должно.
func TestSettingsSaveRejectsBadValue(t *testing.T) {
	store, path := settingsFixture(t, "BEACON_ADDR=127.0.0.1:9000\n")
	before := readFile(t, path)

	for key, bad := range map[string]string{
		envLogLevel:       "болтливо",
		envBackupKeep:     "-3",
		envBackupInterval: "вечность",
		envUploadsQuota:   "много",
		envBehindProxy:    "ага",
	} {
		if _, err := store.Save(map[string]string{key: bad}); err == nil {
			t.Errorf("%s=%q принято", key, bad)
		}
	}
	if readFile(t, path) != before {
		t.Fatal("файл изменён неверным значением")
	}
}

// TestSettingsSaveRefusesWhenOverriddenByEnv — если настройка задана
// окружением, запись в файл ничего не изменит; честнее отказать, чем
// отрапортовать об успехе.
func TestSettingsSaveRefusesWhenOverriddenByEnv(t *testing.T) {
	t.Setenv(envLogLevel, "warn")
	store, _ := settingsFixture(t, "BEACON_ADDR=127.0.0.1:9000\n")

	var found bool
	for _, s := range store.List() {
		if s.Key == envLogLevel {
			found = true
			if s.Editable {
				t.Error("настройка, заданная окружением, показана как редактируемая")
			}
			if s.Source != "env" {
				t.Errorf("источник %q, ожидался env", s.Source)
			}
		}
	}
	if !found {
		t.Fatal("настройка не найдена в списке")
	}
	if _, err := store.Save(map[string]string{envLogLevel: "debug"}); err == nil {
		t.Fatal("сохранение прошло, хотя окружение перебивает файл")
	}
}

// TestSettingsSaveReportsRestartNeeded — что применилось сразу, а что нет,
// форма должна говорить честно.
func TestSettingsSaveReportsRestartNeeded(t *testing.T) {
	store, _ := settingsFixture(t, "BEACON_ADDR=127.0.0.1:9000\n")

	needRestart, err := store.Save(map[string]string{
		envLogLevel:     "debug", // применяется сразу
		envLogFormat:    "json",  // нужен перезапуск
		envBackupKeep:   "3",     // нужен перезапуск
		envUploadsQuota: "1GB",   // применяется сразу
	})
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	got := strings.Join(needRestart, ",")
	if !strings.Contains(got, envLogFormat) || !strings.Contains(got, envBackupKeep) {
		t.Errorf("не сообщено о необходимости перезапуска: %v", needRestart)
	}
	if strings.Contains(got, envLogLevel) || strings.Contains(got, envUploadsQuota) {
		t.Errorf("настройки, применяемые сразу, требуют перезапуска: %v", needRestart)
	}
}

// TestSettingsSaveAppliesLogLevelNow — уровень журнала меняется без
// перезапуска: ради строчки в отладке сервер ронять не нужно.
func TestSettingsSaveAppliesLogLevelNow(t *testing.T) {
	store, _ := settingsFixture(t, "BEACON_ADDR=127.0.0.1:9000\n")
	level := new(slog.LevelVar)
	level.Set(slog.LevelInfo)
	store.logLevel = level

	if _, err := store.Save(map[string]string{envLogLevel: "debug"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if level.Level() != slog.LevelDebug {
		t.Fatalf("уровень журнала %v, ожидался debug", level.Level())
	}
}

// TestSettingsSaveAppliesQuotaNow — новая квота действует сразу.
func TestSettingsSaveAppliesQuotaNow(t *testing.T) {
	store, _ := settingsFixture(t, "BEACON_ADDR=127.0.0.1:9000\n")
	tr := quota.New(t.TempDir(), 0, 0)
	store.quota = tr

	if _, err := store.Save(map[string]string{envUploadsQuota: "2GB"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if got := tr.TotalLimit(); got != 2<<30 {
		t.Fatalf("предел %d, ожидалось 2 ГБ", got)
	}
}
