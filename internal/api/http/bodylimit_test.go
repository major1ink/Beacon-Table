package http

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

// bodyLimitServer — mux с одной ручкой /api/echo, дочитывающей тело, за
// LimitAPIBodies. /upload и импорт мира заведены отдельно для проверки
// исключений.
func bodyLimitServer(t *testing.T) *httptest.Server {
	t.Helper()
	read := func(w http.ResponseWriter, r *http.Request) {
		b, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(strconv.Itoa(len(b))))
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/echo", read)
	mux.HandleFunc("POST /api/companies/import", read)
	mux.HandleFunc("/upload", read)

	api := &API{}
	srv := httptest.NewServer(api.LimitAPIBodies(mux))
	t.Cleanup(srv.Close)
	return srv
}

func postCode(t *testing.T, url string, size int, chunked bool) int {
	t.Helper()
	body := strings.NewReader(strings.Repeat("x", size))
	req, err := http.NewRequest(http.MethodPost, url, body)
	if err != nil {
		t.Fatalf("запрос: %v", err)
	}
	if chunked {
		req.ContentLength = -1 // клиент шлёт chunked, без Content-Length
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", url, err)
	}
	_ = resp.Body.Close()
	return resp.StatusCode
}

// TestBodyLimitRejectsOversizedAPIBody — гигантский лист персонажа
// отклоняется по Content-Length, не будучи прочитанным.
func TestBodyLimitRejectsOversizedAPIBody(t *testing.T) {
	srv := bodyLimitServer(t)
	if code := postCode(t, srv.URL+"/api/echo", maxAPIBody+1, false); code != http.StatusRequestEntityTooLarge {
		t.Fatalf("код %d, ожидался 413", code)
	}
}

// TestBodyLimitRejectsOversizedChunked — тело без Content-Length обрывается
// на чтении: middleware ставит MaxBytesReader, хендлер получает ошибку.
func TestBodyLimitRejectsOversizedChunked(t *testing.T) {
	srv := bodyLimitServer(t)
	if code := postCode(t, srv.URL+"/api/echo", maxAPIBody+4096, true); code == http.StatusOK {
		t.Fatal("chunked-тело сверх лимита прочитано целиком")
	}
}

// TestBodyLimitAllowsNormalBody — обычный запрос проходит и доходит до
// хендлера целиком.
func TestBodyLimitAllowsNormalBody(t *testing.T) {
	srv := bodyLimitServer(t)
	if code := postCode(t, srv.URL+"/api/echo", 64<<10, false); code != http.StatusOK {
		t.Fatalf("нормальный запрос: код %d", code)
	}
}

// TestBodyLimitSkipsFileEndpoints — импорт мира и /upload под общий лимит не
// попадают: у них свой, больший.
func TestBodyLimitSkipsFileEndpoints(t *testing.T) {
	srv := bodyLimitServer(t)
	for _, path := range []string{"/api/companies/import", "/upload"} {
		if code := postCode(t, srv.URL+path, maxAPIBody+1<<20, false); code != http.StatusOK {
			t.Fatalf("%s: код %d — общий лимит не должен сюда доставать", path, code)
		}
	}
}
