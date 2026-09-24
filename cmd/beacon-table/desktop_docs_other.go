//go:build desktop && !windows

package main

import (
	"bufio"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// documentsDir — папка «Документы». На Linux её путь не зашит: он записан в
// user-dirs.dirs (XDG) и на русской системе обычно ~/Документы. Пусто, если
// такой папки нет — тогда папку стола предложим в каталоге данных программ.
func documentsDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	if runtime.GOOS != "linux" {
		return filepath.Join(home, "Documents")
	}
	conf := os.Getenv("XDG_CONFIG_HOME")
	if conf == "" {
		conf = filepath.Join(home, ".config")
	}
	f, err := os.Open(filepath.Join(conf, "user-dirs.dirs")) //nolint:gosec // G304: стандартный файл XDG в домашнем каталоге
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		v, ok := strings.CutPrefix(strings.TrimSpace(sc.Text()), "XDG_DOCUMENTS_DIR=")
		if !ok {
			continue
		}
		dir := strings.Replace(strings.Trim(v, `"`), "$HOME", home, 1)
		// «Документы» = сам домашний каталог — так XDG помечает, что папки нет.
		if filepath.Clean(dir) == filepath.Clean(home) {
			return ""
		}
		//nolint:gosec // G703: путь из стандартного файла XDG в домашнем каталоге
		if st, err := os.Stat(dir); err == nil && st.IsDir() {
			return dir
		}
		return ""
	}
	return ""
}
