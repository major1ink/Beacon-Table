package service

import (
	"crypto/rand"
	"encoding/hex"
	"log"

	"golang.org/x/crypto/bcrypt"
)

// randomHex — общий генератор непредсказуемых ID/токенов на crypto/rand:
// ID аккаунтов/персонажей, токены сессий, разовый пароль seed-admin'а.
func randomHex(nBytes int) string {
	b := make([]byte, nBytes)
	if _, err := rand.Read(b); err != nil {
		log.Fatal("crypto/rand недоступен:", err)
	}
	return hex.EncodeToString(b)
}

func newID() string           { return randomHex(16) }
func newSessionToken() string { return randomHex(32) }

// generatePassword — человекочитаемый разовый пароль для seed-admin'а
// (печатается в лог при первом запуске). Не bcrypt — это открытый текст,
// который ДМ вводит в форму логина, хешируется уже там.
const passwordAlphabet = "abcdefghjkmnpqrstuvwxyzACDEFGHJKMNPQRSTUVWXYZ23456789"

func generatePassword() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		log.Fatal("crypto/rand недоступен:", err)
	}
	out := make([]byte, len(b))
	for i, v := range b {
		out[i] = passwordAlphabet[int(v)%len(passwordAlphabet)]
	}
	return string(out)
}

func hashPassword(plain string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(plain), bcrypt.DefaultCost)
	return string(b), err
}

func checkPassword(hash, plain string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(plain)) == nil
}
