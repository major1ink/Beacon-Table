//go:build desktop && !linux

package main

// trayAvailable — на Windows и macOS трей (область уведомлений, строка
// меню) есть всегда.
func trayAvailable() bool { return true }
