// room_statuses.go — вторая половина Room-актора: наложенные состояния
// (domain.AppliedStatus) на токенах и бойцах инициативы. Отдельный файл, а
// не ещё двести строк в room.go — по той же причине, по которой
// monsterfile/system.go отделён от monsterfile.go: механика самодостаточная
// и завязана только на внутренние детали Room (r.scene/r.combat/markDirty),
// экспортируемую границу между ними городить незачем.
//
// Всё, что здесь происходит, выполняется в горутине Room.run() — никаких
// мьютексов, как и в остальном актора-коде.
//
// ГДЕ ИСТИНА. Метка живёт на ТОКЕНЕ (Token.Statuses), если токен есть, и на
// БОЙЦЕ (Combatant.Statuses), если бойца ещё не вытащили на карту. Одна
// точка разрешения — resolveStatusTarget/statusesOf, поэтому дублирования
// состояния не возникает: у бойца с TokenID собственный список всегда
// пустой (см. handlePlaceCombatantToken — при постановке токена метки
// переезжают на него). Тот же принцип сквозной связи «боец → его токен»
// уже работает у Token.Dead (см. markTokenDead в room.go).
package service

import (
	"context"
	"strings"

	"beacon-table/internal/domain"
)

// maxStatusesPerTarget — сколько меток максимум висит на одной цели.
// Не игровое правило (в правилах предела нет), а защита от «залипшего»
// клиента и от нечитаемой каши значков над токеном: 5 значков клиент
// рисует, остальные сворачивает в «+N» (см. web/src/vtt/layers/tokens.js).
const maxStatusesPerTarget = 24

// maxStatusSourceLen — предел подписи «откуда прилетело» (AppliedStatus.
// Source): текст со стороны недоверенного клиента, как Label у "roll_dice".
const maxStatusSourceLen = 120

// statusTarget — разрешённая цель команды состояния: указатель на СЛАЙС,
// который надо править, плюс контекст для персиста и рассылки. Указатель на
// слайс, а не сам слайс, потому что append может переаллоцировать — писать
// результат надо обратно в поле владельца.
type statusTarget struct {
	list *[]domain.AppliedStatus
	// sceneID — какую сцену пометить грязной (пусто, если метки лежат на
	// бойце, а не на токене — тогда грязным становится combat.json).
	sceneID string
	// onCombat — надо ли разослать трекер: true, если цель — боец либо токен,
	// за которым стоит боец (его карточка в трекере тоже показывает чипы).
	onCombat bool
	// onScene — надо ли разослать сцену (цель — токен).
	onScene bool
}

// findToken ищет токен по id ВО ВСЕХ сценах комнаты, а не только в активной:
// боец инициативы переживает переключение сцены (см. domain.CombatState —
// трекер не привязан к сцене), и ДМ вполне может повесить метку из трекера
// на бойца, чей токен стоит на другой карте. Возвращает и сам токен, и id
// сцены — его нужно пометить грязным (см. markDirty).
func (r *Room) findToken(tokenID string) (*domain.Token, string) {
	if tokenID == "" {
		return nil, ""
	}
	if t, ok := r.scene.Tokens[tokenID]; ok {
		return t, r.currentSceneID
	}
	for id, sc := range r.scenes {
		if id == r.currentSceneID {
			continue // уже проверили выше
		}
		if t, ok := sc.Tokens[tokenID]; ok {
			return t, id
		}
	}
	return nil, ""
}

// combatantByToken — боец инициативы, стоящий за этим токеном (nil, если
// токен в бою не участвует). Линейный проход по map бойцов: их единицы,
// а команды состояний приходят редко (это не move_token с сотней сообщений
// в секунду).
func (r *Room) combatantByToken(tokenID string) *domain.Combatant {
	if tokenID == "" {
		return nil
	}
	for _, cmb := range r.combat.Combatants {
		if cmb.TokenID == tokenID {
			return cmb
		}
	}
	return nil
}

// turnAllowsTokenMove — можно ли сейчас двигать этот токен. Вне активного
// боя — всегда да (свободное перемещение до начала инициативы). В бою —
// только если у токена вообще нет привязки к трекеру (декорация/фон, не
// участвует в инициативе) или он принадлежит бойцу, чей сейчас ход;
// остальные, включая ДМ, двигают лишь текущего бойца — см. handleTurnStep.
func (r *Room) turnAllowsTokenMove(tokenID string) bool {
	if !r.combat.Active {
		return true
	}
	cmb := r.combatantByToken(tokenID)
	return cmb == nil || cmb.ID == r.combat.CurrentID
}

