package foundry

import (
	"regexp"
	"strings"
)

// Инлайн-броски Foundry. В тексте модуля бросок пишется вторым видом
// макроса-обогатителя (первый — ссылки, см. links.go):
//
//	[[/r 2d6 + 3]]{урон}      — обычный бросок
//	[[2d6]]                   — то же без команды
//	[[/save dex 15]]          — спасбросок (dnd5e)
//	[[/check ability=str dc=10]], [[/skill acr 15]], [[/damage 2d6 fire]]
//
// Вне Foundry это опять же мусор в абзаце. Переводим в обычный текст: формулу
// оставляем формулой ("2d6 + 3"), потому что клиент уже умеет делать любую
// формулу в прозе кликабельной (см. web/src/inline-rolls.js: enhanceRolls —
// тот же механизм, что для статблоков с TTG Club), а проверки и спасброски —
// в человеческую фразу («спасбросок Ловкости (СЛ 15)»).
//
// Чего этот перевод НЕ делает: не считает и не кидает ничего сам и не
// пытается разобрать ссылки на данные актёра внутри формулы
// ("2d6 + @abilities.str.mod") — такая формула остаётся текстом как есть,
// кликабельной станет только её кубиковая часть.

// inlineRollRe — [[…]] с необязательной подписью {…}. Внутри скобок Foundry
// допускает почти что угодно, кроме самой "]" — с одним исключением:
// "/item Название [English Name] activity=..." (кнопка «применить действие
// предмета») может нести ОДНУ пару вложенных [...] в самом названии — в этом
// контенте это обычная практика: карточки называют "Русское [Original]".
// Без учёта вложенности такой макрос не матчился вовсе (жадный [^\]]+
// упирался в "]" из "[Cunning Strike]" раньше двух заключающих "]]") и
// оставался в тексте как есть. Разрешаем содержимому быть чередованием
// "не-скобочных символов" и одной ЦЕЛОЙ пары "[...]" — больше одного уровня
// вложенности Foundry в этом макросе не создаёт.
var inlineRollRe = regexp.MustCompile(`\[\[((?:[^\[\]]|\[[^\[\]]*\])+)\]\](?:\{([^}]*)\})?`)

// referenceRe — &Reference[condition=prone]{Prone} из dnd5e v3+: ссылка на
// правило в самой системе, переносить нечего — оставляем подпись. В тексте
// журнала амперсанд обычно уже экранирован (&amp;Reference[…]) — принимаем
// оба вида.
var referenceRe = regexp.MustCompile(`(?:&|&amp;)Reference\[([^\]]*)\](?:\{([^}]*)\})?`)

// abilityNames/skillNames — те же сокращения и названия, что и в остальном
// приложении (см. web/src/monster-import.js: «Тел +4, Мдр +2»). Именительный
// падеж: фраза собирается через двоеточие («спасбросок: Тел (СЛ 15)»), и
// склонять ничего не приходится — в англоязычном тексте модуля любая
// падежная форма всё равно выглядела бы случайной.
var abilityNames = map[string]string{
	"str": "Сил", "dex": "Лов", "con": "Тел",
	"int": "Инт", "wis": "Мдр", "cha": "Хар",
}

var skillNames = map[string]string{
	"acr": "Акробатика", "ani": "Уход за животными", "arc": "Магия", "ath": "Атлетика",
	"dec": "Обман", "his": "История", "ins": "Проницательность", "itm": "Запугивание",
	"inv": "Анализ", "med": "Медицина", "nat": "Природа", "prc": "Восприятие",
	"prf": "Выступление", "per": "Убеждение", "rel": "Религия", "slt": "Ловкость рук",
	"ste": "Скрытность", "sur": "Выживание",
}

var damageTypeNames = map[string]string{
	"acid": "кислота", "bludgeoning": "дробящий", "cold": "холод", "fire": "огонь",
	"force": "силовое поле", "lightning": "электричество", "necrotic": "некротический",
	"piercing": "колющий", "poison": "яд", "psychic": "психический", "radiant": "излучение",
	"slashing": "рубящий", "thunder": "звук", "healing": "лечение", "temphp": "временные хиты",
}

