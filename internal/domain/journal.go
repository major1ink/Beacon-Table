package domain

import "time"

// JournalEntry — запись журнала стола: markdown-файл (см.
// internal/repository/journalfile) с автором и правами доступа. Журнал общий
// на весь стол; запись, видимая только автору, — это его личная вика.
//
// Модель прав — фаундривская (JournalEntry.ownership в Foundry VTT): у
// записи есть уровень «по умолчанию» (Default — для всех, кому персонально
// ничего не выдано) и точечные выдачи конкретным аккаунтам (Access). ДМ
// видит и правит всё, автор — всегда владелец своей записи, остальным
// достаётся max(Default, Access[их id]).
//
// ID стабильный (service.newID() один раз при создании), Title выводится из
// первой строки "# Заголовок" внутри Content — ровно как у Note: так
// переименование остаётся обычной правкой текста.
type JournalEntry struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Folder string `json:"folder,omitempty"`
	// Content — пусто в списке (List) и у того, кому досталось не больше
	// JournalLimited: «видит, что запись есть, но не её текст».
	Content string `json:"content,omitempty"`
	// Sharing — автор и раздача прав, общие с досками (см. domain/sharing.go).
	// Встроен анонимно: в JSON поля остаются там же, где были (ownerId,
	// ownerName, default, access), и формат API с файлами не меняется.
	Sharing
	UpdatedAt time.Time `json:"updatedAt"`
}

// JournalAccess — уровень доступа к записи журнала. Строки, а не числа (как
// в Foundry): значения ездят в JSON API и лежат во frontmatter .md-файла
// (см. internal/repository/journalfile) — читаемость там дороже компактности.
type JournalAccess string

const (
	// JournalNone — записи для этого аккаунта как будто нет.
	JournalNone JournalAccess = "none"
	// JournalLimited — видит запись в списке (заголовок, автора), но не
	// текст. Фаундривский LIMITED.
	JournalLimited JournalAccess = "limited"
	// JournalObserver — читает текст, но не правит.
	JournalObserver JournalAccess = "observer"
	// JournalOwner — читает и правит текст. Права доступа и удаление —
	// всё равно только автору и ДМ (см. JournalEntry.CanManage): «дал
	// поправить» не значит «дал раздавать ключи».
	JournalOwner JournalAccess = "owner"
)

// journalAccessRank — порядок уровней для сравнений; неизвестное значение
// (ручная правка файла мимо приложения) читается как самое строгое.
func journalAccessRank(a JournalAccess) int {
	switch a {
	case JournalLimited:
		return 1
	case JournalObserver:
		return 2
	case JournalOwner:
		return 3
	default:
		return 0
	}
}

// AtLeast — «уровень a не ниже b».
func (a JournalAccess) AtLeast(b JournalAccess) bool {
	return journalAccessRank(a) >= journalAccessRank(b)
}

// Valid — известен ли уровень (валидация входа из API/файла).
func (a JournalAccess) Valid() bool {
	return a == JournalNone || a == JournalLimited || a == JournalObserver || a == JournalOwner
}

// JournalViewer — от чьего лица смотрим на запись. ID — аккаунт, IsDM —
// единственный admin-аккаунт стола (Account.IsAdmin), которому в журнале
// доступно всё, как GM в Foundry.
type JournalViewer struct {
	ID string
	// Name — имя аккаунта, попадает в OwnerName создаваемой им записи.
	Name string
	IsDM bool
}
