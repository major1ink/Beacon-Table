package domain

import "time"

// Note — заметка ДМ: настоящий markdown-текст, хранится файлом на диске (см.
// internal/repository/notefile). ID — стабильный, генерируется один раз при
// создании (service.newID()) и не меняется при редактировании — в отличие от
// Title, который просто выводится из первой строки Content вида "# Заголовок"
// (см. notefile.deriveTitle). Так переименование — обычная правка текста, а не
// отдельная операция, и ничто, ссылающееся на заметку по ID (NoteMarker на
// карте, вики-ссылки [[...]] из других заметок — резолвятся по текущему
// заголовку на клиенте), не осиротевает.
type Note struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Content   string    `json:"content,omitempty"` // пусто в списке (List) — только в Get/Create/Update
	UpdatedAt time.Time `json:"updatedAt"`
}
