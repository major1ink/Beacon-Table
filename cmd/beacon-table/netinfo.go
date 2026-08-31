package main

import (
	"log"
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
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		log.Printf("Стол: http://localhost%s/", addr)
		return
	}
	ips := []string{host}
	if host == "" || host == "0.0.0.0" || host == "::" {
		ips = localIPv4s()
		if len(ips) == 0 {
			ips = []string{"localhost"}
		}
	}
	for _, ip := range ips {
		log.Printf("Стол: http://%s:%s/  (ДМ и игроки входят через одну страницу)", ip, port)
	}

	log.Println("Трансляция (ТВ/проектор): ссылку с ключом ДМ берёт на столе, раздел «Настройки»")
}

// virtualIfaceHints — куски имён интерфейсов, по которым отсеиваем адреса
var virtualIfaceHints = []string{"vpn", "vethernet", "virtual", "docker", "hyper-v", "loopback", "tap", "tun", "wsl"}

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
