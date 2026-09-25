// Package module — модули контента Beacon Table: пакеты с карточками
// (бестиарий, заклинания, предметы, справочник, состояния) и, у системных
// модулей, описанием игровой системы. Ядро программы не знает ни одной
// игровой системы — всё, что к ней относится, приходит модулем (см. задачу
// «Модули контента»).
//
// Модуль — только данные, без исполняемого кода: модули приходят из
// интернета, и JS из модуля выполнялся бы в браузере у игроков.
//
// Раскладка модуля (папка или .btmod = zip той же папки):
//
//	module.json
//	bestiary/<slug>.json   spells/…   items/…   references/…   conditions/…
//	assets/…               — картинки карточек, раздаются по /module-assets/<id>/
//
// Карточка — тот же JSON, что у карточки библиотеки мира, без "id" и
// "updatedAt": id проставляет сервер из имени файла (см. Module.IDPrefix).
package module

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Format — версия СТРУКТУРЫ пакета, которую понимает программа. Не путать с
// Manifest.Version — версией содержимого модуля.
const Format = "beacon-module/v1"

// Типы модулей.
const (
	// TypeSystem — игровая система: её выбирают при создании мира. Может
	// нести и карточки (D&D 5e приносит свой SRD-каталог).
	TypeSystem = "system"
	// TypeContent — дополнительный контент под одну или несколько систем.
	TypeContent = "content"
)

// Виды карточек — они же имена папок внутри модуля.
const (
	KindBestiary   = "bestiary"
	KindSpells     = "spells"
	KindItems      = "items"
	KindReferences = "references"
	KindConditions = "conditions"
)

// Kinds — все виды карточек, которые модуль может нести.
var Kinds = []string{KindBestiary, KindSpells, KindItems, KindReferences, KindConditions}

// LegacyIDPrefix — префикс id карточек каталога «из коробки» до модулей
// (sys-<имя файла>). Модули D&D, вынесенные из бинарника, объявляют
// "legacyIds": true и сохраняют его — ссылки на токенах, в инвентаре и
// лутах миров 0.8.x продолжают открывать те же карточки.
const LegacyIDPrefix = "sys-"

// idSeparator — между id модуля и slug'ом карточки: "srd-extra--goblin".
// В id модуля два дефиса подряд запрещены (см. validID), а id карточек
// библиотеки — 32 hex-символа, так что спутать не с чем.
const idSeparator = "--"

// Dependency — модуль, без которого этот не имеет смысла (контент под
// систему требует саму систему).
type Dependency struct {
	ID string `json:"id"`
	// MinVersion — не ниже какой версии нужна зависимость; пусто — любая.
	MinVersion string `json:"minVersion,omitempty"`
}

// Manifest — module.json.
type Manifest struct {
	Format  string `json:"format"`
	ID      string `json:"id"`
	Type    string `json:"type"`
	Title   string `json:"title"`
	Version string `json:"version"`
	// MinAppVersion — не ниже какой версии Beacon Table модуль работает.
	MinAppVersion string `json:"minAppVersion,omitempty"`
	// Systems — для каких игровых систем модуль (id системных модулей). У
	// системного модуля — обычно он сам.
	Systems     []string     `json:"systems,omitempty"`
	Requires    []Dependency `json:"requires,omitempty"`
	Description string       `json:"description,omitempty"`
	Author      string       `json:"author,omitempty"`
	License     string       `json:"license,omitempty"`
	// LegacyIDs — id карточек в старом формате sys-<slug> (см.
	// LegacyIDPrefix). Только для модулей, заменяющих встроенный каталог.
	LegacyIDs bool `json:"legacyIds,omitempty"`
	// Theme — оформление системы (CSS-переменные, шрифты). Формат задаёт
	// задача «Оформление игровых систем»; здесь хранится как есть.
	Theme json.RawMessage `json:"theme,omitempty"`
}

var validID = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

// ParseManifest разбирает и проверяет module.json.
func ParseManifest(data []byte) (*Manifest, error) {
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("module.json не разбирается: %w", err)
	}
	if err := m.Validate(); err != nil {
		return nil, err
	}
	return &m, nil
}

// Validate — то, без чего модуль нельзя ни установить, ни подключить.
func (m *Manifest) Validate() error {
	if m.Format != Format {
		if m.Format == "" {
			return fmt.Errorf("в module.json нет \"format\" — это точно модуль Beacon Table?")
		}
		return fmt.Errorf("формат модуля %q не поддерживается (нужен %q) — обнови программу", m.Format, Format)
	}
	if !validID.MatchString(m.ID) || len(m.ID) > 64 || m.ID+"-" == LegacyIDPrefix {
		return fmt.Errorf("id модуля %q: только латиница в нижнем регистре, цифры и одиночные дефисы, до 64 символов", m.ID)
	}
	if m.Type != TypeSystem && m.Type != TypeContent {
		return fmt.Errorf("тип модуля %q: нужен %q или %q", m.Type, TypeSystem, TypeContent)
	}
	if strings.TrimSpace(m.Title) == "" {
		return fmt.Errorf("у модуля %s нет названия (title)", m.ID)
	}
	if _, err := ParseVersion(m.Version); err != nil {
		return fmt.Errorf("версия модуля %s: %w", m.ID, err)
	}
	if m.MinAppVersion != "" {
		if _, err := ParseVersion(m.MinAppVersion); err != nil {
			return fmt.Errorf("minAppVersion модуля %s: %w", m.ID, err)
		}
	}
	for _, d := range m.Requires {
		if !validID.MatchString(d.ID) {
			return fmt.Errorf("зависимость модуля %s: неверный id %q", m.ID, d.ID)
		}
		if d.MinVersion != "" {
			if _, err := ParseVersion(d.MinVersion); err != nil {
				return fmt.Errorf("зависимость %s модуля %s: %w", d.ID, m.ID, err)
			}
		}
	}
	return nil
}

// IDPrefix — префикс id карточек этого модуля.
func (m *Manifest) IDPrefix() string {
	if m.LegacyIDs {
		return LegacyIDPrefix
	}
	return m.ID + idSeparator
}

// Version — semver без пререлизов: major.minor.patch.
type Version [3]int

// ParseVersion принимает "1.2.3" (и "v1.2.3"); суффикс после "-" или "+"
// (1.2.3-beta, 0.8.6+dirty) отбрасывается — сравниваем только числа.
func ParseVersion(s string) (Version, error) {
	s = strings.TrimPrefix(strings.TrimSpace(s), "v")
	if i := strings.IndexAny(s, "-+"); i >= 0 {
		s = s[:i]
	}
	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return Version{}, fmt.Errorf("%q — не версия вида 1.2.3", s)
	}
	var v Version
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return Version{}, fmt.Errorf("%q — не версия вида 1.2.3", s)
		}
		v[i] = n
	}
	return v, nil
}

// Less — v раньше other.
func (v Version) Less(other Version) bool {
	for i := range v {
		if v[i] != other[i] {
			return v[i] < other[i]
		}
	}
	return false
}

func (v Version) String() string { return fmt.Sprintf("%d.%d.%d", v[0], v[1], v[2]) }
