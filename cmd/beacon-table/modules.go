package main

import (
	"io/fs"
	"net/http"
	"path"
	"strings"

	"beacon-table/internal/module"
)

// builtinModules — каталог D&D, пока ещё зашитый в бинарник (systemdata),
// в виде обычных системных модулей. Карточки сохраняют id sys-<имя файла>
// (legacyIds), поэтому миры 0.8.x видят ровно те же карточки. Временная
// мера: в задаче «Вынос D&D из бинарника» эти модули уезжают в отдельный
// репозиторий и ставятся с витрины, а отсюда исчезают.
func builtinModules(systemFS fs.FS) []*module.Module {
	systems := []struct{ id, title string }{
		{"dnd5e-2014", "D&D 5e (2014)"},
		{"dnd5e-2024", "D&D 5e (2024)"},
	}
	out := make([]*module.Module, 0, len(systems))
	for _, s := range systems {
		out = append(out, module.Builtin(systemFS, "systemdata", s.id, &module.Manifest{
			Format:      module.Format,
			ID:          s.id,
			Type:        module.TypeSystem,
			Title:       s.title,
			Version:     "1.0.0",
			Systems:     []string{s.id},
			Description: "Встроенный каталог SRD: существа, заклинания, предметы, справочник и состояния.",
			License:     "CC-BY-4.0 (SRD 5.2)",
			LegacyIDs:   true,
		}))
	}
	return out
}

// moduleAssetsURL — картинки модулей: /module-assets/<id модуля>/<путь в
// папке assets модуля>. Карточка модуля ссылается на свою картинку этим
// адресом (imageUrl), поэтому он не настройка.
const moduleAssetsURL = "/module-assets/"

// moduleAssetsHandler раздаёт папку assets модуля по его id. Модуль ищется
// на каждый запрос: установка и удаление модуля видны сразу, без
// перезапуска сервера.
func moduleAssetsHandler(registry *module.Registry) http.Handler {
	return http.StripPrefix(moduleAssetsURL, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, rest, ok := strings.Cut(r.URL.Path, "/")
		if !ok || rest == "" || strings.HasSuffix(rest, "/") {
			http.NotFound(w, r)
			return
		}
		mod, err := registry.Get(id)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		assets, err := fs.Sub(mod.FS, mod.AssetsDir())
		if err != nil {
			http.NotFound(w, r)
			return
		}
		r2 := r.Clone(r.Context())
		r2.URL.Path = "/" + path.Clean(rest)
		http.FileServer(http.FS(assets)).ServeHTTP(w, r2)
	}))
}
