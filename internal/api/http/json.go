// Package http содержит тонкий REST-слой Beacon Table: хендлеры парсят
// запрос, вызывают ровно один метод соответствующего интерфейса
// service-слоя и мапят результат/ошибку на HTTP-ответ. Ни одного SQL-запроса
// или прямого обращения к диску здесь быть не должно — это и есть смысл
// разделения на слои.
package http

import (
	"encoding/json"
	"net/http"
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
