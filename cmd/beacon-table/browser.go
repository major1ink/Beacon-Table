package main

import (
	"log/slog"
	"net"
	"os"
	"os/exec"
	"runtime"
)

// Открытие браузера на старте.
//
// Зачем: программу чаще всего запускают двойным кликом по файлу, и тогда
// окна консоли нет ни в Windows, ни в Linux — снаружи выглядит так, будто
// «ничего не произошло». Адрес стола при этом напечатан в журнал, который
// человек ещё должен догадаться найти. Открытая вкладка со столом — самый
// короткий ответ на вопрос «а запустилось ли».

// shouldOpenBrowser — открывать ли браузер при этом запуске.
//
// "auto" (по умолчанию) значит «похоже ли это на домашний компьютер»:
// признаки обратного — демо-режим, работа за прокси, контейнер, вход по ssh
// или отсутствие графического сеанса. На сервере открывать нечего и некому,
// а лишний запуск xdg-open в логах только пугает.
func shouldOpenBrowser(cfg Config) bool {
	switch cfg.OpenBrowser {
	case "true":
		return true
	case "false":
		return false
	}
	if cfg.DemoMode || cfg.BehindProxy {
		return false
	}
	if inContainer() {
		return false
	}
	if os.Getenv("SSH_CONNECTION") != "" || os.Getenv("SSH_TTY") != "" {
		return false
	}
	if runtime.GOOS == "linux" && os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
		return false
	}
	return true
}

// inContainer — грубая, но достаточная проверка: оба файла кладут в корень
// сами Docker и Podman.
func inContainer() bool {
	for _, marker := range []string{"/.dockerenv", "/run/.containerenv"} {
		if _, err := os.Stat(marker); err == nil {
			return true
		}
	}
	return false
}

// browserURL — что открывать. Слушаем обычно все интерфейсы (":8080"), но
// открывать localhost правильнее внешнего адреса: он работает даже когда
// сеть отвалилась, и не зависит от того, какой из адресов машины сейчас
// «тот самый».
func browserURL(addr string) string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return "http://localhost" + addr + "/"
	}
	if host == "" || host == "0.0.0.0" || host == "::" || host == "[::]" {
		host = "localhost"
	}
	return "http://" + net.JoinHostPort(host, port) + "/"
}

// openBrowser просит систему открыть адрес в браузере по умолчанию.
// Неудача — не беда: адрес напечатан в журнале, стол работает.
func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		// Через rundll32, а не `cmd /c start`: не нужно возиться с
		// экранированием и не мелькает лишнее окно консоли.
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url) //nolint:gosec // G204: адрес собран здесь же из настроек
	case "darwin":
		cmd = exec.Command("open", url) //nolint:gosec // G204: см. выше
	default:
		cmd = exec.Command("xdg-open", url) //nolint:gosec // G204: см. выше
	}
	if err := cmd.Start(); err != nil {
		slog.Debug("не удалось открыть браузер", "url", url, "err", err)
		return
	}
	// Дожидаемся в фоне: без этого дочерний процесс останется зомби на всё
	// время работы сервера.
	go func() { _ = cmd.Wait() }()
}
