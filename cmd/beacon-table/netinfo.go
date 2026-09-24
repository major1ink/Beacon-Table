package main

import (
	"log/slog"
	"net"
	"strings"
)

// printAccessURLs печатает реальные адреса, по которым игроки/DM в локальной
// сети могут открыть стол — вместо плейсхолдера "<ip-этого-компа>". Если ни одного адреса найти не
// удалось (сеть отключена и т.п.), localhost — сервер
// всё равно рабочий на этом же компе.
//
// addr — то, что слушает сервер (см. Config.Addr): из него берётся порт, а
// если слушаем конкретный адрес ("127.0.0.1:8080"), то печатается он один —
// перебирать интерфейсы, на которых сервера всё равно нет, незачем.
func printAccessURLs(addr string) {
	for _, u := range accessURLs(addr) {
		slog.Info("Стол доступен по адресу — ДМ и игроки входят через одну страницу", "url", u)
	}

	slog.Info("Трансляция (ТВ/проектор): ссылку с ключом ДМ берёт на столе, раздел «Настройки»")
}

// accessURLs — адреса, по которым стол открывают игроки и телевизор; их же
// показывает трей десктопа.
func accessURLs(addr string) []string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return []string{"http://localhost" + addr + "/"}
	}
	ips := []string{host}
	if host == "" || host == "0.0.0.0" || host == "::" {
		ips = localIPv4s()
		if len(ips) == 0 {
			ips = []string{"localhost"}
		}
	}
	urls := make([]string, 0, len(ips))
	for _, ip := range ips {
		urls = append(urls, "http://"+net.JoinHostPort(ip, port)+"/")
	}
	return urls
}

// "amn" — AmneziaVPN (интерфейс amn0): его адрес игрокам в сети ни к чему.
var virtualIfaceHints = []string{"vpn", "vethernet", "virtual", "docker", "hyper-v", "loopback", "tap", "tun", "wsl", "amn"}

func localIPv4s() []string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var out []string
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		lname := strings.ToLower(iface.Name)
		skip := false
		for _, hint := range virtualIfaceHints {
			if strings.Contains(lname, hint) {
				skip = true
				break
			}
		}
		if skip {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			var ip net.IP
			switch v := a.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			ip4 := ip.To4()
			if ip4 == nil || ip4.IsLoopback() || ip4.IsLinkLocalUnicast() {
				continue
			}
			out = append(out, ip4.String())
		}
	}
	return out
}
