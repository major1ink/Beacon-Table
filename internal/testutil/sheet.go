package testutil

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// DnDSheetJSON — лист персонажа D&D, где заполнено каждое поле (включая
// вложенные): то, что раньше давал Fill по полям структуры. Поля системы
// лежат в Extra листа, поэтому структурой их не заполнить.
func DnDSheetJSON(t *testing.T) []byte {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	data, err := os.ReadFile(filepath.Join(filepath.Dir(file), "testdata", "dnd-sheet-full.json"))
	if err != nil {
		t.Fatal(err)
	}
	return data
}
