package main

import (
	"fmt"
	"log"
	"log/slog"
	"os"
	"path/filepath"

	apihttp "beacon-table/internal/api/http"
	"beacon-table/internal/service"
)

// Временный пароль ДМ там, где его найдут без консоли.
//
// Пароль выдаётся при первом запуске и печатается в журнал (см.
// service.AuthService.SeedAdmin). Пока сервер запускали из терминала, этого
// хватало; при запуске двойным кликом окна консоли нет вовсе, и пароль
// уходил в никуда — войти за свой собственный стол становилось нельзя.
//
// Поэтому пароль кладётся ещё в два места:
//
//   - файл dm-password.txt рядом с beacon.conf — его видно в той же папке,
//     что и программу, и он переживает перезапуск;
//   - подсказка на странице входа, открытой НА ЭТОМ ЖЕ компьютере (см.
//     internal/api/http: handleFirstRun) — тогда после автоматически
//     открытого браузера не нужно вообще ничего искать.
//
// И то и другое живёт ровно до первой смены пароля.

const firstRunFileName = "dm-password.txt"

// firstRunFilePath — рядом с файлом настроек: там же лежит и сама программа
// (см. findConfigFile), а значит человек смотрит именно в эту папку.
func firstRunFilePath(cfg Config, configFile string) string {
	if configFile != "" {
		if dir := filepath.Dir(configFile); dir != "" {
			return filepath.Join(dir, firstRunFileName)
		}
	}
	return filepath.Join(cfg.DataDir, firstRunFileName)
}

// setupFirstRun сохраняет временный пароль в файл и отдаёт его API — для
// подсказки на странице входа с этого же компьютера.
func setupFirstRun(api *apihttp.API, cfg Config, configFile, password string) {
	path := firstRunFilePath(cfg, configFile)
	if err := writeFirstRunFile(path, cfg, password); err != nil {
		// Не фатально: пароль есть и в журнале, и в подсказке на странице
		// входа. Каталог может быть только для чтения — не повод не играть.
		slog.Warn("не удалось записать файл с паролем ДМ", "файл", path, "err", err)
	} else {
		log.Println("логин и пароль ДМ записаны в файл:", path)
	}

	api.SetFirstRun(&apihttp.FirstRun{
		Username: service.SeedAdminUsername,
		Password: password,
		Done: func() {
			// Пароль сменили — файл с временным больше не нужен и только
			// сбивал бы с толку («а какой из них настоящий?»).
			if err := os.Remove(path); err == nil {
				slog.Info("временный пароль ДМ сменён, файл удалён", "файл", path)
			}
		},
	})
}

// removeFirstRunFile убирает файл, оставшийся с прошлых запусков: пароль в
// нём уже не работает (ДМ сменил его на свой), а лежащий рядом с программой
// файл с надписью «Пароль:» — плохая привычка.
func removeFirstRunFile(cfg Config, configFile string) {
	path := firstRunFilePath(cfg, configFile)
	if err := os.Remove(path); err == nil {
		slog.Info("убран файл с временным паролем ДМ — пароль уже сменён", "файл", path)
	}
}

func writeFirstRunFile(path string, cfg Config, password string) error {
	body := fmt.Sprintf(`Beacon Table — вход ведущего (ДМ)

Адрес стола: %s
Логин:  %s
Пароль: %s

Пароль временный и выдан при первом запуске. Смените его при входе —
после этого файл исчезнет сам.

Игроки заходят по тому же адресу со своих устройств и регистрируются
сами; вы подтверждаете их в разделе «Настройки».
`, browserURL(cfg.Addr), service.SeedAdminUsername, password)

	//nolint:gosec // G306: 0600 — как и у beacon.conf; в файле пароль.
	return os.WriteFile(path, []byte(body), 0o600)
}
