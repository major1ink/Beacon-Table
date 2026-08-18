package main

import (
	"log"
	"net"
	"strings"
)

// printAccessURLs печатает реальные адреса, по которым игроки/DM в локальной
// сети могут открыть стол — вместо плейсхолдера "<ip-этого-компа>", который
// надо было руками подставлять самому. Если ни одного адреса найти не
// удалось (сеть отключена и т.п.), тихо откатываемся на localhost — сервер
// всё равно рабочий на этом же компе. Логин/пароль ДМ печатает
// authService.SeedAdmin отдельно — сюда он не попадает.
func printAccessURLs() {
	ips := localIPv4s()
	if len(ips) == 0 {
		ips = []string{"localhost"}
	}
	for _, ip := range ips {
		log.Printf("Стол: http://%s:8080/  (ДМ и игроки входят через одну страницу)", ip)
		log.Printf("TV:   http://%s:8080/tv.html", ip)
	}
}

// virtualIfaceHints — куски имён интерфейсов, по которым отсеиваем адреса,
// бесполезные для игроков за столом: VPN-туннели, виртуальные свитчи
// Hyper-V/WSL/Docker и т.п. У DM их может быть несколько сразу, и без
// фильтра лог заспамлен адресами, по которым TV из той же Wi-Fi сети
// физически не достучится.
var virtualIfaceHints = []string{"vpn", "vethernet", "virtual", "docker", "hyper-v", "loopback", "tap", "tun", "wsl"}

// localIPv4s возвращает не-loopback IPv4-адреса реальных сетевых интерфейсов
// машины (обычно это Wi-Fi/Ethernet в локальной сети за столом) — то есть
// адреса, по которым TV/планшет игрока в той же сети реально может открыть
// страницу. Виртуальные адаптеры и APIPA-адреса (169.254.x.x, интерфейс
// поднят, но без реальной сети) отфильтровываются.
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
