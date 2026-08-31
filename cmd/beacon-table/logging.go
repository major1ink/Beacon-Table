package main

import (
	"log/slog"
	"os"
)

// setupLogging настраивает единый журнал приложения.
//
// slog.SetDefault заодно перенаправляет сюда и стандартный пакет log —
// поэтому log.Println/log.Printf, которых по коду много, печатаются тем же
// хендлером и подчиняются выбранному уровню (как записи уровня info).
// Явный slog.Warn/slog.Error ставится там, где уровень действительно
// что-то значит: ошибка бэкапа, отказ по Origin, неудачный вход.
//
// Уровень держится в slog.LevelVar, а не зашит в хендлер: его правят из
// раздела «Настройки» у ДМ, и перезапускать ради этого сервер незачем.
func setupLogging(cfg Config) *slog.LevelVar {
	level := new(slog.LevelVar)
	level.Set(parseLevel(cfg.LogLevel))
	opts := &slog.HandlerOptions{Level: level}

	var h slog.Handler
	if cfg.LogFormat == "json" {
		h = slog.NewJSONHandler(os.Stderr, opts)
	} else {
		h = slog.NewTextHandler(os.Stderr, opts)
	}
	slog.SetDefault(slog.New(h))
	// Возвращаем ручку уровня: его меняют из формы настроек без перезапуска
	// (см. settingsStore.apply).
	return level
}

func parseLevel(name string) slog.Level {
	switch name {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
