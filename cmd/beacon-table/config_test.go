package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// withWorkDir уводит тест в свой каталог: loadConfig ищет beacon.conf в
// рабочем каталоге, и без этого тесты цепляли бы файл из репозитория.
func withWorkDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	old, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd: %v", err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("Chdir: %v", err)
	}
	t.Cleanup(func() { _ = os.Chdir(old) })
	return dir
}

// TestLoadConfigDefaults — запуск без единого аргумента (двойной клик по
// exe) должен работать: те же пути и порт, что были зашиты в коде до
// появления настроек.
func TestLoadConfigDefaults(t *testing.T) {
	withWorkDir(t)

	cfg, file, err := loadConfig(nil)
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if file != "" {
		t.Fatalf("прочитан файл %q, хотя его не было", file)
	}
	if cfg.Addr != ":8080" || cfg.DataDir != "data" || cfg.UploadsDir != "uploads" || cfg.BehindProxy {
		t.Fatalf("значения по умолчанию разъехались: %+v", cfg)
	}
	if cfg.DBPath() != filepath.Join("data", "beacon.db") {
		t.Fatalf("путь к базе %q", cfg.DBPath())
	}
}

// TestLoadConfigWritesExample — при первом запуске рядом с программой
// появляется файл с пояснениями: человеку, который не знает про флаги, надо
// что-то открыть блокнотом.
func TestLoadConfigWritesExample(t *testing.T) {
	dir := withWorkDir(t)

	if _, _, err := loadConfig(nil); err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	body, err := os.ReadFile(filepath.Join(dir, configFileName))
	if err != nil {
		t.Fatalf("пример конфига не создан: %v", err)
	}
	text := string(body)
	for _, key := range []string{envAddr, envDataDir, envUploadsDir, envBehindProxy} {
		if !strings.Contains(text, key) {
			t.Fatalf("в примере нет настройки %s", key)
		}
	}
	// Всё закомментировано: файл не должен ничего менять, пока его не тронули.
	cfg, _, err := loadConfig(nil)
	if err != nil {
		t.Fatalf("повторный loadConfig: %v", err)
	}
	if cfg.Addr != ":8080" {
		t.Fatalf("свежесозданный пример поменял настройки: addr = %q", cfg.Addr)
	}
}

// TestLoadConfigFromFile — файл читается, комментарии и кавычки не мешают.
func TestLoadConfigFromFile(t *testing.T) {
	dir := withWorkDir(t)

	body := `# комментарий
BEACON_ADDR=127.0.0.1:9000

# путь в кавычках — так пишут пути с пробелами
BEACON_DATA_DIR="/var/lib/beacon/data"
BEACON_BEHIND_PROXY=true
`
	if err := os.WriteFile(filepath.Join(dir, configFileName), []byte(body), 0o600); err != nil {
		t.Fatalf("запись конфига: %v", err)
	}

	cfg, file, err := loadConfig(nil)
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if file == "" {
		t.Fatal("loadConfig не сказал, что прочитал файл")
	}
	if cfg.Addr != "127.0.0.1:9000" {
		t.Fatalf("addr = %q", cfg.Addr)
	}
	if cfg.DataDir != "/var/lib/beacon/data" {
		t.Fatalf("data = %q — кавычки должны сниматься", cfg.DataDir)
	}
	if !cfg.BehindProxy {
		t.Fatal("behind-proxy из файла не применился")
	}
	if cfg.UploadsDir != "uploads" {
		t.Fatalf("uploads = %q — в файле его не было, ожидалось значение по умолчанию", cfg.UploadsDir)
	}
}

