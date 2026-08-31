package ws

import (
	"net/http"
	"testing"
)

func request(t *testing.T, host, origin string) *http.Request {
	t.Helper()
	r, err := http.NewRequest(http.MethodGet, "http://"+host+"/ws/dm", nil)
	if err != nil {
		t.Fatalf("запрос: %v", err)
	}
	r.Host = host
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	return r
}

// TestCheckOriginAcceptsOwnPages — обычная работа: страница открыта по тому
// же адресу, на котором стоит сервер. Проверяются формы, в которых стол
// реально открывают: localhost, адрес в локальной сети с портом, имя сайта
// за HTTPS-прокси (схема при этом другая — сервер за прокси слушает http).
func TestCheckOriginAcceptsOwnPages(t *testing.T) {
	cases := []struct {
		host, origin string
	}{
		{"localhost:8080", "http://localhost:8080"},
		{"192.168.1.10:8080", "http://192.168.1.10:8080"},
		{"стол.example.com", "https://стол.example.com"},
		{"example.com:8443", "https://example.com:8443"},
		{"Example.com", "https://example.com"}, // регистр хоста роли не играет
	}
	for _, c := range cases {
		if !checkOrigin(request(t, c.host, c.origin), Options{}) {
			t.Fatalf("своя же страница отвергнута: host %q, origin %q", c.host, c.origin)
		}
	}
}

// TestCheckOriginRejectsForeignPages — то, ради чего проверка и вводилась:
// чужой сайт с открытой у пользователя вкладкой не должен уметь подключиться
// к его столу по живой cookie сессии.
func TestCheckOriginRejectsForeignPages(t *testing.T) {
	cases := []struct {
		host, origin string
	}{
		{"стол.example.com", "https://злодей.example.net"},
		{"192.168.1.10:8080", "http://192.168.1.10:9999"},    // другой порт — другой origin
		{"стол.example.com", "https://стол.example.com.zlo"}, // похожее имя, но чужое
		{"стол.example.com", "не адрес вовсе"},
	}
	for _, c := range cases {
		if checkOrigin(request(t, c.host, c.origin), Options{}) {
			t.Fatalf("чужая страница принята: host %q, origin %q", c.host, c.origin)
		}
	}
}

// TestCheckOriginEmptyDependsOnExposure — заголовка нет: это не браузер, а
// свой клиент или проверка через curl. В локальной сети пускаем, сервер в
// интернете — нет.
func TestCheckOriginEmptyDependsOnExposure(t *testing.T) {
	r := request(t, "192.168.1.10:8080", "")
	if !checkOrigin(r, Options{BehindProxy: false}) {
		t.Fatal("запрос без Origin отвергнут в локальной сети")
	}
	if checkOrigin(r, Options{BehindProxy: true}) {
		t.Fatal("запрос без Origin принят сервером, смотрящим в интернет")
	}
}

// TestCheckOriginAllowList — клапан для прокси, который не передаёт исходный
// Host: без него стол на таком сервере не открылся бы вовсе.
func TestCheckOriginAllowList(t *testing.T) {
	r := request(t, "127.0.0.1:8080", "https://стол.example.com")
	if checkOrigin(r, Options{}) {
		t.Fatal("origin, не совпавший с Host, принят без списка разрешённых")
	}

	// В списке принимаются обе записи — и с схемой, и голым именем.
	for _, allowed := range []string{"стол.example.com", "https://стол.example.com"} {
		if !checkOrigin(r, Options{AllowedOrigins: []string{allowed}}) {
			t.Fatalf("разрешённый адрес %q не сработал", allowed)
		}
	}
	if checkOrigin(r, Options{AllowedOrigins: []string{"другой.example.com"}}) {
		t.Fatal("список разрешённых пропустил чужой адрес")
	}
}
