//go:build desktop

// Десктопная сборка: стол открывается в своём окне, а не во вкладке
// браузера. Серверная сборка этот файл не видит и остаётся без CGO.

package main

import (
	"log/slog"
	"os"
	"runtime"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func init() { runDesktop = desktopWindow }

func desktopWindow(url string, done <-chan struct{}) {
	// WebKitGTK на NVIDIA заметно лагает с рендером через DMA-BUF.
	if runtime.GOOS == "linux" && os.Getenv("WEBKIT_DISABLE_DMABUF_RENDERER") == "" {
		_ = os.Setenv("WEBKIT_DISABLE_DMABUF_RENDERER", "1")
	}
	app := application.New(application.Options{
		Name:   "Beacon Table",
		Logger: slog.Default(),
		Mac:    application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed: true},
	})
	// Настоящий адрес сервера, а не asset-сервер Wails: куки, WS и проверки
	// «открыто с этой машины» работают как в браузере.
	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:      "Beacon Table",
		URL:        url,
		Width:      1440,
		Height:     900,
		StartState: application.WindowStateMaximised,
	})
	go func() {
		<-done
		app.Quit()
	}()
	if err := app.Run(); err != nil {
		slog.Error("Окно закрылось с ошибкой", "err", err)
	}
}
