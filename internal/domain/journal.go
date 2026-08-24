package domain

import "time"

// JournalEntry — запись журнала стола: тот же markdown, что и у заметок ДМ
// (domain.Note, см. internal/repository/notefile), но с автором и правами
// доступа — журнал общий на весь стол, а заметки ДМ его личные.
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
	// OwnerID — аккаунт автора; "" у записей, заведённых ДМ (у admin-аккаунта
	// нет привязки к миру, см. Account.CompanyID — но по правам ему и так
	// доступно всё, отдельный id тут ничего не решает).
	OwnerID string `json:"ownerId,omitempty"`
	// OwnerName — имя автора на момент создания, для показа в списке
	// («кто это написал»). Снимок, а не ссылка: аккаунт могут удалить, а
	// запись в журнале останется и должна остаться подписанной.
	OwnerName string `json:"ownerName,omitempty"`
	// Default — что достаётся всем, кому персонально ничего не выдано.
	// Именно это поле делает запись частью ОБЩЕГО журнала: Default >=
	// JournalObserver — её читает весь стол (см. JournalEntry.IsShared).
	Default JournalAccess `json:"default"`
	// Access — точечные выдачи: accountID -> уровень. Всегда непустой при
	// сериализации в JSON (пустая map, а не null — клиенту проще).
	Access    map[string]JournalAccess `json:"access"`
	UpdatedAt time.Time                `json:"updatedAt"`
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

// AccessFor — эффективный уровень доступа viewer'а к этой записи.
func (e *JournalEntry) AccessFor(v JournalViewer) JournalAccess {
	if v.IsDM {
		return JournalOwner
	}
	if v.ID != "" && v.ID == e.OwnerID {
		return JournalOwner
	}
	level := e.Default
	if v.ID != "" {
		if personal, ok := e.Access[v.ID]; ok && personal.AtLeast(level) {
			level = personal
		}
	}
	return level
}

// CanSee — попадает ли запись в список этого viewer'а (>= JournalLimited).
func (e *JournalEntry) CanSee(v JournalViewer) bool {
	return e.AccessFor(v).AtLeast(JournalLimited)
}

// CanRead — виден ли текст записи (>= JournalObserver).
func (e *JournalEntry) CanRead(v JournalViewer) bool {
	return e.AccessFor(v).AtLeast(JournalObserver)
}

// CanEdit — можно ли править текст (>= JournalOwner).
func (e *JournalEntry) CanEdit(v JournalViewer) bool {
	return e.AccessFor(v).AtLeast(JournalOwner)
}

// CanManage — можно ли раздавать права, переносить и удалять запись: только
// автор и ДМ, даже если кому-то выдан JournalOwner (см. его комментарий).
func (e *JournalEntry) CanManage(v JournalViewer) bool {
	return v.IsDM || (v.ID != "" && v.ID == e.OwnerID)
}

// IsShared — запись «общего журнала»: её текст по умолчанию открыт всему
// столу, без персональных выдач (см. Default). Именно так сделан общий
// журнал — не отдельным хранилищем, а уровнем доступа по умолчанию, ровно
// как в Foundry.
func (e *JournalEntry) IsShared() bool {
	return e.Default.AtLeast(JournalObserver)
}
