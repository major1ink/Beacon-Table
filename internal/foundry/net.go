package foundry

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"time"
)

// GuardedTransport — транспорт для http-клиента импорта модулей. Ссылку на
// манифест и на архив даёт пользователь (ДМ), а обычный клиент сходил бы по
// ней куда угодно.
//
// Проверка стоит на дозвоне, а не только на разборе ссылки: так она ловит и
// DNS-подмену (имя резолвится в публичный адрес при проверке и в
// 127.0.0.1 — при запросе), и редиректы (каждый прыжок — свой дозвон, свой
// адрес), и IP в необычной записи (десятичной, восьмеричной) — к моменту
// дозвона это уже разрешённый адрес.
//
// allowPrivateNetwork — можно ли ходить в приватную сеть и на localhost.
// По умолчанию нельзя; включается для сервера, НЕ выставленного в интернет
// (см. --behind-proxy), где локальное зеркало модулей на соседней машине —
// законный сценарий, а границы привилегий вокруг localhost всё равно нет.
// Метаданные облака, multicast и IPv4-в-IPv6 туннели
// заблокированы всегда, независимо от флага: законной ссылки на модуль там
// не бывает.
func GuardedTransport(allowPrivateNetwork bool) *http.Transport {
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	return &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           guardedDialContext(dialer, allowPrivateNetwork),
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          10,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
}

func guardedDialContext(dialer *net.Dialer, allowPrivate bool) func(context.Context, string, string) (net.Conn, error) {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, err
		}
		if len(ips) == 0 {
			return nil, fmt.Errorf("не удалось разрешить адрес %s", host)
		}
		// Если ХОТЬ ОДИН из адресов имени запретный — отказываем целиком:
		// иначе имя с парой A-записей (одна публичная, одна на 127.0.0.1)
		// проскочило бы через happy-eyeballs.
		for _, ip := range ips {
			if blockedIP(ip.IP, allowPrivate) {
				return nil, &blockedAddrError{host: host, ip: ip.IP}
			}
		}
		// Дозваниваемся по уже проверенному адресу, а не по имени — между
		// проверкой и звонком имя не должно «перевернуться».
		var lastErr error
		for _, ip := range ips {
			conn, derr := dialer.DialContext(ctx, network, net.JoinHostPort(ip.IP.String(), port))
			if derr == nil {
				return conn, nil
			}
			lastErr = derr
		}
		return nil, lastErr
	}
}

type blockedAddrError struct {
	host string
	ip   net.IP
}

func (e *blockedAddrError) Error() string {
	return fmt.Sprintf("адрес %s (%s) ведёт в частную или служебную сеть — ссылка на модуль Foundry должна быть публичной", e.host, e.ip)
}

// tunnelPrefixes — префиксы IPv6, оборачивающие адрес IPv4 (6to4, Teredo,
// well-known NAT64). За таким адресом может прятаться приватный или
// служебный IPv4, а публичный хостинг модулей так не адресуют — блокируем
// целиком, не разбирая вложенный адрес.
var tunnelPrefixes = func() []*net.IPNet {
	out := make([]*net.IPNet, 0, 3)
	for _, cidr := range []string{"2002::/16", "2001::/32", "64:ff9b::/96"} {
		if _, n, err := net.ParseCIDR(cidr); err == nil {
			out = append(out, n)
		}
	}
	return out
}()

// blockedIP — адрес, на который серверу импорта ходить нельзя.
func blockedIP(ip net.IP, allowPrivate bool) bool {
	if ip == nil {
		return true
	}
	// Всегда запрещено, независимо от флага: link-local (169.254/16 — адрес
	// метаданных облака), multicast, неопределённые адреса и туннели,
	// оборачивающие IPv4. Законной ссылки на модуль там нет никогда.
	if ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() ||
		ip.IsMulticast() ||
		ip.IsUnspecified() {
		return true
	}
	for _, block := range tunnelPrefixes {
		if block.Contains(ip) {
			return true
		}
	}
	if v4 := ip.To4(); v4 != nil && (v4[0] == 0 || v4[0] >= 240) {
		// 0.0.0.0/8 «этот хост в этой сети», 240/4 зарезервировано,
		// 255.255.255.255 broadcast — не адрес назначения ни при каких флагах.
		return true
	}

	if allowPrivate {
		return false
	}
	// Сервер выставлен в интернет — в приватную сеть и на localhost ходить
	// незачем (там нет ни зеркала модулей, ни публичного хостинга).
	if ip.IsLoopback() || ip.IsPrivate() { // 127/8, ::1, RFC 1918, ULA fc00::/7
		return true
	}
	if v4 := ip.To4(); v4 != nil && v4[0] == 100 && v4[1]&0xc0 == 64 {
		return true // 100.64/10 — CGNAT, сюда же попадают адреса Tailscale
	}
	return false
}
