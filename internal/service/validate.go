package service

import (
	"strings"

	"beacon-table/internal/domain"
)

// Правила валидации, общие для нескольких сервисов (регистрация игрока и
// админ-создание аккаунта используют одни и те же ограничения на имя
// пользователя/пароль) — вынесены сюда, чтобы не разъезжались тексты
// сообщений и границы длины между местами вызова.

func validateUsername(username string) (string, error) {
	username = strings.TrimSpace(username)
	if len(username) < 3 || len(username) > 32 {
		return "", &domain.ValidationError{Msg: "имя пользователя — от 3 до 32 символов"}
	}
	return username, nil
}

func validatePassword(password string) error {
	if len(password) < 6 {
		return &domain.ValidationError{Msg: "пароль — минимум 6 символов"}
	}
	return nil
}

func validateCharacterName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 60 {
		return "", &domain.ValidationError{Msg: "имя персонажа обязательно (до 60 символов)"}
	}
	return name, nil
}

func validatePlaylistName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 60 {
		return "", &domain.ValidationError{Msg: "название плейлиста обязательно (до 60 символов)"}
	}
	return name, nil
}

// clampVolume — тот же дефолт "из коробки" (0.8), что и раньше в
// db.go/auth_http.go: пустая/некорректная громкость не считается ошибкой
// ввода, а тихо приводится к разумному значению.
func clampVolume(v float64) float64 {
	if v <= 0 {
		return 0.8
	}
	if v > 1 {
		return 1
	}
	return v
}

// Границы листа (CharacterSheet.UpdateSheet) — не правила игры, а защита
// от кривого клиента: строки и списки режет общий clampCard (см.
// cardlimits.go). maxSheetDeathSaves/maxSheetExhaustion — санитарный
// потолок счётчиков: сколько их на самом деле, решает система (у D&D — 3 и
// 6); здесь тот же потолок, что у счётчика спасбросков в правилах боя и у
// уровней состояния.
const (
	maxSheetDeathSaves = 10
	maxSheetExhaustion = 20
)

func clampRunes(s string, max int) string {
	r := []rune(s)
	if len(r) > max {
		return string(r[:max])
	}
	return s
}

// sanitizeSheet — see maxSheet* выше.
func sanitizeSheet(sheet domain.CharacterSheet) domain.CharacterSheet {
	clampCard(&sheet)
	sheet.Extra = clampExtra(sheet.Extra)
	sheet.Coins = domain.SanitizeCoins(sheet.Coins)
	sheet.Combat.DeathSaveSuccess = clampCount(sheet.Combat.DeathSaveSuccess, maxSheetDeathSaves)
	sheet.Combat.DeathSaveFail = clampCount(sheet.Combat.DeathSaveFail, maxSheetDeathSaves)
	sheet.Combat.Exhaustion = clampCount(sheet.Combat.Exhaustion, maxSheetExhaustion)
	return sheet
}