// resolveStatusTarget — единая точка «куда прикладывать метки» для всех
// команд состояний. Цель задаётся ОДНИМ из двух полей сообщения: TokenID
// (ПКМ по токену на карте) или CombatantID (карточка в трекере).
func (r *Room) resolveStatusTarget(msg domain.ClientMsg) (statusTarget, bool) {
	switch {
	case msg.TokenID != "":
		t, sceneID := r.findToken(msg.TokenID)
		if t == nil {
			return statusTarget{}, false
		}
		return statusTarget{
			list: &t.Statuses, sceneID: sceneID, onScene: true,
			onCombat: r.combatantByToken(t.ID) != nil,
		}, true
	case msg.CombatantID != "":
		cmb, ok := r.combat.Combatants[msg.CombatantID]
		if !ok {
			return statusTarget{}, false
		}
		// У бойца с токеном собственного списка нет — правим токен, чтобы
		// метка была видна и на карте, и в трекере (см. шапку файла).
		if t, sceneID := r.findToken(cmb.TokenID); t != nil {
			return statusTarget{list: &t.Statuses, sceneID: sceneID, onScene: true, onCombat: true}, true
		}
		return statusTarget{list: &cmb.Statuses, onCombat: true}, true
	}
	return statusTarget{}, false
}

// statusesOf — что показывать в карточке бойца: метки его токена, если токен
// есть, иначе его собственные. Обратная сторона resolveStatusTarget, только
// для чтения (см. combatPayload).
func (r *Room) statusesOf(cmb *domain.Combatant) []domain.AppliedStatus {
	if t, _ := r.findToken(cmb.TokenID); t != nil {
		return t.Statuses
	}
	return cmb.Statuses
}

// commitStatuses — общий хвост всех команд: пометить нужный файл грязным и
// разослать то, что реально поменялось.
func (r *Room) commitStatuses(tgt statusTarget) {
	if tgt.sceneID != "" {
		r.markDirty(tgt.sceneID)
	} else {
		r.markCombatDirty()
	}
	if tgt.onScene {
		r.broadcastAll()
	}
	if tgt.onCombat {
		// Метки бойца приходят в combat_state отдельно от сцены — карточка в
		// трекере (и вынесенное окно combat-tracker.html) не читает сцену.
		r.markCombatDirty()
		r.broadcastCombat()
	}
}

// indexOfStatus — позиция метки с таким slug в списке, -1 если её нет.
func indexOfStatus(list []domain.AppliedStatus, slug string) int {
	for i := range list {
		if list[i].Slug == slug {
			return i
		}
	}
	return -1
}

// lookupCondition — карточка справочника по slug. nil (а не ошибка), если
// такой карточки нет: сервер не обязан знать все состояния мира (ДМ мог
// удалить карточку, а метка с этим slug'ом прилетела из импортированного
// заклинания). Тогда снимок собирается из одного slug'а — метка всё равно
// повесится и будет видна, просто без русского имени и иконки.
func (r *Room) lookupCondition(slug string) *domain.Condition {
	if r.conditions == nil || slug == "" {
		return nil
	}
	list, err := r.conditions.List(context.Background())
	if err != nil {
		return nil
	}
	for _, c := range list {
		if NormalizeConditionSlug(c.Slug) == slug {
			return c
		}
	}
	return nil
}

// snapshotStatus — собрать метку из карточки справочника. Имя/иконку/цвет/
// overlay берём ИЗ КАРТОЧКИ, а не из сообщения клиента — тот же принцип
// недоверия, что у "hub_add_item" (имя/вес предмета) и "add_combatant"
// (HP/КД): клиент говорит только КОГО и ЧЕМ пометить.
func snapshotStatus(slug string, cond *domain.Condition) domain.AppliedStatus {
	st := domain.AppliedStatus{Slug: slug, Name: slug, Icon: "❔"}
	if cond != nil {
		st.Name = cond.Name
		st.Color = cond.Color
		st.Overlay = cond.Overlay
		if cond.Icon != "" {
			st.Icon = cond.Icon
		}
		// Своя картинка (если задана) рисуется вместо глифа и на токене, и в
		// палитре; глиф при этом остаётся в снимке запасным вариантом — на
		// случай, если картинка не загрузится.
		st.ImageURL = cond.ImageURL
		// Модификаторы копируются в метку, а не читаются из карточки по
		// ссылке — см. domain.AppliedStatus.Modifiers: правка карточки
		// посреди боя не должна задним числом менять цифры уже висящих
		// меток. Копия слайса, а не разделяемая ссылка: карточка приходит из
		// репозитория и может быть общим объектом кэша.
		if len(cond.Modifiers) > 0 {
			st.Modifiers = append([]domain.Modifier(nil), cond.Modifiers...)
		}
	}
	return st
}

