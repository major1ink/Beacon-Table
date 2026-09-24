//go:build desktop && linux

package main

import "github.com/godbus/dbus/v5"

// trayAvailable — есть ли кому показать иконку: трей на Linux —
// StatusNotifierItem, и без хоста (голый GNOME без расширения AppIndicator)
// иконки просто нет. Спрятанное окно тогда не вернуть.
func trayAvailable() bool {
	conn, err := dbus.SessionBus() // общее соединение — не закрываем
	if err != nil {
		return false
	}
	var has bool
	err = conn.BusObject().Call("org.freedesktop.DBus.NameHasOwner", 0, "org.kde.StatusNotifierWatcher").Store(&has)
	return err == nil && has
}
