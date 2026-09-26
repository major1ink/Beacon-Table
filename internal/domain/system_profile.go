package domain

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// SystemUnits — единицы игровой системы для чисел, которые ядро хранит без
// единиц: вес предметов и инвентаря (Item.WeightValue).
type SystemUnits struct {
	Weight string `json:"weight"`
}

// Currency — валюта системы: ключ в Coins листа, короткая подпись на листе
// («ЗМ») и полное название («золото»).
type Currency struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Title string `json:"title,omitempty"`
}

// SystemProfile — то, что клиенту нужно знать о системе мира, чтобы
// показать лист, вес и деньги (см. GET /api/system).
type SystemProfile struct {
	ID         string      `json:"id"`
	Title      string      `json:"title"`
	Sheet      string      `json:"sheet"`
	Units      SystemUnits `json:"units"`
	Currencies []Currency  `json:"currencies"`
}

// SheetUniversal — вид листа по умолчанию: универсальный лист (хиты,
// защита, скорость, инициатива, свободные характеристики, броски, ресурсы,
// инвентарь, деньги, заметки). Другие виды — бланки, которые клиент знает
// поимённо (у встроенного D&D — "dnd5e-2014" и "dnd5e-2024"); их заменит
// схема листа из модуля (задача «Схемы листа и карточек»).
const SheetUniversal = "universal"

// LegacySheetKind — вид листа, который клиент рисует старым кодом, а не по
// схеме: бланки встроенного D&D. Пока система с таким видом листа не несёт
// своих схем, лист и карточки её мира рисуются по-старому (переезд — задача
// «Модуль D&D на схемах»).
func LegacySheetKind(kind string) bool {
	return kind == "dnd5e-2014" || kind == "dnd5e-2024"
}

var sheetKindRe = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

// ValidSheetKind — годится ли строка в вид листа (раздел sheet в
// module.json). Какие виды клиент умеет рисовать, решает клиент:
// незнакомый вид он показывает универсальным листом.
func ValidSheetKind(kind string) bool {
	return len(kind) <= 64 && sheetKindRe.MatchString(kind)
}

// CustomUnits / CustomCurrencies — умолчания «Своей системы» и мира, чья
// система своих единиц и валют не задаёт.
func CustomUnits() SystemUnits { return SystemUnits{Weight: "кг"} }

func CustomCurrencies() []Currency {
	return []Currency{{Key: "money", Label: "Деньги"}}
}

// MaxCurrencies — сколько валют может быть у системы и в Coins листа;
// остальное — санитарные пределы длины.
const (
	MaxCurrencies    = 32
	maxCurrencyKey   = 32
	maxCurrencyLabel = 32
	maxWeightUnit    = 16
)

var currencyKeyRe = regexp.MustCompile(`^[a-z0-9_-]+$`)

// ValidCurrencyKey — годится ли строка в ключ валюты.
func ValidCurrencyKey(key string) bool {
	return len(key) <= maxCurrencyKey && currencyKeyRe.MatchString(key)
}

// ValidateUnits — единицы из module.json.
func ValidateUnits(u *SystemUnits) error {
	u.Weight = strings.TrimSpace(u.Weight)
	if len([]rune(u.Weight)) > maxWeightUnit {
		return fmt.Errorf("единица веса %q длиннее %d символов", u.Weight, maxWeightUnit)
	}
	return nil
}

// ValidateCurrencies — валюты из module.json: ключи по синтаксису и без
// повторов, у каждой подпись.
func ValidateCurrencies(list []Currency) error {
	if len(list) > MaxCurrencies {
		return fmt.Errorf("валют больше %d", MaxCurrencies)
	}
	seen := map[string]bool{}
	for _, c := range list {
		switch {
		case !ValidCurrencyKey(c.Key):
			return fmt.Errorf("неверный ключ валюты %q: латиница в нижнем регистре, цифры, _ и -", c.Key)
		case seen[c.Key]:
			return fmt.Errorf("валюта %q объявлена дважды", c.Key)
		case strings.TrimSpace(c.Label) == "" || len([]rune(c.Label)) > maxCurrencyLabel:
			return fmt.Errorf("у валюты %q нет подписи или она длиннее %d символов", c.Key, maxCurrencyLabel)
		}
		seen[c.Key] = true
	}
	return nil
}

// SanitizeCoins — деньги листа: негодные ключи выбрасываются, отрицательные
// суммы поджимаются к нулю, валют не больше MaxCurrencies (остаются первые
// по алфавиту, чтобы результат не зависел от порядка обхода map).
// Незнакомые системе, но годные ключи остаются.
func SanitizeCoins(c Coins) Coins {
	out := Coins{}
	keys := make([]string, 0, len(c))
	for k := range c {
		if ValidCurrencyKey(k) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	if len(keys) > MaxCurrencies {
		keys = keys[:MaxCurrencies]
	}
	for _, k := range keys {
		out[k] = max(c[k], 0)
	}
	return out
}
