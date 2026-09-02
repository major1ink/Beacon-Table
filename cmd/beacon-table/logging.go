package main

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
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
//
// Возвращает ещё и путь к файлу журнала (пусто, если файла нет)
// — его печатают при старте: человеку, запустившему программу двойным
// кликом, это единственный способ узнать, куда смотреть.
func setupLogging(cfg Config) (*slog.LevelVar, string) {
	level := new(slog.LevelVar)
	level.Set(parseLevel(cfg.LogLevel))
	opts := &slog.HandlerOptions{Level: level}

	// Пишем и в stderr, и в файл. stderr — для тех, кто запускает из
	// терминала, из Docker или под systemd, и ждёт вывод там, где привык;
	// файл — для запуска двойным кликом, где stderr уходит в никуда.
	var out io.Writer = os.Stderr
	path := cfg.LogPath()
	if path != "" {
		f, err := openLogFile(path)
		if err != nil {
			// Не фатально: журнал в файле — удобство, а не условие работы.
			// Каталог может быть только для чтения (образ, сетевой диск) —
			// это не повод не пускать людей за стол.
			fmt.Fprintf(os.Stderr, "не удалось открыть файл журнала %s: %v\n", path, err)
			path = ""
		} else {
			out = io.MultiWriter(os.Stderr, f)
		}
	}

	var h slog.Handler
	if cfg.LogFormat == "json" {
		h = slog.NewJSONHandler(out, opts)
	} else {
		h = slog.NewTextHandler(out, opts)
	}
	slog.SetDefault(slog.New(h))
	// Возвращаем ручку уровня: его меняют из формы настроек без перезапуска
	// (см. settingsStore.apply).
	return level, path
}

// logFileMaxBytes — при каком размере журнал начинается заново. Пять
// мегабайт: на debug-уровне столько набегает за пару вечеров игры, а
// открыть такой файл блокнотом ещё можно.
const logFileMaxBytes = 5 << 20

// logFile — файл журнала, который сам начинается заново, когда вырастет.
//
// Ротация встроена, а не отдана logrotate: программу запускают двойным
// кликом на домашнем компьютере, где никакого logrotate нет, а журнал,
// растущий без предела, однажды займёт диск целиком. Хранится ровно один
// прошлый файл (.1) — не архив за месяц, а «что было перед тем, как
// сломалось».
type logFile struct {
	mu   sync.Mutex
	path string
	f    *os.File
	size int64
}

func openLogFile(path string) (*logFile, error) {
	if dir := filepath.Dir(path); dir != "" {
		//nolint:gosec // G703: путь журнала задаёт тот, кто запускает
		// сервер (BEACON_LOG_FILE или каталог данных), а не пользователь по
		// сети — ограничивать его песочницей нечем и незачем.
		if err := os.MkdirAll(dir, 0o750); err != nil {
			return nil, err
		}
	}
	l := &logFile{path: path}
	if err := l.open(); err != nil {
		return nil, err
	}
	return l, nil
}

func (l *logFile) open() error {
	//nolint:gosec // G304: путь задаёт тот, кто запускает сервер, а не пользователь по сети.
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	size := int64(0)
	if st, err := f.Stat(); err == nil {
		size = st.Size()
	}
	l.f, l.size = f, size
	return nil
}

// Write implements io.Writer. Ошибку записи наверх не несём (slog всё равно
// её игнорирует) — при неудачной ротации продолжаем писать в тот же файл.
func (l *logFile) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.size+int64(len(p)) > logFileMaxBytes {
		l.rotate()
	}
	n, err := l.f.Write(p)
	l.size += int64(n)
	return n, err
}

func (l *logFile) rotate() {
	_ = l.f.Close()
	// Прошлый .1 затирается: два файла — весь архив, больше на домашнем
	// компьютере никому не нужно.
	if err := os.Rename(l.path, l.path+".1"); err != nil {
		// Переименовать не вышло (открыт чем-то ещё, нет прав) — начинаем
		// файл заново, иначе он рос бы дальше в обход предела.
		_ = os.Remove(l.path)
	}
	if err := l.open(); err != nil {
		// Совсем некуда писать — уходим в stderr, чтобы не потерять журнал
		// целиком и не уронить сервер из-за файла.
		fmt.Fprintf(os.Stderr, "не удалось продолжить файл журнала %s: %v\n", l.path, err)
		l.f, l.size = os.Stderr, 0
	}
}

// fatal — сообщить о неустранимой ошибке старта и выйти.
//
// Не log.Fatal: стандартный log идёт через slog-мост записями уровня info,
// и при BEACON_LOG_LEVEL=warn сообщение о том, почему сервер не поднялся,
// молча исчезало — оставался только код возврата 1. Ошибка, из-за которой
// процесс завершается, должна быть видна при любом уровне журнала.
func fatal(msg string, args ...any) {
	slog.Error(msg, args...)
	os.Exit(1)
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
