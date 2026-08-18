package main

import "runtime/debug"

// serverVersion возвращает версию сервера, вычисленную из VCS-метаданных
// git-репозитория. Начиная с Go 1.18 инструментарий сам зашивает
// commit/время/dirty-флаг в бинарник при сборке (`go build`/`go run`) внутри
// git-репозитория — см. `go help buildvcs` — поэтому отдельный шаг сборки
// (ldflags, CI-скрипт, ручной ввод версии) не нужен: версия берётся прямо из
// репозитория на GitHub, с которым синхронизирован локальный клон.
//
// Формат: короткий hash коммита (7 символов, как у `git rev-parse --short`),
// с суффиксом "-dirty", если в момент сборки в рабочей копии были
// незакоммиченные изменения. Если собрать с `-buildvcs=false` или вне
// git-репозитория (например, "go build" из архива исходников без .git) —
// возвращает "dev": VCS-настроек в этом случае не будет вовсе.
func serverVersion() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "dev"
	}
	var revision string
	var modified bool
	for _, s := range info.Settings {
		switch s.Key {
		case "vcs.revision":
			revision = s.Value
		case "vcs.modified":
			modified = s.Value == "true"
		}
	}
	if revision == "" {
		return "dev"
	}
	if len(revision) > 7 {
		revision = revision[:7]
	}
	if modified {
		revision += "-dirty"
	}
	return revision
}
