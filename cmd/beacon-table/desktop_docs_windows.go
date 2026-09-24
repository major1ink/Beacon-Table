//go:build desktop && windows

package main

import "golang.org/x/sys/windows"

// documentsDir — настоящая папка «Документы»: её часто переносят в OneDrive
// или на другой диск, и %USERPROFILE%\Documents тогда указывал бы мимо.
func documentsDir() string {
	dir, err := windows.KnownFolderPath(windows.FOLDERID_Documents, 0)
	if err != nil {
		return ""
	}
	return dir
}
