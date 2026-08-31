package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestRenderConfigFileCoversAllSettings — файл-пример должен упоминать
// каждую настройку, которую понимает программа: он и есть её документация
// для того, кто не читал README.
func TestRenderConfigFileCoversAllSettings(t *testing.T) {
	body := renderConfigFile()
	for _, key := range allSettingKeys() {
		if !strings.Contains(body, key) {
			t.Errorf("в файле-примере нет настройки %s", key)
		}
	}
	// И всё закомментировано: свежесозданный файл ничего не меняет.
	for _, line := range strings.Split(body, "\n") {
		if line != "" && !strings.HasPrefix(line, "#") {
			t.Errorf("строка не закомментирована: %q", line)
		}
	}
}

// TestSyncConfigFileAddsNewSettings — главный случай: человек обновил
// бинарник, а файл у него остался от старой версии. Недостающие настройки
// должны дописаться, а всё, что он написал сам, — уцелеть.
func TestSyncConfigFileAddsNewSettings(t *testing.T) {
	path := filepath.Join(t.TempDir(), configFileName)
	old := `# мой конфиг
BEACON_ADDR=127.0.0.1:9000

# каталог я поменял намеренно
BEACON_DATA_DIR=/srv/beacon/data
#BEACON_LOG_LEVEL=debug
`
	if err := os.WriteFile(path, []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}

	added, err := syncConfigFile(path)
	if err != nil {
		t.Fatalf("syncConfigFile: %v", err)
	}
	if len(added) == 0 {
		t.Fatal("ничего не дописано, хотя в файле нет большинства настроек")
	}

	body := readFile(t, path)

	// Правки человека на месте — и значения, и его комментарий.
	for _, keep := range []string{"BEACON_ADDR=127.0.0.1:9000", "BEACON_DATA_DIR=/srv/beacon/data", "# мой конфиг", "# каталог я поменял намеренно"} {
		if !strings.Contains(body, keep) {
			t.Errorf("потеряно из старого файла: %q", keep)
		}
	}
	// Уже упомянутые (пусть и закомментированные) не задваиваются.
	for _, key := range []string{"BEACON_ADDR", "BEACON_DATA_DIR", "BEACON_LOG_LEVEL"} {
		if n := strings.Count(body, key+"="); n != 1 {
			t.Errorf("%s встречается %d раз, ожидался один", key, n)
		}
	}
	// Недостающие появились, закомментированными.
	for _, key := range []string{"BEACON_UPLOADS_QUOTA", "BEACON_BACKUP_ENABLED", "BEACON_LOG_FORMAT"} {
		if !strings.Contains(body, "#"+key+"=") {
			t.Errorf("не дописана настройка %s", key)
		}
	}
}

// TestSyncConfigFileIsIdempotent — повторный запуск ничего не меняет: иначе
// файл рос бы на каждый старт сервера.
func TestSyncConfigFileIsIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), configFileName)
	if err := os.WriteFile(path, []byte("BEACON_ADDR=:9999\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := syncConfigFile(path); err != nil {
		t.Fatalf("первый проход: %v", err)
	}
	after := readFile(t, path)

	added, err := syncConfigFile(path)
	if err != nil {
		t.Fatalf("второй проход: %v", err)
	}
	if len(added) != 0 {
		t.Fatalf("второй проход дописал %v", added)
	}
	if readFile(t, path) != after {
		t.Fatal("второй проход изменил файл")
	}
}

// TestSyncConfigFileLeavesCompleteFileAlone — в свежесозданном файле есть
// всё, дописывать нечего.
func TestSyncConfigFileLeavesCompleteFileAlone(t *testing.T) {
	path := filepath.Join(t.TempDir(), configFileName)
	if err := writeExampleConfig(path); err != nil {
		t.Fatalf("writeExampleConfig: %v", err)
	}
	before := readFile(t, path)

	added, err := syncConfigFile(path)
	if err != nil {
		t.Fatalf("syncConfigFile: %v", err)
	}
	if len(added) != 0 {
		t.Fatalf("в полном файле дописаны %v", added)
	}
	if readFile(t, path) != before {
		t.Fatal("полный файл изменён")
	}
}

// TestSyncedFileStillLoads — дописанный файл должен читаться конфигом и не
// менять поведения: всё добавленное закомментировано.
func TestSyncedFileStillLoads(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, configFileName)
	if err := os.WriteFile(path, []byte("BEACON_ADDR=127.0.0.1:9000\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := syncConfigFile(path); err != nil {
		t.Fatalf("syncConfigFile: %v", err)
	}

	cfg, used, err := loadConfig([]string{"--config", path})
	if err != nil {
		t.Fatalf("loadConfig после дозаписи: %v", err)
	}
	if used != path {
		t.Fatalf("прочитан файл %q", used)
	}
	if cfg.Addr != "127.0.0.1:9000" {
		t.Fatalf("addr = %q — значение человека потерялось", cfg.Addr)
	}
	if cfg.DataDir != "data" || cfg.BackupKeep != 7 {
		t.Fatalf("дописанные строки повлияли на настройки: %+v", cfg)
	}
}

// TestMentionedKeys — упоминанием считается и закомментированная строка, и
// строка с пробелами: иначе появились бы дубли.
func TestMentionedKeys(t *testing.T) {
	got := mentionedKeys("BEACON_ADDR=:8080\n#BEACON_LOG_LEVEL=debug\n   #  BEACON_LOG_FORMAT = json\nмусор\n")
	for _, key := range []string{"BEACON_ADDR", "BEACON_LOG_LEVEL", "BEACON_LOG_FORMAT"} {
		if !got[key] {
			t.Errorf("%s не распознан как упомянутый", key)
		}
	}
	if got["мусор"] {
		t.Error("строка без «=» принята за настройку")
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// allSettingKeys — все имена настроек, которые понимает программа.
func allSettingKeys() []string {
	return []string{
		envAddr, envDataDir, envUploadsDir, envBehindProxy, envAllowedOrigins,
		envBackupEnabled, envBackupDir, envBackupInterval, envBackupKeep,
		envLogLevel, envLogFormat, envUploadsQuota, envUploadsWorldQuota,
	}
}
