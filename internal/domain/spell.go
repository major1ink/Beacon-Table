package domain

import "time"

// Spell — карточка библиотеки заклинаний, общей на весь стол (её видят и
// правят и ДМ, и игроки — в отличие от Monster, у которого бестиарий
// инструмент только ДМ). Хранится файлом на диске, один JSON на заклинание
// (см. internal/repository/spellfile) — та же идея, что и у Monster/Note.
//
// Тот же "умный бланк", что и у Monster (см. monster.go): сервер не знает
// правил D&D — не считает СЛ спасброска, не проверяет доступность школ по
// классам, не парсит формулы урона. Единственный неочевидный момент —
// заполняется это чаще всего не руками, а импортом одного JSON-файла
// экспорта заклинания с https://5e14.ttg.club (кнопка "Экспортировать в
// FvTT" отдаёт файл в формате Foundry VTT dnd5e — тот же формат, что и у
// экспорта существ, которым пользуется TTG Club). Разбор этого формата и
// перевод в поля Spell — целиком на клиенте (web/src/spell-import.js), это
// просто перевод чужого формата данных в наш, а не игровое правило —
// сервер как обычно ничего об этом не знает и получает уже готовый Spell.
//
// Компоненты/спасбросок/урон — свободный текст (Verbal/Somatic/Material —
// исключение, три чекбокса нужны, чтобы отличать заговоры с материальным
// компонентом при фильтрации/отображении), как и в реальных карточках
// заклинаний бывают трудноформализуемые формулировки ("см. описание",
// "особая" длительность и т.п.) — те же соображения, что и у Monster.
type Spell struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// System — true для карточек каталога "из коробки", зашитого в бинарник
	// на этапе компиляции (см. internal/repository/spellfile.SystemStore) —
	// проставляется сервером при чтении, клиентское значение в Create/Update
	// игнорируется (см. spellfile.Catalog). Такие карточки нельзя
	// редактировать/удалять — только клонировать в общую библиотеку (см.
	// web/src/pages/spellbook.js).
	System bool   `json:"system,omitempty"`
	Source string `json:"source,omitempty"` // "PHB'24", "MHH"...

	Level  int    `json:"level"`            // 0-9, 0 = заговор
	School string `json:"school,omitempty"` // "Прорицание" и т.п. — свободный текст

	CastTime      string `json:"castTime,omitempty"` // "1 действие", "1 час", "Реакция, когда..."
	Ritual        bool   `json:"ritual"`
	Range         string `json:"range,omitempty"` // "120 фт.", "Касание", "На себя (конус 15 фт.)"
	Verbal        bool   `json:"verbal"`
	Somatic       bool   `json:"somatic"`
	Material      bool   `json:"material"`
	MaterialNote  string `json:"materialNote,omitempty"` // "жемчужина стоимостью не менее 100 зм..."
	Duration      string `json:"duration,omitempty"`     // "Мгновенная", "1 минута", "Пока не рассеяно"
	Concentration bool   `json:"concentration"`

	SavingThrow string `json:"savingThrow,omitempty"` // "Тел", "Мдр"... — свободный текст, СЛ никто не считает на сервере
	Damage      string `json:"damage,omitempty"`      // "8к6 (огонь)"
	Classes     string `json:"classes,omitempty"`     // "Волшебник, Чародей..." — свободный текст, экспорт TTG Club это не отдаёт

	Description string   `json:"description,omitempty"` // markdown/HTML — рендерится тем же marked, что и заметки ДМ (см. web/src/notes/markdown.js); из импорта приходит готовый HTML, marked пропускает его как есть
	Tags        []string `json:"tags,omitempty"`

	UpdatedAt time.Time `json:"updatedAt"`
}

// NewSpell создаёт пустую карточку заклинания с разумными дефолтами — как и
// NewMonster/DefaultCharacterSheet, готова сразу отдаваться на редактирование
// (или на импорт поверх себя, см. web/src/spell-import.js).
func NewSpell(id, name string) *Spell {
	return &Spell{ID: id, Name: name}
}
