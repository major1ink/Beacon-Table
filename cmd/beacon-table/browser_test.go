package main

import (
	"path/filepath"
	"testing"
)

func TestBrowserURL(t *testing.T) {
	cases := map[string]string{
		":8080":            "http://localhost:8080/",
		"0.0.0.0:8080":     "http://localhost:8080/",
		"127.0.0.1:18080":  "http://127.0.0.1:18080/",
		"192.168.1.5:8080": "http://192.168.1.5:8080/",
		"[::]:8080":        "http://localhost:8080/",
	}
	for addr, want := range cases {
		if got := browserURL(addr); got != want {
			t.Errorf("browserURL(%q) = %q, ожидалось %q", addr, got, want)
		}
	}
}

// TestShouldOpenBrowser — «auto» не должно открывать браузер там, где его
// нет: за прокси (сервер) и в демо-режиме (витрина).
func TestShouldOpenBrowser(t *testing.T) {
	if !shouldOpenBrowser(Config{OpenBrowser: "true", DemoMode: true}) {
		t.Error("явное true должно открывать браузер при любых прочих настройках")
	}
	if shouldOpenBrowser(Config{OpenBrowser: "false"}) {
		t.Error("явное false не должно открывать браузер")
	}
	if shouldOpenBrowser(Config{OpenBrowser: "auto", BehindProxy: true}) {
		t.Error("за прокси браузер открывать некому")
	}
	if shouldOpenBrowser(Config{OpenBrowser: "auto", DemoMode: true}) {
		t.Error("в демо-режиме браузер открывать некому")
	}
}

func TestLogPath(t *testing.T) {
	want := filepath.Join("data", "beacon.log")
	if got := (Config{DataDir: "data"}).LogPath(); got != want {
		t.Errorf("по умолчанию %q, ожидался %q", got, want)
	}
	if got := (Config{DataDir: "data", LogFile: "off"}).LogPath(); got != "" {
		t.Errorf("off даёт %q, ожидалась пустая строка", got)
	}
	if got := (Config{DataDir: "data", LogFile: "/var/log/beacon.log"}).LogPath(); got != "/var/log/beacon.log" {
		t.Errorf("явный путь потерялся: %q", got)
	}
}
