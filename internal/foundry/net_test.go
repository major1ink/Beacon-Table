package foundry

import (
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestBlockedIP — таблица адресов, куда импорту ходить нельзя, и куда можно.
// Флаг allowPrivate меняет только приватную сеть и localhost; служебные
// адреса и метаданные облака закрыты при любом его значении.
func TestBlockedIP(t *testing.T) {
	always := []string{
		"169.254.169.254",    // метаданные облака
		"169.254.0.1",        // link-local
		"224.0.0.1",          // multicast
		"255.255.255.255",    // broadcast
		"0.0.0.0",            // неопределённый
		"0.1.2.3",            // 0.0.0.0/8
		"240.0.0.1",          // зарезервировано
		"ff02::1",            // IPv6 multicast
		"fe80::1",            // IPv6 link-local
		"::",                 // IPv6 неопределённый
		"2002:7f00:1::",      // 6to4, оборачивает 127.0.0.1
		"2001:0:1:2:3:4:5:6", // Teredo
		"64:ff9b::7f00:1",    // NAT64 well-known, оборачивает 127.0.0.1
	}
	for _, s := range always {
		ip := net.ParseIP(s)
		if ip == nil {
			t.Fatalf("не разобрал тестовый адрес %q", s)
		}
		if !blockedIP(ip, false) {
			t.Errorf("%s должен блокироваться (allowPrivate=false)", s)
		}
		if !blockedIP(ip, true) {
			t.Errorf("%s должен блокироваться даже при allowPrivate=true", s)
		}
	}

	privateOrLocal := []string{
		"127.0.0.1", "127.0.0.53", "::1",
		"10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1",
		"fd00::1",         // ULA
		"100.64.0.1",      // CGNAT / Tailscale
		"100.127.255.255", // край CGNAT
	}
	for _, s := range privateOrLocal {
		ip := net.ParseIP(s)
		if !blockedIP(ip, false) {
			t.Errorf("%s должен блокироваться на публичном сервере", s)
		}
		if blockedIP(ip, true) {
			t.Errorf("%s должен пропускаться на локальной установке (allowPrivate=true)", s)
		}
	}

	public := []string{
		"8.8.8.8", "1.1.1.1", "93.184.216.34", // example.com
		"2606:4700:4700::1111", // Cloudflare DNS v6
		"172.32.0.1",           // соседний с 172.16/12, но публичный
		"192.169.0.1",          // соседний с 192.168/16, но публичный
	}
	for _, s := range public {
		if blockedIP(net.ParseIP(s), false) {
			t.Errorf("публичный %s заблокирован", s)
		}
	}
}

// TestGuardedTransportRefusesLoopback — сквозная проверка: клиент с
// GuardedTransport в публичном режиме не соединяется с сервером на
// 127.0.0.1, хотя тот жив и отвечает. Это и есть защита от запроса на свой
// же localhost и внутренние сервисы; редиректы и DNS-подмену тот же дозвон
// перехватывает на каждом хопе.
func TestGuardedTransportRefusesLoopback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("секрет"))
	}))
	defer srv.Close()

	client := &http.Client{Timeout: 5 * time.Second, Transport: GuardedTransport(false)}
	resp, err := client.Get(srv.URL)
	if err == nil {
		_ = resp.Body.Close()
		t.Fatal("запрос на loopback прошёл")
	}
	var blocked *blockedAddrError
	if !errors.As(err, &blocked) {
		t.Fatalf("ошибка не про блокировку адреса: %v", err)
	}

	// В доверенном режиме (локальная установка) тот же запрос проходит.
	trusting := &http.Client{Timeout: 5 * time.Second, Transport: GuardedTransport(true)}
	resp, err = trusting.Get(srv.URL)
	if err != nil {
		t.Fatalf("доверенный режим не пустил на loopback: %v", err)
	}
	_ = resp.Body.Close()
}
