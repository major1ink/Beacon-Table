// Package base — встроенный модуль «Базовые состояния»: часть ядра, а не
// игровой системы. Мир без модулей (система «Своя система») получает его по
// умолчанию, чтобы на токены было что повесить с первой минуты; как и
// любой модуль, его можно выключить в мире, а карточки — клонировать.
package base

import (
	"embed"
	"io/fs"

	"beacon-table/internal/domain"
	"beacon-table/internal/module"
)

// ID — id модуля базовых состояний.
const ID = domain.BaseModuleID

//go:embed content
var content embed.FS

// Module — модуль базовых состояний из бинарника.
func Module() *module.Module {
	root, err := fs.Sub(content, "content")
	if err != nil {
		panic(err) // встроенные файлы — ошибка возможна только при сборке
	}
	data, err := fs.ReadFile(root, "module.json")
	if err != nil {
		panic(err)
	}
	man, err := module.ParseManifest(data)
	if err != nil {
		panic(err)
	}
	return &module.Module{Manifest: man, Source: module.SourceBuiltin, FS: root}
}
