package http_test

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	apihttp "beacon-table/internal/api/http"
	"beacon-table/internal/app"
	"beacon-table/internal/domain"
	"beacon-table/internal/module"
	"beacon-table/internal/repository/sqlite"
	"beacon-table/internal/service"
)

type moduleEnv struct {
	srv    *httptest.Server
	mgr    *app.CompanyManager
	world  string
	cookie *http.Cookie
	player *http.Cookie
}

func newModuleEnv(t *testing.T) *moduleEnv {
	t.Helper()
	ctx := context.Background()
	dir := t.TempDir()
	db, err := sqlite.Open(filepath.Join(dir, "beacon.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	accounts := sqlite.NewAccountStore(db)
	sessions := sqlite.NewSessionStore(db, accounts)
	mgr := app.NewCompanyManager(db, sqlite.NewCompanyStore(db), accounts, sessions, service.NewDiceRoller(),
		module.NewRegistry(filepath.Join(dir, "data", "modules"), nil, nil, "0.9.0"),
		filepath.Join(dir, "data"), filepath.Join(dir, "uploads"), "/uploads/", true, nil)
	if err := mgr.Bootstrap(ctx); err != nil {
		t.Fatal(err)
	}
	world, err := mgr.Create(ctx, "Мир", domain.SystemCustom)
	if err != nil {
		t.Fatal(err)
	}
	if err := mgr.Launch(ctx, world.ID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(mgr.Shutdown)
	for _, a := range []struct{ id, role, company, token string }{
		{"owner", domain.AccountRoleAdmin, "", "sess-owner"},
		{"player", domain.AccountRolePlayer, world.ID, "sess-player"},
	} {
		if err := accounts.Create(ctx, &domain.Account{ID: a.id, Username: a.id, PasswordHash: "x", Role: a.role, Status: domain.AccountStatusActive, CompanyID: a.company}); err != nil {
			t.Fatal(err)
		}
		if err := sessions.Create(ctx, a.token, a.id); err != nil {
			t.Fatal(err)
		}
	}
	api := apihttp.NewAPI(service.NewAuthService(accounts, sessions), nil, mgr, "0.9.0", false, nil)
	mux := http.NewServeMux()
	api.RegisterRoutes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return &moduleEnv{
		srv: srv, mgr: mgr, world: world.ID,
		cookie: &http.Cookie{Name: domain.SessionCookieName, Value: "sess-owner"},
		player: &http.Cookie{Name: domain.SessionCookieName, Value: "sess-player"},
	}
}

func (e *moduleEnv) do(t *testing.T, method, path string, body *bytes.Buffer, contentType string, cookie *http.Cookie) (int, map[string]any) {
	t.Helper()
	if body == nil {
		body = &bytes.Buffer{}
	}
	req, err := http.NewRequest(method, e.srv.URL+path, body)
	if err != nil {
		t.Fatal(err)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.AddCookie(cookie)
	resp, err := e.srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func moduleUpload(t *testing.T, files map[string]string) (*bytes.Buffer, string) {
	t.Helper()
	var archive bytes.Buffer
	zw := zip.NewWriter(&archive)
	for name, content := range files {
		w, _ := zw.Create(name)
		_, _ = w.Write([]byte(content))
	}
	_ = zw.Close()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", "extra.btmod")
	_, _ = fw.Write(archive.Bytes())
	_ = mw.Close()
	return &body, mw.FormDataContentType()
}

func TestModulesAPI(t *testing.T) {
	e := newModuleEnv(t)

	// Игроку модули не показывают и ставить не дают.
	if code, _ := e.do(t, http.MethodGet, "/api/modules", nil, "", e.player); code != http.StatusForbidden {
		t.Fatalf("игрок получил список модулей: %d", code)
	}

	body, ct := moduleUpload(t, map[string]string{
		"module.json":           `{"format":"beacon-module/v1","id":"extra","type":"content","title":"Доп","version":"1.0.0"}`,
		"bestiary/owlbear.json": `{"name":"Совомедведь"}`,
		"spells/light.json":     `{"name":"Свет","level":0}`,
	})
	code, out := e.do(t, http.MethodPost, "/api/modules", body, ct, e.cookie)
	if code != http.StatusCreated || out["id"] != "extra" {
		t.Fatalf("установка: %d %v", code, out)
	}
	if counts, _ := out["counts"].(map[string]any); counts["bestiary"] != float64(1) || counts["spells"] != float64(1) {
		t.Fatalf("счётчики карточек: %v", out["counts"])
	}

	bad, badCT := moduleUpload(t, map[string]string{"readme.txt": "не модуль"})
	if code, out := e.do(t, http.MethodPost, "/api/modules", bad, badCT, e.cookie); code != http.StatusBadRequest || !strings.Contains(out["error"].(string), "module.json") {
		t.Fatalf("архив без module.json: %d %v", code, out)
	}

	// Включаем в запущенном мире — карточки модуля появляются в бестиарии.
	code, _ = e.do(t, http.MethodPut, "/api/companies/"+e.world+"/modules", bytes.NewBufferString(`{"modules":["extra"]}`), "application/json", e.cookie)
	if code != http.StatusOK {
		t.Fatalf("включение: %d", code)
	}
	list, err := e.mgr.Current().Bestiary.List(context.Background())
	if err != nil || len(list) != 1 || list[0].ID != "extra--owlbear" || !list[0].System || list[0].Module != "extra" {
		t.Fatalf("бестиарий мира: %+v %v", list, err)
	}
	if code, _ := e.do(t, http.MethodPut, "/api/companies/"+e.world+"/modules", bytes.NewBufferString(`{"modules":["nope"]}`), "application/json", e.cookie); code != http.StatusBadRequest {
		t.Fatalf("неустановленный модуль включился: %d", code)
	}

	code, out = e.do(t, http.MethodGet, "/api/modules", nil, "", e.cookie)
	world, _ := out["world"].(map[string]any)
	if code != http.StatusOK || len(out["modules"].([]any)) != 1 || world["enabled"].([]any)[0] != "extra" {
		t.Fatalf("список: %d %v", code, out)
	}

	// Удаление: мир помнит модуль как ненайденный.
	if code, _ := e.do(t, http.MethodDelete, "/api/modules/extra", nil, "", e.cookie); code != http.StatusNoContent {
		t.Fatalf("удаление: %d", code)
	}
	_, out = e.do(t, http.MethodGet, "/api/modules", nil, "", e.cookie)
	world, _ = out["world"].(map[string]any)
	if missing := world["missing"].([]any); len(missing) != 1 || missing[0] != "extra" {
		t.Fatalf("ненайденные после удаления: %v", world)
	}
	if code, _ := e.do(t, http.MethodDelete, "/api/modules/extra", nil, "", e.cookie); code != http.StatusNotFound {
		t.Fatalf("повторное удаление: %d", code)
	}
}

// TestCardExtraKeysThroughAPI — поле, которого сервер не знает (поле схемы
// системы из модуля), переживает запись через API и чтение обратно.
func TestCardExtraKeysThroughAPI(t *testing.T) {
	e := newModuleEnv(t)
	code, created := e.do(t, http.MethodPost, "/api/bestiary", bytes.NewBufferString(`{"name":"Тварь"}`), "application/json", e.cookie)
	if code != http.StatusCreated && code != http.StatusOK {
		t.Fatalf("создание: %d %v", code, created)
	}
	id, _ := created["id"].(string)
	body := `{"id":"` + id + `","name":"Тварь","ac":12,"stats":{"рассудок":60,"порча":[1,2]}}`
	if code, out := e.do(t, http.MethodPut, "/api/bestiary/"+id, bytes.NewBufferString(body), "application/json", e.cookie); code != http.StatusOK {
		t.Fatalf("запись: %d %v", code, out)
	}
	_, got := e.do(t, http.MethodGet, "/api/bestiary/"+id, nil, "", e.cookie)
	stats, _ := got["stats"].(map[string]any)
	if got["ac"] != float64(12) || stats["рассудок"] != float64(60) {
		t.Fatalf("незнакомое поле потерялось: %v", got)
	}
}
