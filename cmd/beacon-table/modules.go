package main

import (
	"io/fs"
	"net/http"
	"path"
	"strings"

	"beacon-table/internal/module"
)

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
