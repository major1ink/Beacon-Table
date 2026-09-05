package domain

// sharing.go — общая механика «у объекта есть автор и раздача прав».
//
// Появилась при заведении досок (см. Board): у доски ровно та же модель
// доступа, что у записи журнала — автор, уровень по умолчанию и точечные
// выдачи аккаунтам, — и вторая копия этих десяти строк разошлась бы с первой
// на первой же правке. Поэтому решение живёт здесь, а JournalEntry и Board
// только держат поля и зовут его.
//
// Тип уровня остался JournalAccess: он уже ездит в JSON API и лежит во
// frontmatter файлов журнала, переименование ради красоты сломало бы и то и
// другое. Читать его стоит как «уровень доступа к общему объекту стола», а
// не как что-то специфически журнальное.

// Sharing — владение и раздача прав. Встраивается анонимно, поэтому в JSON
// поля остаются на верхнем уровне объекта (и формат журнала не меняется).
type Sharing struct {
	// OwnerID — аккаунт автора; "" у объектов, заведённых ДМ (у admin-аккаунта
	// нет привязки к миру, см. Account.CompanyID — но по правам ему и так
	// доступно всё, отдельный id тут ничего не решает).
	OwnerID string `json:"ownerId,omitempty"`
	// OwnerName — имя автора на момент создания, для показа в списке
	// («кто это завёл»). Снимок, а не ссылка: аккаунт могут удалить, а объект
	// останется и должен остаться подписанным.
	OwnerName string `json:"ownerName,omitempty"`
	// Default — что достаётся всем, кому персонально ничего не выдано.
	// Именно это поле делает объект ОБЩИМ: Default >= JournalObserver — его
	// читает весь стол (см. IsShared).
	Default JournalAccess `json:"default"`
	// Access — точечные выдачи: accountID -> уровень. Всегда непустая при
	// сериализации в JSON (пустая map, а не null — клиенту проще).
	Access map[string]JournalAccess `json:"access"`
}

// AccessFor — эффективный уровень доступа viewer'а.
func (s *Sharing) AccessFor(v JournalViewer) JournalAccess {
	if v.IsDM {
		return JournalOwner
	}
	if v.ID != "" && v.ID == s.OwnerID {
		return JournalOwner
	}
	level := s.Default
	if v.ID != "" {
		if personal, ok := s.Access[v.ID]; ok && personal.AtLeast(level) {
			level = personal
		}
	}
	return level
}

// CanSee — попадает ли объект в список этого viewer'а (>= JournalLimited).
func (s *Sharing) CanSee(v JournalViewer) bool { return s.AccessFor(v).AtLeast(JournalLimited) }

// CanRead — видно ли содержимое (>= JournalObserver).
func (s *Sharing) CanRead(v JournalViewer) bool { return s.AccessFor(v).AtLeast(JournalObserver) }

// CanEdit — можно ли править содержимое (>= JournalOwner).
func (s *Sharing) CanEdit(v JournalViewer) bool { return s.AccessFor(v).AtLeast(JournalOwner) }

// CanManage — можно ли раздавать права, переименовывать и удалять: только
// автор и ДМ, даже если кому-то выдан JournalOwner. «Дал поправить» не
// значит «дал раздавать ключи».
func (s *Sharing) CanManage(v JournalViewer) bool {
	return v.IsDM || (v.ID != "" && v.ID == s.OwnerID)
}

// IsShared — объект открыт всему столу по умолчанию, без персональных выдач.
// Именно так сделан «общий» журнал и общая доска — не отдельным хранилищем, а
// уровнем доступа по умолчанию, ровно как в Foundry.
func (s *Sharing) IsShared() bool { return s.Default.AtLeast(JournalObserver) }
