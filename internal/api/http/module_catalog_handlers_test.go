package http_test

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	apihttp "beacon-table/internal/api/http"
	"beacon-table/internal/domain"
	"beacon-table/internal/modcatalog"
	"beacon-table/internal/modtool"
	"beacon-table/internal/module"
)

// catalogServer — каталог на httptest из двух модулей: main требует dep.
func catalogServer(t *testing.T) (indexURL string, urls map[string]string) {
	t.Helper()
	archives := map[string][]byte{}
	var entries []modtool.IndexEntry
	var srv *httptest.Server
	add := func(id, typ, extra string, patch func(*modtool.IndexEntry)) {
		var buf bytes.Buffer
		zw := zip.NewWriter(&buf)
		w, _ := zw.Create("module.json")
		_, _ = fmt.Fprintf(w, `{"format":"beacon-module/v1","id":%q,"type":%q,"title":"Модуль %s","version":"1.0.0"%s}`, id, typ, id, extra)
		w, _ = zw.Create("bestiary/wolf.json")
		_, _ = w.Write([]byte(`{"name":"Волк","ac":13,"hp":11}`))
		_ = zw.Close()
		sum := sha256.Sum256(buf.Bytes())
		archives["/"+id+".btmod"] = buf.Bytes()
		e := modtool.IndexEntry{ID: id, Title: "Модуль " + id, Type: typ, Version: "1.0.0", Size: int64(buf.Len()), SHA256: hex.EncodeToString(sum[:])}
		if extra != "" {
			e.Requires = []module.Dependency{{ID: "dep"}}
		}
		if patch != nil {
			patch(&e)
		}
		entries = append(entries, e)
	}
	add("dep", "content", "", nil)
	add("main", "content", `,"requires":[{"id":"dep"}]`, nil)
	add("rules", "system", "", nil)
	add("old-pack", "content", `,"systems":["rules"],"legacyIds":true,"requires":[{"id":"rules"}]`, func(e *modtool.IndexEntry) {
		e.Systems, e.LegacyIDs = []string{"rules"}, true
	})
	mux := http.NewServeMux()
	mux.HandleFunc("/index.json", func(w http.ResponseWriter, _ *http.Request) {
		out := make([]modtool.IndexEntry, len(entries))
		for i, e := range entries {
			e.URL = srv.URL + "/" + e.ID + ".btmod"
			e.SummaryURL = srv.URL + "/" + e.ID + ".summary.json"
			out[i] = e
		}
		_ = json.NewEncoder(w).Encode(modtool.Index{Format: modtool.IndexFormat, Modules: out})
	})
	mux.HandleFunc("/main.summary.json", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"id":"main","version":"1.0.0","title":"Модуль main","type":"content","counts":{"bestiary":1},"names":{"bestiary":["Волк"]},"slugs":{"bestiary":["wolf"]}}`))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if data, ok := archives[r.URL.Path]; ok {
			_, _ = w.Write(data)
			return
		}
		http.NotFound(w, r)
	})
	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv.URL + "/index.json", map[string]string{"main": srv.URL + "/main.btmod", "dep": srv.URL + "/dep.btmod"}
}

func jsonBody(v any) *bytes.Buffer {
	data, _ := json.Marshal(v)
	return bytes.NewBuffer(data)
}

func TestModuleCatalogAPI(t *testing.T) {
	indexURL, urls := catalogServer(t)
	cat := modcatalog.New(modcatalog.Options{IndexURL: indexURL, Dir: t.TempDir(), AppVersion: "0.9.0", AllowPrivate: true})
	e := newModuleEnv(t, func(a *apihttp.API) { a.Catalog = cat })
	do := func(method, path string, body any, cookie *http.Cookie) (int, map[string]any) {
		var buf *bytes.Buffer
		if body != nil {
			buf = jsonBody(body)
		}
		return e.do(t, method, path, buf, "application/json", cookie)
	}

	if code, _ := do(http.MethodGet, "/api/module-catalog", nil, e.player); code != http.StatusForbidden {
		t.Fatalf("игрок получил каталог: %d", code)
	}
	code, out := do(http.MethodGet, "/api/module-catalog", nil, e.cookie)
	entries, _ := out["entries"].([]any)
	if code != http.StatusOK || len(entries) != 4 || entries[0].(map[string]any)["installed"] != nil {
		t.Fatalf("каталог: %d %v", code, out)
	}

	if code, out = do(http.MethodGet, "/api/module-catalog/main/summary", nil, e.cookie); code != http.StatusOK || out["counts"].(map[string]any)["bestiary"] != float64(1) {
		t.Fatalf("сводка: %d %v", code, out)
	}
	if code, _ = do(http.MethodGet, "/api/module-catalog/нет/summary", nil, e.cookie); code != http.StatusNotFound {
		t.Fatalf("сводка несуществующего: %d", code)
	}

	// Зависимость без подтверждения не ставится.
	code, out = do(http.MethodPost, "/api/module-catalog/install", map[string]any{"id": "main"}, e.cookie)
	need, _ := out["requires"].([]any)
	if code != http.StatusConflict || len(need) != 1 || need[0].(map[string]any)["id"] != "dep" {
		t.Fatalf("установка без подтверждения: %d %v", code, out)
	}
	if _, out = do(http.MethodGet, "/api/modules", nil, e.cookie); len(out["modules"].([]any)) != 0 {
		t.Fatalf("после отказа что-то поставилось: %v", out["modules"])
	}
	code, out = do(http.MethodPost, "/api/module-catalog/install", map[string]any{"id": "main", "withRequires": true}, e.cookie)
	if got, _ := out["installed"].([]any); code != http.StatusCreated || len(got) != 2 || got[0].(map[string]any)["id"] != "dep" {
		t.Fatalf("установка с зависимостями: %d %v", code, out)
	}
	_, out = do(http.MethodGet, "/api/module-catalog", nil, e.cookie)
	for _, x := range out["entries"].([]any) {
		m := x.(map[string]any)
		if m["id"] != "main" && m["id"] != "dep" {
			continue
		}
		if m["installed"] != "1.0.0" || m["updatable"] != false || m["compatible"] != true {
			t.Fatalf("отметки после установки: %v", m)
		}
	}

	// По ссылке: с неверной суммой — отказ, с верной и без суммы — установка.
	if code, _ = do(http.MethodPost, "/api/module-catalog/install-url", map[string]any{"url": urls["dep"], "sha256": strings.Repeat("0", 64)}, e.cookie); code != http.StatusBadRequest {
		t.Fatalf("чужая сумма: %d", code)
	}
	if code, _ = do(http.MethodPost, "/api/module-catalog/install-url", map[string]any{"url": "ftp://x/y.btmod"}, e.cookie); code != http.StatusBadRequest {
		t.Fatalf("не http: %d", code)
	}
	if code, _ = do(http.MethodPost, "/api/module-catalog/install-url", map[string]any{"url": urls["dep"] + "x"}, e.cookie); code != http.StatusBadGateway {
		t.Fatalf("нет файла: %d", code)
	}
	if code, out = do(http.MethodPost, "/api/module-catalog/install-url", map[string]any{"url": urls["dep"]}, e.cookie); code != http.StatusCreated || out["id"] != "dep" {
		t.Fatalf("по ссылке: %d %v", code, out)
	}

	// Свои адреса.
	if code, _ = do(http.MethodPut, "/api/module-sources", map[string]any{"sources": []string{"ftp://x"}}, e.cookie); code != http.StatusBadRequest {
		t.Fatalf("кривой адрес: %d", code)
	}
	if code, out = do(http.MethodPut, "/api/module-sources", map[string]any{"sources": []string{indexURL + "?mirror=1"}}, e.cookie); code != http.StatusOK || len(out["custom"].([]any)) != 1 || len(out["sources"].([]any)) != 2 {
		t.Fatalf("адреса: %d %v", code, out)
	}
	if code, _ = do(http.MethodPut, "/api/module-sources", map[string]any{"sources": []string{}}, e.player); code != http.StatusForbidden {
		t.Fatalf("игрок меняет адреса: %d", code)
	}
}

func TestModuleCatalogUnavailable(t *testing.T) {
	e := newModuleEnv(t)
	if code, _ := e.do(t, http.MethodGet, "/api/module-catalog", nil, "", e.cookie); code != http.StatusServiceUnavailable {
		t.Fatalf("каталог не подключён: %d", code)
	}
}

func TestWorldRequirements(t *testing.T) {
	indexURL, _ := catalogServer(t)
	cat := modcatalog.New(modcatalog.Options{IndexURL: indexURL, Dir: t.TempDir(), AppVersion: "0.9.0", AllowPrivate: true})
	e := newModuleEnv(t, func(a *apihttp.API) { a.Catalog = cat })
	do := func(method, path string, body any, cookie *http.Cookie) (int, map[string]any) {
		var buf *bytes.Buffer
		if body != nil {
			buf = jsonBody(body)
		}
		return e.do(t, method, path, buf, "application/json", cookie)
	}
	ids := func(out map[string]any) string {
		var got []string
		for _, m := range out["missing"].([]any) {
			got = append(got, m.(map[string]any)["id"].(string))
		}
		return strings.Join(got, ",")
	}

	// Мир, созданный до модулей: списка нет, системы на сервере нет.
	old := &domain.Company{ID: "old-world", Name: "Старый", System: "rules"}
	if err := e.store.Create(context.Background(), old); err != nil {
		t.Fatal(err)
	}
	path := "/api/companies/old-world/requirements"
	if code, _ := do(http.MethodGet, path, nil, e.player); code != http.StatusForbidden {
		t.Fatalf("игрок: %d", code)
	}
	code, out := do(http.MethodGet, path, nil, e.cookie)
	if code != http.StatusOK || ids(out) != "rules,old-pack" {
		t.Fatalf("старый мир без модулей: %d %v", code, out)
	}
	first := out["missing"].([]any)[0].(map[string]any)
	if first["type"] != "system" || first["inCatalog"] != true || first["size"] == nil {
		t.Fatalf("описание системы: %v", first)
	}

	// Мир с модулем, которого в каталоге нет.
	odd := &domain.Company{ID: "odd-world", Name: "Чужой", System: domain.SystemCustom, Modules: []string{"ghost"}}
	if err := e.store.Create(context.Background(), odd); err != nil {
		t.Fatal(err)
	}
	code, out = do(http.MethodGet, "/api/companies/odd-world/requirements", nil, e.cookie)
	ghost := out["missing"].([]any)
	if code != http.StatusOK || len(ghost) != 1 || ghost[0].(map[string]any)["inCatalog"] != false {
		t.Fatalf("модуль вне каталога: %d %v", code, out)
	}

	// После установки системы мир без списка больше не требует контент.
	if code, _ = do(http.MethodPost, "/api/module-catalog/install", map[string]any{"id": "rules"}, e.cookie); code != http.StatusCreated {
		t.Fatalf("установка системы: %d", code)
	}
	if code, out = do(http.MethodGet, path, nil, e.cookie); code != http.StatusOK || ids(out) != "" {
		t.Fatalf("после установки: %d %v", code, out)
	}
	if code, _ = do(http.MethodGet, "/api/companies/нет/requirements", nil, e.cookie); code != http.StatusNotFound {
		t.Fatalf("нет мира: %d", code)
	}
}