// handleApplyStatus — "apply_status": повесить (или обновить уже висящую)
// метку. Повторное наложение того же slug'а НЕ плодит вторую метку, а
// правит существующую — палитра на клиенте работает как тумблер, снятие
// шлёт отдельный "remove_status".
//
// Riders (см. domain.Condition.Riders) разворачиваются здесь, на СЕРВЕРЕ, и
// ровно на один уровень вглубь: «беспамятство» само тянет «недееспособность»
// и «ничком», но rider'ы rider'ов уже не раскручиваются — так кольцевая
// ссылка в самодельной карточке ДМ не уводит в бесконечность. Rider'ы
// вешаются бессрочно и без уровня: их длительность определяется родителем,
// которого ДМ снимет руками (Foundry ведёт себя так же — снятие родителя
// зависимые не снимает).
func (r *Room) handleApplyStatus(msg domain.ClientMsg) {
	slug := NormalizeConditionSlug(msg.StatusSlug)
	if slug == "" {
		return
	}
	tgt, ok := r.resolveStatusTarget(msg)
	if !ok {
		return
	}
	cond := r.lookupCondition(slug)
	source := clampRunes(strings.TrimSpace(msg.Source), maxStatusSourceLen)

	rounds := 0
	if cond != nil {
		rounds = cond.DefaultRounds
	}
	if msg.Rounds != nil {
		rounds = *msg.Rounds
	}
	hidden := false
	if msg.Hidden != nil {
		hidden = *msg.Hidden
	}

	r.putStatus(tgt, slug, cond, msg.Level, rounds, hidden, source)
	if cond != nil {
		for _, rider := range cond.Riders {
			rider = NormalizeConditionSlug(rider)
			if rider == "" || rider == slug {
				continue
			}
			if indexOfStatus(*tgt.list, rider) >= 0 {
				continue // уже висит сам по себе — не трогаем его длительность
			}
			r.putStatus(tgt, rider, r.lookupCondition(rider), nil, 0, hidden, cond.Name)
		}
	}
	r.commitStatuses(tgt)
}

// putStatus — вставка/обновление одной метки без рассылки (общее тело для
// самого состояния и его rider'ов). level == nil означает «не трогать
// уровень существующей метки, а новой поставить 1, если состояние
// многоуровневое».
func (r *Room) putStatus(tgt statusTarget, slug string, cond *domain.Condition, level *int, rounds int, hidden bool, source string) {
	if rounds < 0 {
		rounds = 0
	}
	if rounds > maxStatusRounds {
		rounds = maxStatusRounds
	}
	maxLevel := 0
	if cond != nil {
		maxLevel = cond.Levels
	}

	if i := indexOfStatus(*tgt.list, slug); i >= 0 {
		st := &(*tgt.list)[i]
		// Имя/иконку освежаем из карточки — ДМ мог переименовать состояние
		// или сменить глиф уже после того, как метка повисла.
		snap := snapshotStatus(slug, cond)
		st.Name, st.Icon, st.ImageURL, st.Color, st.Overlay = snap.Name, snap.Icon, snap.ImageURL, snap.Color, snap.Overlay
		st.Modifiers = snap.Modifiers // повторное наложение освежает и цифры
		st.Rounds = rounds
		st.Hidden = hidden
		if source != "" {
			st.Source = source
		}
		if level != nil {
			st.Level = clampStatusLevel(*level, maxLevel)
		}
		return
	}
	if len(*tgt.list) >= maxStatusesPerTarget {
		return
	}
	st := snapshotStatus(slug, cond)
	st.Rounds = rounds
	st.Hidden = hidden
	st.Source = source
	switch {
	case level != nil:
		st.Level = clampStatusLevel(*level, maxLevel)
	case maxLevel > 1:
		st.Level = 1 // многоуровневое вешается с первого уровня
	}
	*tgt.list = append(*tgt.list, st)
}

// clampStatusLevel — уровень в допустимых границах карточки. Потолок 0/1
// (обычный тумблер) означает «уровня у метки нет» — приводим к 0.
func clampStatusLevel(level, maxLevel int) int {
	if maxLevel <= 1 || level < 0 {
		return 0
	}
	if level > maxLevel {
		return maxLevel
	}
	return level
}

