package http

import (
	"io/fs"
	"net/http"
)

// NoDirListing — http.FileSystem, которая делает вид, что каталогов не
// существует. Нужна поверх раздачи загрузок: http.FileServer на запрос
// каталога без index.html печатает список его содержимого, то есть отдаёт
// готовый указатель на все карты, токены и аудио сервера — даже тому, кто
// имён файлов не знает.
//
// Только для /uploads/: раздачу собранного фронта так оборачивать нельзя —
// там FileServer открывает каталог именно затем, чтобы найти в нём
// index.html, и запрет каталогов сломал бы корневой адрес.
type NoDirListing struct {
	FS http.FileSystem
}

// Open implements http.FileSystem.
func (n NoDirListing) Open(name string) (http.File, error) {
	f, err := n.FS.Open(name)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	if info.IsDir() {
		_ = f.Close()
		// Именно "не существует", а не "запрещено": ответ 404 не
		// подтверждает, что каталог по этому пути есть.
		return nil, fs.ErrNotExist
	}
	return f, nil
}
