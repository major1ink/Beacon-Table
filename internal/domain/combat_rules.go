package domain

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// CombatRules — правила боя игровой системы: как бросается инициатива, что
// происходит с бойцом на 0 хитов и откуда берётся опыт за существо. Ядро
// само ни одного правила не знает — их задаёт системный модуль (раздел
// "combat" в module.json), а у «Своей системы» — CustomCombatRules.
//
// Намеренно без языка формул: только выбор из фиксированных вариантов и
// ссылки на поля листа или карточки. Формулы — задача «Схемы листа и
// карточек».
type CombatRules struct {
	Initiative InitiativeRule `json:"initiative"`
	ZeroHP     ZeroHPRule     `json:"zeroHp"`
	XP         XPRule         `json:"xp,omitempty"`
}

// InitiativeRule — бросок инициативы при добавлении бойца.
//
// Формула броска — значение поля RollField листа персонажа или карточки
// существа (строка с кубами, "1d20+2"), а если поля нет или оно пустое —
// Roll. Пустая формула — ручной ввод: боец встаёт с инициативой 0, ДМ
// вписывает число в трекере. К формуле прибавляется Bonus и модификаторы
// инициативы от висящих состояний.
type InitiativeRule struct {
	Roll      string `json:"roll,omitempty"`
	RollField string `json:"rollField,omitempty"`
	// Bonus — откуда прибавка: "abilityMod:<ключ>" — floor((x−10)/2) от
	// abilities.<ключ>; "field:<путь>" — число из поля; "" или "none" — нет.
	Bonus string `json:"bonus,omitempty"`
}

// Что происходит с бойцом, когда его хиты опустились до нуля.
const (
	// ZeroHPDead — умирает сразу: токен становится костями, боец уходит из
	// трекера, у существа снимаются лут и опыт.
	ZeroHPDead = "dead"
	// ZeroHPOut — «выбыл»: на токен вешается состояние ZeroHPOutStatus,
	// боец остаётся в трекере; лечение выше нуля это состояние снимает.
	ZeroHPOut = "out"
	// ZeroHPDeathSaves — счётчик успехов и провалов (DeathSavesRule), ДМ
	// отмечает их в трекере.
	ZeroHPDeathSaves = "deathSaves"
	// ZeroHPNone — ничего автоматически, решает ДМ.
	ZeroHPNone = "none"
)

// ZeroHPOutStatus — состояние «выбывшего» бойца: slug базового набора
// «без сознания» (см. internal/module/base).
const ZeroHPOutStatus = "unconscious"

// ZeroHPRule — поведение на 0 хитов отдельно для игровых персонажей и для
// всех остальных (существа, безликие NPC-токены).
type ZeroHPRule struct {
	Character  string          `json:"character"`
	Other      string          `json:"other"`
	DeathSaves *DeathSavesRule `json:"deathSaves,omitempty"`
}

// DeathSavesRule — счётчик на 0 хитов: Success успехов — боец приходит в
// себя с StabilizeHP хитами, Fail провалов — умирает.
type DeathSavesRule struct {
	Success     int `json:"success"`
	Fail        int `json:"fail"`
	StabilizeHP int `json:"stabilizeHp"`
}

// XPRule — опыт за существо: значение поля Field его карточки. С таблицей
// Table значение ищется в ней (уровень опасности → опыт), без неё берётся
// как число. Пустой Field — опыт не считается.
type XPRule struct {
	Field string         `json:"field,omitempty"`
	Table map[string]int `json:"table,omitempty"`
}

// maxDeathSaves — потолок счётчика: лампочки в трекере должны помещаться.
const maxDeathSaves = 10

// CustomCombatRules — правила «Своей системы» и любого мира, чья система не
// задаёт своих: инициатива из поля "initiative" листа или карточки (иначе
// вручную), персонаж на 0 хитов выбывает, существо умирает, опыт — число
// "xp" на карточке.
func CustomCombatRules() *CombatRules {
	return &CombatRules{
		Initiative: InitiativeRule{RollField: "initiative"},
		ZeroHP:     ZeroHPRule{Character: ZeroHPOut, Other: ZeroHPDead},
		XP:         XPRule{Field: "xp"},
	}
}

// ZeroHPFor — поведение на 0 хитов для бойца: персонажа или остальных.
func (r *CombatRules) ZeroHPFor(isCharacter bool) string {
	if isCharacter {
		return r.ZeroHP.Character
	}
	return r.ZeroHP.Other
}

var (
	rollFormulaRe = regexp.MustCompile(`^[0-9dк+\- ]{1,40}$`)
	fieldPathRe   = regexp.MustCompile(`^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$`)
)