// RewriteRolls переводит все инлайн-броски и &Reference в тексте.
func RewriteRolls(text string) string {
	if !strings.Contains(text, "[[") && !strings.Contains(text, "Reference[") {
		return text
	}
	out := replaceWithTail(text, inlineRollRe, func(parts []string, tail string) string {
		return rewriteRoll(parts[1], strings.TrimSpace(parts[2]), tail)
	})
	return referenceRe.ReplaceAllStringFunc(out, func(match string) string {
		parts := referenceRe.FindStringSubmatch(match)
		if parts == nil {
			return match
		}
		if label := strings.TrimSpace(parts[2]); label != "" {
			return label
		}
		// &Reference[condition=prone] без подписи — берём значение параметра.
		_, values := parseRollArgs(parts[1])
		if len(values) > 0 {
			return values[len(values)-1]
		}
		return ""
	})
}

// replaceWithTail — как ReplaceAllStringFunc, но замена видит ещё и текст
// ПОСЛЕ совпадения. Нужен ровно для одного: модули пишут и «на [[/save dex
// 15]]», и «на [[/save dex 15]] saving throw» — во втором случае слово
// «спасбросок» в нашей фразе было бы вторым подряд (см. savePhrase).
func replaceWithTail(text string, re *regexp.Regexp, fn func(parts []string, tail string) string) string {
	matches := re.FindAllStringSubmatchIndex(text, -1)
	if len(matches) == 0 {
		return text
	}
	var b strings.Builder
	last := 0
	for _, m := range matches {
		parts := make([]string, len(m)/2)
		for i := range parts {
			if m[2*i] >= 0 {
				parts[i] = text[m[2*i]:m[2*i+1]]
			}
		}
		b.WriteString(text[last:m[0]])
		b.WriteString(fn(parts, tailAfter(text, m[1])))
		last = m[1]
	}
	b.WriteString(text[last:])
	return b.String()
}

// tailContextLen — сколько символов после макроса смотрим в поисках «saving
// throw»/«check». Хватает пары слов; дальше уже другое предложение.
const tailContextLen = 48

var tagRe = regexp.MustCompile(`<[^>]*>`)

// tailAfter — текст сразу после макроса, очищенный от тегов и приведённый к
// нижнему регистру.
func tailAfter(text string, from int) string {
	end := from + tailContextLen
	if end > len(text) {
		end = len(text)
	}
	tail := tagRe.ReplaceAllString(text[from:end], " ")
	tail = strings.ReplaceAll(tail, "&nbsp;", " ")
	return strings.ToLower(strings.TrimSpace(tail))
}

// alreadySays — текст после макроса уже называет бросок сам («… saving
// throw», «… проверку»), и повторять это в фразе не нужно.
func alreadySays(tail string, words ...string) bool {
	for _, w := range words {
		if strings.HasPrefix(tail, w) {
			return true
		}
	}
	return false
}

// rewriteRoll — один макрос: содержимое скобок, подпись и текст после него.
func rewriteRoll(inner, label, tail string) string {
	inner = strings.TrimSpace(inner)
	if inner == "" {
		return label
	}
	if !strings.HasPrefix(inner, "/") {
		// [[2d6+3]] — отложенный бросок без команды.
		return withLabel(cleanFormula(inner), label)
	}
	command, rest := splitCommand(inner)
	keys, values := parseRollArgs(rest)

	switch command {
	case "r", "roll", "gmr", "gmroll", "br", "blindroll", "sr", "selfroll", "pr", "publicroll":
		return withLabel(cleanFormula(rest), label)
	case "damage", "dmg":
		return damagePhrase(keys, values, label)
	case "heal", "healing":
		return damagePhrase(keys, values, label)
	case "save", "concentration":
		return savePhrase(command, keys, values, label, tail)
	case "check", "skill", "tool":
		return checkPhrase(keys, values, label, tail)
	case "attack":
		return withLabel(cleanFormula(rest), label)
	default:
		// Незнакомая команда (/item, /lookup и прочие вызовы механики
		// Foundry): показываем подпись, если она есть, иначе ничего — макрос
		// в тексте бесполезен в любом случае.
		return label
	}
}

// splitCommand — "/save dex 15" → ("save", "dex 15").
func splitCommand(inner string) (command, rest string) {
	inner = strings.TrimPrefix(inner, "/")
	if space := strings.IndexAny(inner, " \t"); space != -1 {
		return strings.ToLower(inner[:space]), strings.TrimSpace(inner[space+1:])
	}
	return strings.ToLower(inner), ""
}