// handleRemoveStatus — "remove_status": снять одну метку. Зависимые
// (riders), которые она за собой притянула, НЕ снимаются — они могли
// прилететь и сами по себе, а угадывать за ДМ мы не беремся (см.
// domain.Condition.Riders).
func (r *Room) handleRemoveStatus(msg domain.ClientMsg) {
	slug := NormalizeConditionSlug(msg.StatusSlug)
	tgt, ok := r.resolveStatusTarget(msg)
	if !ok || slug == "" {
		return
	}
	i := indexOfStatus(*tgt.list, slug)
	if i < 0 {
		return
	}
	*tgt.list = append((*tgt.list)[:i], (*tgt.list)[i+1:]...)
	r.commitStatuses(tgt)
}

// handleSetStatusLevel — "set_status_level": уровень многоуровневого
// состояния (истощение 1-6). Значение 0 снимает метку целиком — тот же
// приём «клик по первой заполненной лампе гасит её», что у спасбросков от
// смерти (см. combat-panel.js).
func (r *Room) handleSetStatusLevel(msg domain.ClientMsg) {
	if msg.Level == nil {
		return
	}
	if *msg.Level <= 0 {
		r.handleRemoveStatus(msg)
		return
	}
	slug := NormalizeConditionSlug(msg.StatusSlug)
	tgt, ok := r.resolveStatusTarget(msg)
	if !ok || slug == "" {
		return
	}
	i := indexOfStatus(*tgt.list, slug)
	if i < 0 {
		return
	}
	maxLevel := 0
	if cond := r.lookupCondition(slug); cond != nil {
		maxLevel = cond.Levels
	}
	(*tgt.list)[i].Level = clampStatusLevel(*msg.Level, maxLevel)
	r.commitStatuses(tgt)
}

// handleSetStatusRounds — "set_status_rounds": сколько раундов метке ещё
// висеть (0 — бессрочно). Ручная правка ДМ, без пересчёта — как и
// инициатива/HP в трекере.
func (r *Room) handleSetStatusRounds(msg domain.ClientMsg) {
	if msg.Rounds == nil {
		return
	}
	slug := NormalizeConditionSlug(msg.StatusSlug)
	tgt, ok := r.resolveStatusTarget(msg)
	if !ok || slug == "" {
		return
	}
	i := indexOfStatus(*tgt.list, slug)
	if i < 0 {
		return
	}
	rounds := *msg.Rounds
	if rounds < 0 {
		rounds = 0
	}
	if rounds > maxStatusRounds {
		rounds = maxStatusRounds
	}
	(*tgt.list)[i].Rounds = rounds
	r.commitStatuses(tgt)
}

// handleClearStatuses — "clear_statuses": снять с цели всё разом (кнопка
// «Снять все» в палитре).
func (r *Room) handleClearStatuses(msg domain.ClientMsg) {
	tgt, ok := r.resolveStatusTarget(msg)
	if !ok || len(*tgt.list) == 0 {
		return
	}
	*tgt.list = nil
	r.commitStatuses(tgt)
}

// tickStatuses — отсчёт длительности. Вызывается из handleTurnStep в момент,
// когда ход ПЕРЕХОДИТ к бойцу cmb, и только в активном бою.
//
// Семантика — 5e, а не Foundry: длительность в раундах уменьшается в начале
// хода того, НА КОМ висит метка (в Foundry счётчик привязан к раунду
// наложения и общему таймеру боя). То есть «до конца твоего следующего
// хода» = 1 раунд: метка, повешенная в чужой ход, доживает до начала
// следующего хода цели и там снимается. Считаем только вперёд: "prev_turn"
// (dir=-1) — это отмена ошибки ДМ, а не течение времени, длительности он не
// трогает (иначе шаг назад-вперёд «съедал» бы по раунду).
//
// Возвращает true, если что-то реально изменилось — вызывающий решает,
// рассылать ли (handleTurnStep всё равно шлёт combat_state, но сцену —
// только если метки на токене действительно поменялись).
func (r *Room) tickStatuses(cmb *domain.Combatant) (changed bool, sceneID string) {
	if cmb == nil {
		return false, ""
	}
	list := &cmb.Statuses
	if t, id := r.findToken(cmb.TokenID); t != nil {
		list = &t.Statuses
		sceneID = id
	}
	kept := (*list)[:0]
	for _, st := range *list {
		if st.Rounds <= 0 { // бессрочная — не трогаем
			kept = append(kept, st)
			continue
		}
		st.Rounds--
		changed = true
		if st.Rounds > 0 {
			kept = append(kept, st)
		}
	}
	if !changed {
		return false, sceneID
	}
	*list = kept
	return true, sceneID
}

