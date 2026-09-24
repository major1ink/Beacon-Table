//go:build desktop && !(linux && gtk3)

package main

import "github.com/wailsapp/wails/v3/pkg/application"

// reloadOnCrash — только для WebKitGTK (см. desktop_crash_linux.go).
func reloadOnCrash(*application.WebviewWindow) {}