// Validate — правила, с которыми можно подключить модуль.
func (r *CombatRules) Validate() error {
	in := r.Initiative
	if in.Roll != "" && !rollFormulaRe.MatchString(strings.ToLower(in.Roll)) {
		return fmt.Errorf("инициатива: формула %q — только кубы, числа, + и -", in.Roll)
	}
	if in.RollField != "" && !fieldPathRe.MatchString(in.RollField) {
		return fmt.Errorf("инициатива: неверное поле %q", in.RollField)
	}
	if _, _, err := parseBonus(in.Bonus); err != nil {
		return err
	}
	usesSaves := false
	for _, v := range []string{r.ZeroHP.Character, r.ZeroHP.Other} {
		switch v {
		case ZeroHPDead, ZeroHPOut, ZeroHPNone:
		case ZeroHPDeathSaves:
			usesSaves = true
		default:
			return fmt.Errorf("0 хитов: %q — нужно %q, %q, %q или %q", v, ZeroHPDead, ZeroHPOut, ZeroHPDeathSaves, ZeroHPNone)
		}
	}
	if usesSaves {
		ds := r.ZeroHP.DeathSaves
		if ds == nil {
			return fmt.Errorf("0 хитов: для %q нужен раздел deathSaves", ZeroHPDeathSaves)
		}
		if ds.Success < 1 || ds.Success > maxDeathSaves || ds.Fail < 1 || ds.Fail > maxDeathSaves {
			return fmt.Errorf("0 хитов: успехов и провалов — от 1 до %d", maxDeathSaves)
		}
		if ds.StabilizeHP < 0 {
			return fmt.Errorf("0 хитов: stabilizeHp не может быть отрицательным")
		}
	}
	if r.XP.Field != "" && !fieldPathRe.MatchString(r.XP.Field) {
		return fmt.Errorf("опыт: неверное поле %q", r.XP.Field)
	}
	for k, v := range r.XP.Table {
		if v < 0 {
			return fmt.Errorf("опыт: отрицательное значение для %q", k)
		}
	}
	return nil
}

// parseBonus разбирает InitiativeRule.Bonus: вид ("abilityMod", "field" или
// "") и путь к полю.
func parseBonus(bonus string) (kind, path string, err error) {
	if bonus == "" || bonus == "none" {
		return "", "", nil
	}
	kind, path, ok := strings.Cut(bonus, ":")
	if !ok || (kind != "abilityMod" && kind != "field") || !fieldPathRe.MatchString(path) {
		return "", "", fmt.Errorf("инициатива: прибавка %q — нужно abilityMod:<ключ>, field:<поле> или none", bonus)
	}
	if kind == "abilityMod" {
		path = "abilities." + path
	}
	return kind, path, nil
}

// InitiativeFormula — формула броска инициативы для бойца, чей лист или
// карточка — src (любая структура, которая пишется в JSON; nil — голый
// токен). applyStatus — модификаторы инициативы от висящих состояний
// поверх прибавки из правил (nil — их нет). Пустая строка — ручной ввод.
func (r *CombatRules) InitiativeFormula(src any, applyStatus func(int) int) string {
	fields := fieldsOf(src)
	formula := r.Initiative.Roll
	if r.Initiative.RollField != "" {
		if v, ok := lookupField(fields, r.Initiative.RollField); ok {
			if s := strings.TrimSpace(scalarString(v)); s != "" {
				formula = strings.ReplaceAll(strings.ToLower(s), "к", "d")
			}
		}
	}
	if formula == "" {
		return ""
	}
	kind, path, _ := parseBonus(r.Initiative.Bonus)
	mod := 0
	switch kind {
	case "abilityMod":
		// Без листа или карточки — характеристика 10, прибавка 0.
		score := 10
		if v, ok := lookupField(fields, path); ok {
			if n, ok := scalarInt(v); ok {
				score = n
			}
		}
		mod = int(math.Floor(float64(score-10) / 2))
	case "field":
		if v, ok := lookupField(fields, path); ok {
			mod, _ = scalarInt(v)
		}
	}
	if applyStatus != nil {
		mod = applyStatus(mod)
	}
	if kind == "" && mod == 0 {
		return formula
	}
	return fmt.Sprintf("%s%+d", formula, mod)
}

// XPFor — опыт за существо с карточкой src. 0 — поле не задано, пустое или
// не нашлось в таблице.
func (r *CombatRules) XPFor(src any) int {
	if r.XP.Field == "" {
		return 0
	}
	v, ok := lookupField(fieldsOf(src), r.XP.Field)
	if !ok {
		return 0
	}
	if r.XP.Table != nil {
		return r.XP.Table[strings.TrimSpace(scalarString(v))]
	}
	n, _ := scalarInt(v)
	if n < 0 {
		return 0
	}
	return n
}

// fieldsOf — src в виде дерева JSON: правила ссылаются на поля по их
// JSON-именам, включая незнакомые ядру (Extra).
func fieldsOf(src any) map[string]any {
	if src == nil {
		return nil
	}
	data, err := json.Marshal(src)
	if err != nil {
		return nil
	}
	var out map[string]any
	if json.Unmarshal(data, &out) != nil {
		return nil
	}
	return out
}

// lookupField — значение по пути "a.b.c".
func lookupField(fields map[string]any, path string) (any, bool) {
	var cur any = fields
	for _, part := range strings.Split(path, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		if cur, ok = m[part]; !ok {
			return nil, false
		}
	}
	return cur, cur != nil
}

func scalarString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	}
	return ""
}

func scalarInt(v any) (int, bool) {
	switch x := v.(type) {
	case float64:
		return int(x), true
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(x))
		return n, err == nil
	}
	return 0, false
}
