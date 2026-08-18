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

// Границы для CharacterSheet.UpdateSheet — не бизнес-правила D&D (лист
// "умный бланк", формулы считает и так фронт), а чисто защита от
// злонамеренного/кривого клиента, который прислал бы гигабайтный JSON:
// каждое текстовое поле и число строк в динамических таблицах клампится
// молча, без ошибки — клиент никогда специально не бьёт по этим лимитам в
// нормальном использовании.
const (
	maxSheetLongText   = 10000 // большие текстовые поля (заметки, снаряжение, черты и т.п.)
	maxSheetShortText  = 300   // название/бонус/дистанция и т.п. в строках таблиц
	maxWeaponRows      = 50
	maxSpellRows       = 100
	maxResourceRows    = 20
	maxAttunementItems = 20
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
	sheet.Info.Background = clampRunes(sheet.Info.Background, maxSheetShortText)
	sheet.Info.Class = clampRunes(sheet.Info.Class, maxSheetShortText)
	sheet.Info.Subclass = clampRunes(sheet.Info.Subclass, maxSheetShortText)
	sheet.Info.Species = clampRunes(sheet.Info.Species, maxSheetShortText)
	sheet.Info.Race = clampRunes(sheet.Info.Race, maxSheetShortText)
	sheet.Info.PlayerName = clampRunes(sheet.Info.PlayerName, maxSheetShortText)

	sheet.Physical.Age = clampRunes(sheet.Physical.Age, maxSheetShortText)
	sheet.Physical.Height = clampRunes(sheet.Physical.Height, maxSheetShortText)
	sheet.Physical.Weight = clampRunes(sheet.Physical.Weight, maxSheetShortText)
	sheet.Physical.Eyes = clampRunes(sheet.Physical.Eyes, maxSheetShortText)
	sheet.Physical.Skin = clampRunes(sheet.Physical.Skin, maxSheetShortText)
	sheet.Physical.Hair = clampRunes(sheet.Physical.Hair, maxSheetShortText)

	sheet.Armor.OtherWeapons = clampRunes(sheet.Armor.OtherWeapons, maxSheetLongText)
	sheet.ToolsLanguages = clampRunes(sheet.ToolsLanguages, maxSheetLongText)
	sheet.Traits = clampRunes(sheet.Traits, maxSheetLongText)
	sheet.ProficiencyNotes = clampRunes(sheet.ProficiencyNotes, maxSheetLongText)

	sheet.Combat.HitDiceTotal = clampRunes(sheet.Combat.HitDiceTotal, maxSheetShortText)
	sheet.Combat.HitDiceCurrent = clampRunes(sheet.Combat.HitDiceCurrent, maxSheetShortText)
	sheet.Combat.Conditions = clampRunes(sheet.Combat.Conditions, maxSheetLongText)
	if sheet.Combat.DeathSaveSuccess < 0 {
		sheet.Combat.DeathSaveSuccess = 0
	} else if sheet.Combat.DeathSaveSuccess > 3 {
		sheet.Combat.DeathSaveSuccess = 3
	}
	if sheet.Combat.DeathSaveFail < 0 {
		sheet.Combat.DeathSaveFail = 0
	} else if sheet.Combat.DeathSaveFail > 3 {
		sheet.Combat.DeathSaveFail = 3
	}
	if sheet.Combat.Exhaustion < 0 {
		sheet.Combat.Exhaustion = 0
	} else if sheet.Combat.Exhaustion > 6 {
		sheet.Combat.Exhaustion = 6
	}

	if len(sheet.Weapons) > maxWeaponRows {
		sheet.Weapons = sheet.Weapons[:maxWeaponRows]
	}
	for i := range sheet.Weapons {
		sheet.Weapons[i].Name = clampRunes(sheet.Weapons[i].Name, maxSheetShortText)
		sheet.Weapons[i].Bonus = clampRunes(sheet.Weapons[i].Bonus, maxSheetShortText)
		sheet.Weapons[i].Damage = clampRunes(sheet.Weapons[i].Damage, maxSheetShortText)
		sheet.Weapons[i].Notes = clampRunes(sheet.Weapons[i].Notes, maxSheetLongText)
	}

	if len(sheet.Resources) > maxResourceRows {
		sheet.Resources = sheet.Resources[:maxResourceRows]
	}
	for i := range sheet.Resources {
		sheet.Resources[i].Name = clampRunes(sheet.Resources[i].Name, maxSheetShortText)
		sheet.Resources[i].Recovery = clampRunes(sheet.Resources[i].Recovery, maxSheetShortText)
	}

	if len(sheet.AttunementItems) > maxAttunementItems {
		sheet.AttunementItems = sheet.AttunementItems[:maxAttunementItems]
	}
	for i := range sheet.AttunementItems {
		sheet.AttunementItems[i].Name = clampRunes(sheet.AttunementItems[i].Name, maxSheetShortText)
	}

	sheet.Features = clampRunes(sheet.Features, maxSheetLongText)
	sheet.AttacksSpells = clampRunes(sheet.AttacksSpells, maxSheetLongText)
	sheet.Feats = clampRunes(sheet.Feats, maxSheetLongText)

	sheet.Goals = clampRunes(sheet.Goals, maxSheetLongText)
	sheet.Allies = clampRunes(sheet.Allies, maxSheetLongText)
	sheet.AdditionalFeatures = clampRunes(sheet.AdditionalFeatures, maxSheetLongText)
	sheet.Treasure = clampRunes(sheet.Treasure, maxSheetLongText)
	for i := range sheet.Notes {
		sheet.Notes[i] = clampRunes(sheet.Notes[i], maxSheetLongText)
	}

	for i := range sheet.Spellcasting.SlotsByLevel {
		sheet.Spellcasting.SlotsByLevel[i] = clampRunes(sheet.Spellcasting.SlotsByLevel[i], maxSheetShortText)
	}
	if len(sheet.PreparedSpells) > maxSpellRows {
		sheet.PreparedSpells = sheet.PreparedSpells[:maxSpellRows]
	}
	for i := range sheet.PreparedSpells {
		sheet.PreparedSpells[i].Name = clampRunes(sheet.PreparedSpells[i].Name, maxSheetShortText)
		sheet.PreparedSpells[i].CastTime = clampRunes(sheet.PreparedSpells[i].CastTime, maxSheetShortText)
		sheet.PreparedSpells[i].Range = clampRunes(sheet.PreparedSpells[i].Range, maxSheetShortText)
		sheet.PreparedSpells[i].Notes = clampRunes(sheet.PreparedSpells[i].Notes, maxSheetLongText)
	}

	sheet.Size = clampRunes(sheet.Size, maxSheetShortText)
	sheet.Appearance = clampRunes(sheet.Appearance, maxSheetLongText)
	sheet.Background = clampRunes(sheet.Background, maxSheetLongText)
	sheet.Alignment = clampRunes(sheet.Alignment, maxSheetShortText)
	sheet.Equipment = clampRunes(sheet.Equipment, maxSheetLongText)

	sheet.PersonalityTraits = clampRunes(sheet.PersonalityTraits, maxSheetLongText)
	sheet.Ideals = clampRunes(sheet.Ideals, maxSheetLongText)
	sheet.Bonds = clampRunes(sheet.Bonds, maxSheetLongText)
	sheet.Flaws = clampRunes(sheet.Flaws, maxSheetLongText)

	return sheet
}