// TestLoadConfigPrecedence — порядок источников: флаг перебивает окружение,
// окружение перебивает файл. Ровно то, чего ждут от запуска в контейнере
// (окружение) с разовым переопределением аргументом.
func TestLoadConfigPrecedence(t *testing.T) {
	dir := withWorkDir(t)

	body := "BEACON_ADDR=:1111\nBEACON_DATA_DIR=из-файла\nBEACON_UPLOADS_DIR=из-файла\n"
	if err := os.WriteFile(filepath.Join(dir, configFileName), []byte(body), 0o600); err != nil {
		t.Fatalf("запись конфига: %v", err)
	}
	t.Setenv(envAddr, ":2222")
	t.Setenv(envDataDir, "из-окружения")

	cfg, _, err := loadConfig([]string{"--addr", ":3333"})
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if cfg.Addr != ":3333" {
		t.Fatalf("addr = %q — флаг должен перебивать всё", cfg.Addr)
	}
	if cfg.DataDir != "из-окружения" {
		t.Fatalf("data = %q — окружение должно перебивать файл", cfg.DataDir)
	}
	if cfg.UploadsDir != "из-файла" {
		t.Fatalf("uploads = %q — значение из файла потерялось", cfg.UploadsDir)
	}
}

// TestLoadConfigStripsQuotesFromEnv — docker --env-file передаёт значения
// вместе с кавычками, если они были в файле: он их не снимает. Приложение
// должно понять такое значение так же, как если бы читало файл само, иначе
// один и тот же beacon.conf вёл бы себя по-разному в контейнере и без него.
func TestLoadConfigStripsQuotesFromEnv(t *testing.T) {
	withWorkDir(t)
	t.Setenv(envDataDir, `"/data"`)
	t.Setenv(envBehindProxy, `"true"`)

	cfg, _, err := loadConfig(nil)
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if cfg.DataDir != "/data" {
		t.Fatalf("data = %q — кавычки из переменной окружения не сняты", cfg.DataDir)
	}
	if !cfg.BehindProxy {
		t.Fatal("behind-proxy в кавычках не распознан")
	}
}

// TestLoadConfigExplicitPath — путь к конфигу можно задать и флагом, и
// переменной окружения: первое для запуска руками, второе для контейнера.
func TestLoadConfigExplicitPath(t *testing.T) {
	withWorkDir(t)
	other := filepath.Join(t.TempDir(), "server.conf")
	if err := os.WriteFile(other, []byte("BEACON_ADDR=:7777\n"), 0o600); err != nil {
		t.Fatalf("запись конфига: %v", err)
	}

	cfg, file, err := loadConfig([]string{"--config", other})
	if err != nil {
		t.Fatalf("loadConfig с флагом: %v", err)
	}
	if cfg.Addr != ":7777" || file != other {
		t.Fatalf("флаг --config не сработал: addr = %q, файл = %q", cfg.Addr, file)
	}

	t.Setenv(envConfig, other)
	cfg, _, err = loadConfig(nil)
	if err != nil {
		t.Fatalf("loadConfig с переменной: %v", err)
	}
	if cfg.Addr != ":7777" {
		t.Fatalf("%s не сработала: addr = %q", envConfig, cfg.Addr)
	}
}

// TestLoadConfigMissingExplicitFile — если файл назвали явно, а его нет, это
// ошибка запуска, а не повод молча взять значения по умолчанию: иначе сервер
// на VPS поднялся бы с чужими путями и пустой базой.
func TestLoadConfigMissingExplicitFile(t *testing.T) {
	withWorkDir(t)

	_, _, err := loadConfig([]string{"--config", filepath.Join(t.TempDir(), "нет-такого.conf")})
	if err == nil {
		t.Fatal("пропавший файл конфига не вызвал ошибки")
	}
}

// TestLoadConfigRejectsBrokenValues — понятная ошибка вместо тихого
// игнорирования: опечатку в конфиге на сервере иначе искать нечем.
func TestLoadConfigRejectsBrokenValues(t *testing.T) {
	dir := withWorkDir(t)

	if err := os.WriteFile(filepath.Join(dir, configFileName), []byte("BEACON_BEHIND_PROXY=ага\n"), 0o600); err != nil {
		t.Fatalf("запись конфига: %v", err)
	}
	_, _, err := loadConfig(nil)
	if err == nil {
		t.Fatal("нечитаемое значение принято")
	}
	if !strings.Contains(err.Error(), envBehindProxy) {
		t.Fatalf("ошибка не называет настройку: %v", err)
	}

	if err := os.WriteFile(filepath.Join(dir, configFileName), []byte("совсем не то\n"), 0o600); err != nil {
		t.Fatalf("запись конфига: %v", err)
	}
	if _, _, err := loadConfig(nil); err == nil {
		t.Fatal("строка без «=» принята")
	}
}