// parseRollArgs разбирает аргументы обогатителя: и позиционные ("dex 15"), и
// именованные ("ability=dex dc=15") — dnd5e принимает оба вида вперемешку.
// keys — только именованные, values — все значения по порядку.
func parseRollArgs(rest string) (keys map[string]string, values []string) {
	keys = map[string]string{}
	for _, token := range strings.Fields(rest) {
		if eq := strings.Index(token, "="); eq > 0 {
			key := strings.ToLower(token[:eq])
			value := strings.Trim(token[eq+1:], `"'`)
			keys[key] = value
			values = append(values, value)
			continue
		}
		values = append(values, token)
	}
	return keys, values
}

// cleanFormula — формула броска без флейвора после "#" и без служебных
// опций Foundry.
func cleanFormula(rest string) string {
	if hash := strings.Index(rest, "#"); hash != -1 {
		rest = rest[:hash]
	}
	return strings.Join(strings.Fields(rest), " ")
}

// withLabel — формула плюс подпись, если Foundry её задавал: подпись обычно
// объясняет, что за бросок («урон», «к попаданию»), а сама формула нужна
// текстом, чтобы клиент сделал её кликабельной.
func withLabel(formula, label string) string {
	switch {
	case formula == "":
		return label
	case label == "":
		return formula
	default:
		return label + " (" + formula + ")"
	}
}

// savePhrase — «спасбросок: Тел (СЛ 15)» / «спасбросок: концентрация (СЛ 10)».
// Если сразу после макроса модуль и так пишет «saving throw», слово
// «спасбросок» опускаем — останется «Тел (СЛ 15) saving throw».
func savePhrase(command string, keys map[string]string, values []string, label, tail string) string {
	if label != "" {
		return label
	}
	what := "концентрация"
	if command == "save" {
		ability := firstArg(keys, values, "ability", func(v string) bool { _, ok := abilityNames[strings.ToLower(v)]; return ok })
		what = abilityNames[strings.ToLower(ability)]
		if what == "" {
			what = ability
		}
	}
	prefix := "спасбросок: "
	if alreadySays(tail, "save", "saving throw", "спасбросок", "спасброс") {
		prefix = ""
	}
	return withDC(prefix+what, firstArg(keys, values, "dc", isNumber))
}

// checkPhrase — «проверка: Скрытность (СЛ 15)»; если навык не указан, идёт
// характеристика. Слово «проверка» так же опускается, когда оно уже есть в
// тексте модуля следом.
func checkPhrase(keys map[string]string, values []string, label, tail string) string {
	if label != "" {
		return label
	}
	skill := firstArg(keys, values, "skill", func(v string) bool { _, ok := skillNames[strings.ToLower(v)]; return ok })
	what := skillNames[strings.ToLower(skill)]
	if what == "" {
		ability := firstArg(keys, values, "ability", func(v string) bool { _, ok := abilityNames[strings.ToLower(v)]; return ok })
		what = abilityNames[strings.ToLower(ability)]
		if what == "" {
			what = strings.TrimSpace(skill + " " + ability)
		}
	}
	prefix := "проверка: "
	if alreadySays(tail, "check", "проверк") {
		prefix = ""
	}
	return withDC(prefix+strings.TrimSpace(what), firstArg(keys, values, "dc", isNumber))
}

func withDC(phrase, dc string) string {
	phrase = strings.TrimSpace(phrase)
	if dc == "" {
		return phrase
	}
	return phrase + " (СЛ " + dc + ")"
}

// damagePhrase — «2d6 (огонь)»: формула остаётся формулой (её сделает
// кликабельной клиент), тип урона — подписью рядом.
func damagePhrase(keys map[string]string, values []string, label string) string {
	formula := keys["formula"]
	var types []string
	for _, v := range values {
		lowered := strings.ToLower(v)
		if name, ok := damageTypeNames[lowered]; ok {
			types = append(types, name)
			continue
		}
		if keys["type"] == v || keys["formula"] == v {
			continue // именованный аргумент уже учтён
		}
		if formula == "" && strings.ContainsAny(v, "dк0123456789") {
			formula = v
		}
	}
	if formula == "" {
		return label
	}
	text := formula
	if len(types) > 0 {
		text += " (" + strings.Join(types, ", ") + ")"
	}
	return withLabel(text, label)
}

// firstArg — значение аргумента: сначала по имени, потом первое позиционное,
// подходящее под ok().
func firstArg(keys map[string]string, values []string, name string, ok func(string) bool) string {
	if v, found := keys[name]; found {
		return v
	}
	for _, v := range values {
		if strings.Contains(v, "=") {
			continue
		}
		if ok(v) {
			return v
		}
	}
	return ""
}

func isNumber(v string) bool {
	if v == "" {
		return false
	}
	for _, r := range v {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
