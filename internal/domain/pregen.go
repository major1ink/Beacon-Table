package domain

import "time"

// Pregen — предгенерированный («готовый») персонаж в пуле мира. Модули-
// приключения Foundry кладут таких актёров (type "character") внутрь пака
// Adventure и прямо предлагают их игрокам во вводном журнале. При импорте
// они собираются сюда, а не в бестиарий (см. foundry.TargetPregens).
//
// Пул + захват: пре-ген лежит свободным, пока игрок его не «возьмёт» (или
// ДМ не «назначит» аккаунту). Захват СОЗДАЁТ обычную запись domain.Character,
// принадлежащую игроку, — дальше это его персонаж, редактируется как любой
// другой. Сам пре-ген остаётся в пуле помеченным занятым (ClaimedBy/
// ClaimedCharacterID) — «вернуть в пул» снимает пометку, но персонажа игрока
// не трогает (он мог его уже поправить).
type Pregen struct {
	ID        string
	CompanyID string
	Name      string
	AvatarURL string
	Sheet     CharacterSheet
	// Source — id модуля Foundry, из которого пре-ген приехал (см.
	// FoundryModule.ID). Нужен «Удалить модуль» — снести пул-записи этого
	// модуля (созданных из них персонажей это не касается).
	Source string
	// ClaimedBy — id аккаунта, взявшего пре-гена ("" = свободен).
	ClaimedBy string
	// ClaimedCharacterID — id созданной при захвате записи characters.
	ClaimedCharacterID string
	CreatedAt          time.Time
}

// Free — пре-ген ещё никто не взял.
func (p *Pregen) Free() bool { return p.ClaimedBy == "" }
