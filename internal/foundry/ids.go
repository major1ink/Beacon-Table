package foundry

import (
	"crypto/rand"
	"encoding/hex"
	"log"
)

// newID — тот же принцип, что у service.newID и app.newID (crypto/rand, 16
// байт hex), и локальный по той же причине: internal/service намеренно не
// экспортирует свой генератор, а общий пакет ради одной функции на масштабе
// проекта избыточен. Нужен здесь, потому что сцена приезжает из чужого
// формата целиком, со стенами и токенами, — раздать им наши id больше
// некому.
func newID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		log.Fatal("crypto/rand недоступен:", err)
	}
	return hex.EncodeToString(b)
}
