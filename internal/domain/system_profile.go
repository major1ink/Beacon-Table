package domain

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"beacon-table/internal/formula"
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

// SystemRolls — броски системы, которые ядро делает само. Check — куб
// проверки: голый модификатор в тексте карточки («+4») бросается как
// Check + модификатор («1d20+4»); пустая строка — голый модификатор не
// бросается.
type SystemRolls struct {
	Check string `json:"check"`
}

// SystemProfile — то, что клиенту нужно знать о системе мира, чтобы
// показать вес и деньги и бросать кубы (см. GET /api/system).
// Initiative — правило броска инициативы: клиент по нему показывает
// инициативу карточки.
type SystemProfile struct {
	ID         string         `json:"id"`
	Title      string         `json:"title"`
	Units      SystemUnits    `json:"units"`
	Currencies []Currency     `json:"currencies"`
	Rolls      SystemRolls    `json:"rolls"`
	Initiative InitiativeRule `json:"initiative"`
	// TokenSize — размер токена существа по его карточке; nil — 1×1.
	TokenSize *TokenSizeRule `json:"tokenSize,omitempty"`
	// Modules — модули мира, которые есть на сервере, в порядке подключения:
	// по ним клиент строит корни компендиума и подписывает карточки.
	Modules []WorldModule `json:"modules"`
}

// WorldModule — модуль, подключённый к миру.
type WorldModule struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Type  string `json:"type"`
}

// CustomUnits / CustomCurrencies — умолчания «Своей системы» и мира, чья
// система своих единиц и валют не задаёт.
func CustomUnits() SystemUnits { return SystemUnits{Weight: "кг"} }

func CustomCurrencies() []Currency {
	return []Currency{{Key: "money", Label: "Деньги"}}
}

// CustomRolls — броски «Своей системы» и системы без раздела rolls:
// проверка — 1d20.
func CustomRolls() SystemRolls { return SystemRolls{Check: "1d20"} }

// ValidateRolls — броски из module.json: куб проверки — формула из одних
// кубов и чисел без ссылок («1d20», «2d6», «1d20+1»), хотя бы с одним
// кубом; пустая — голый модификатор не бросается.
func ValidateRolls(r *SystemRolls) error {
	r.Check = strings.TrimSpace(r.Check)
	if r.Check == "" {
		return nil
	}
	expr, err := formula.Parse(r.Check, true)
	if err != nil {
		return fmt.Errorf("куб проверки %q: %w", r.Check, err)
	}
	if len(expr.Refs()) > 0 {
		return fmt.Errorf("куб проверки %q: ссылки на поля здесь не бывают", r.Check)
	}
	roll, err := expr.Dice(nil)
	if err != nil {
		return fmt.Errorf("куб проверки %q: %w", r.Check, err)
	}
	if roll.Dice == 0 {
		return fmt.Errorf("куб проверки %q: нет ни одного куба", r.Check)
	}
	return nil
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

// MaxTokenCells — предел стороны токена в клетках: самые крупные существа
// занимают 4×4, остальное — запас.
const MaxTokenCells = 10

const maxTokenSizes = 64

// TokenSizeRule — сторона токена существа в клетках по значению поля Field
// его карточки («Большой» → 2). Значения ищутся без учёта регистра.
type TokenSizeRule struct {
	Field string             `json:"field"`
	Table map[string]float64 `json:"table"`
}

// CellsFor — сторона токена существа src в клетках; без правила или без
// значения в таблице — 1.
func (r *TokenSizeRule) CellsFor(src any) float64 {
	if r == nil {
		return 1
	}
	v, ok := lookupField(fieldsOf(src), r.Field)
	if !ok {
		return 1
	}
	want := strings.TrimSpace(scalarString(v))
	for k, cells := range r.Table {
		if strings.EqualFold(strings.TrimSpace(k), want) {
			return cells
		}
	}
	return 1
}

// ValidateTokenSize — раздел tokenSize из module.json: поле, непустая
// таблица, стороны кратны половине клетки и не больше MaxTokenCells.
func ValidateTokenSize(r *TokenSizeRule) error {
	if !fieldPathRe.MatchString(r.Field) {
		return fmt.Errorf("размер токена: неверное поле %q", r.Field)
	}
	if len(r.Table) == 0 || len(r.Table) > maxTokenSizes {
		return fmt.Errorf("размер токена: в таблице нужно от 1 до %d значений", maxTokenSizes)
	}
	for k, cells := range r.Table {
		if strings.TrimSpace(k) == "" {
			return fmt.Errorf("размер токена: пустое значение поля в таблице")
		}
		if cells < 0.5 || cells > MaxTokenCells || cells*2 != float64(int(cells*2)) {
			return fmt.Errorf("размер токена %q: %v клеток — нужно от 0.5 до %d с шагом 0.5", k, cells, MaxTokenCells)
		}
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