// ---- применение модификаторов (см. domain.Modifier) ----

// effectiveStat — базовое число бойца плюс все ПОСТОЯННЫЕ модификаторы его
// меток. Тонкий слой над чистой domain.ApplyModifiers: собрать список
// модификаторов со всех висящих на бойце меток и отдать его туда.
//
// Считается на лету при каждой рассылке, а не хранится: метки приходят и
// уходят, и второе поле «эффективный КД» рядом с базовым немедленно начало
// бы врать (тот же принцип, что у порядка инициативы — он тоже всегда
// считается заново, см. sortedCombatantIDs).
func (r *Room) effectiveStat(cmb *domain.Combatant, base int, target string) int {
	statuses := r.statusesOf(cmb)
	if len(statuses) == 0 {
		return base
	}
	mods := make([]domain.Modifier, 0, len(statuses))
	for _, st := range statuses {
		mods = append(mods, st.Modifiers...)
	}
	return domain.ApplyModifiers(base, target, mods)
}

// applyPeriodicModifiers — разовые изменения хитов в начале/конце хода
// бойца: «горит — 1к6», «регенерация — +5», «яд — 3». Вызывается из
// handleTurnStep и только в активном бою.
//
// Формула бросается НАСТОЯЩИМ роллером комнаты и уходит в общий лог
// (relayRoll), как любой другой бросок за столом — иначе игроки видели бы,
// что хиты просто уменьшились, без объяснения на сколько и почему. Знак
// задаёт сама формула: «-1d6» — урон, «5» — лечение (см. dice.go: ведущий
// минус формулой поддерживается).
//
// Итог применяется тем же путём, что и ручная правка HP в трекере (см.
// handleSetCombatantHP): те же побочные эффекты — сброс спасбросков от
// смерти при выходе в плюс, смерть монстра/NPC при нуле. Поэтому боец
// может прямо здесь исчезнуть из трекера — вызывающий обязан это учитывать
// (см. комментарий в handleTurnStep).
func (r *Room) applyPeriodicModifiers(cmb *domain.Combatant, period string) {
	if cmb == nil || r.dice == nil {
		return
	}
	statuses := r.statusesOf(cmb)
	delta := 0
	for _, st := range statuses {
		for _, m := range st.Modifiers {
			if m.Period != period || m.Target != domain.ModifierTargetHPCurrent {
				continue
			}
			formula := normalizeDiceFormula(m.Value)
			var result domain.RollResult
			
			if v, ok := domain.ParseModifierValue(m.Value); ok {
				result = domain.RollResult{Total: v}
			} else {
				var err error
				result, err = r.dice.Roll(formula)
				if err != nil {
					continue
				}
			}
			label := st.Name
			if m.Note != "" {
				label += " (" + m.Note + ")"
			}
			r.relayRoll(cmb.Name, formula, label, result)
			delta += result.Total
		}
	}
	if delta == 0 {
		return
	}
	r.handleSetCombatantHP(cmb.ID, nil, nil, nil, &delta)
}

// publicStatuses — версия списка меток для конкретной роли: не-ДМ не должен
// получать скрытые метки ФИЗИЧЕСКИ (см. AppliedStatus.Hidden), а не прятать
// их стилями — тот же принцип, что у Token.Hidden в sceneFor и у AC/HP в
// combatPayload. Если скрытых меток нет, возвращает исходный слайс без
// копирования — обычный случай, лишний аллок ни к чему.
func publicStatuses(list []domain.AppliedStatus, isDM bool) []domain.AppliedStatus {
	if isDM || len(list) == 0 {
		return list
	}
	hasHidden := false
	for _, st := range list {
		if st.Hidden {
			hasHidden = true
			break
		}
	}
	if !hasHidden {
		return list
	}
	out := make([]domain.AppliedStatus, 0, len(list))
	for _, st := range list {
		if !st.Hidden {
			out = append(out, st)
		}
	}
	return out
}

// publicToken — токен в том виде, в каком он уходит НЕ-ДМ клиенту: тот же
// объект, если прятать нечего (обычный случай), иначе поверхностная копия с
// вырезанными скрытыми метками. Копия нужна, чтобы фильтрация для одного
// клиента не поломала состояние комнаты — сам r.scene.Tokens правится
// только мутациями.
func publicToken(t *domain.Token) *domain.Token {
	filtered := publicStatuses(t.Statuses, false)
	if len(filtered) == len(t.Statuses) {
		return t
	}
	clone := *t
	clone.Statuses = filtered
	return &clone
}
