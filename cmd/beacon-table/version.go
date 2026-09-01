package main

import (
	"errors"
	"fmt"
	"runtime/debug"
)

var version string

var errShowVersion = errors.New("--version")

func printVersion() {
	fmt.Println("beacon-table", serverVersion())
}

// serverVersion возвращает версию сервера: тег релиза, если бинарник собран
// GoReleaser'ом, иначе — короткий hash текущего git-коммита.
func serverVersion() string {
	if version != "" {
		return version
	}
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
