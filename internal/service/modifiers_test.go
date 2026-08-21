package service

import (
	"testing"

	"beacon-table/internal/domain"
)

func mod(target, mode, value string) domain.Modifier {
	return domain.Modifier{Target: target, Mode: mode, Value: value}
}

func TestApplyModifiersOrderIsFixed(t *testing.T) {
	// Порядок применения не зависит от порядка записей: set → add → min →
	// max (см. domain.ApplyModifiers). Кольчуга «ставит 14» и щит «+2» дают
	// 16 независимо от того, в каком порядке они лежат в списке.
	shieldFirst := []domain.Modifier{
		mod(domain.ModifierTargetAC, domain.ModifierAdd, "2"),
		mod(domain.ModifierTargetAC, domain.ModifierSet, "14"),
	}
	armorFirst := []domain.Modifier{
		mod(domain.ModifierTargetAC, domain.ModifierSet, "14"),
		mod(domain.ModifierTargetAC, domain.ModifierAdd, "2"),
	}
	if got := domain.ApplyModifiers(11, domain.ModifierTargetAC, shieldFirst); got != 16 {
		t.Errorf("щит первым: КД = %d, ожидалось 16", got)
	}
	if got := domain.ApplyModifiers(11, domain.ModifierTargetAC, armorFirst); got != 16 {
		t.Errorf("доспех первым: КД = %d, ожидалось 16", got)
	}
}

func TestApplyModifiersClamps(t *testing.T) {
	mods := []domain.Modifier{
		mod(domain.ModifierTargetSpeed, domain.ModifierAdd, "10"),
		mod(domain.ModifierTargetSpeed, domain.ModifierMax, "0"), // опутанность
	}
	if got := domain.ApplyModifiers(30, domain.ModifierTargetSpeed, mods); got != 0 {
		t.Errorf("скорость = %d, ожидался 0: «не выше 0» должно перебивать прибавку", got)
	}
	minMods := []domain.Modifier{mod(domain.ModifierTargetAC, domain.ModifierMin, "15")}
	if got := domain.ApplyModifiers(12, domain.ModifierTargetAC, minMods); got != 15 {
		t.Errorf("КД = %d, ожидалось 15 («не ниже»)", got)
	}
	if got := domain.ApplyModifiers(18, domain.ModifierTargetAC, minMods); got != 18 {
		t.Errorf("КД = %d: «не ниже 15» не должно опускать 18", got)
	}
}

func TestApplyModifiersIgnoresForeignAndPeriodic(t *testing.T) {
	mods := []domain.Modifier{
		mod(domain.ModifierTargetSpeed, domain.ModifierAdd, "10"), // другая цель
		{Target: domain.ModifierTargetHPCurrent, Mode: domain.ModifierAdd, Value: "-1d6", Period: domain.ModifierPeriodTurnStart},
		mod(domain.ModifierTargetAC, domain.ModifierAdd, "1к6"), // формула у постоянного — не число
		mod(domain.ModifierTargetAC, domain.ModifierAdd, "2"),
	}
	if got := domain.ApplyModifiers(10, domain.ModifierTargetAC, mods); got != 12 {
		t.Errorf("КД = %d, ожидалось 12: считается только постоянный числовой модификатор своей цели", got)
	}
}

func TestApplyModifiersSeveralSetTakesLowest(t *testing.T) {
	mods := []domain.Modifier{
		mod(domain.ModifierTargetAC, domain.ModifierSet, "18"),
		mod(domain.ModifierTargetAC, domain.ModifierSet, "14"),
	}
	if got := domain.ApplyModifiers(10, domain.ModifierTargetAC, mods); got != 14 {
		t.Errorf("КД = %d, ожидалось 14: при двух «заменить на» побеждает наименьший", got)
	}
}

func TestSanitizeModifiersDropsJunk(t *testing.T) {
	got := sanitizeModifiers([]domain.Modifier{
		{Target: "system.attributes.ac.bonus", Mode: "add", Value: "2"}, // чужая цель
		{Target: domain.ModifierTargetAC, Mode: "multiply", Value: "2"}, // неизвестный режим
		{Target: domain.ModifierTargetAC, Mode: domain.ModifierAdd, Value: "  "},
		{Target: domain.ModifierTargetAC, Mode: domain.ModifierAdd, Value: " -2 ", Note: " от щита "},
		// период у цели, которая его не поддерживает — молча делаем постоянным
		{Target: domain.ModifierTargetAC, Mode: domain.ModifierAdd, Value: "1", Period: domain.ModifierPeriodTurnStart},
	})
	if len(got) != 3 {
		t.Fatalf("осталось %d записей, ожидалось 3: %+v", len(got), got)
	}
	if got[0].Mode != domain.ModifierAdd {
		t.Errorf("неизвестный режим должен становиться «прибавить», получено %q", got[0].Mode)
	}
	if got[1].Value != "-2" || got[1].Note != "от щита" {
		t.Errorf("значение/подпись не обрезаны по краям: %+v", got[1])
	}
	if got[2].Period != domain.ModifierPeriodNone {
		t.Errorf("период у КД должен быть сброшен, получено %q", got[2].Period)
	}
}

// ---- применение в бою ----

// fixedRoller — детерминированный бросок для тестов периодических
// модификаторов: сколько бы кубов ни просили, отдаёт заранее заданный итог.
type fixedRoller struct {
	total    int
	formulas []string
}

func (f *fixedRoller) Roll(formula string) (domain.RollResult, error) {
	f.formulas = append(f.formulas, formula)
	return domain.RollResult{Rolls: []int{f.total}, Total: f.total}, nil
}

func TestPeriodicModifierDamagesOnTurnStart(t *testing.T) {
	r := testRoom()
	roller := &fixedRoller{total: -4}
	r.dice = roller
	r.conditions = &fakeConditions{list: []*domain.Condition{{
		ID: "sys-burning", Name: "Горит", Slug: "burning", Icon: "🔥",
		Modifiers: []domain.Modifier{{
			Target: domain.ModifierTargetHPCurrent, Mode: domain.ModifierAdd,
			Value: "-1к6", Period: domain.ModifierPeriodTurnStart, Note: "огонь",
		}},
	}}}

	r.combat.Active = true
	r.combat.Round = 1
	r.combat.Combatants["c1"] = &domain.Combatant{
		ID: "c1", Name: "Гоблин", TokenID: "tok-1", Initiative: 20, Seq: 1,
		HPCurrent: 10, HPMax: 10, CharacterID: "char-1", // персонаж: не умирает сразу при нуле
	}
	r.combat.CurrentID = "c1"
	r.handleApplyStatus(domain.ClientMsg{TokenID: "tok-1", StatusSlug: "burning"})

	// Снимок модификаторов лёг на метку — карточку читать больше не нужно.
	if got := tokenStatuses(r)[0].Modifiers; len(got) != 1 || got[0].Value != "-1к6" {
		t.Fatalf("модификаторы не попали в снимок метки: %+v", got)
	}

	r.handleTurnStep(1) // круг из одного бойца: ход снова его, значит «начало хода»
	if r.combat.Combatants["c1"].HPCurrent != 6 {
		t.Errorf("HP = %d, ожидалось 6 (10 − 4)", r.combat.Combatants["c1"].HPCurrent)
	}
	// Русское «к» в формуле переводится в «d» перед броском — роллер другого
	// не понимает (см. service.normalizeDiceFormula).
	if len(roller.formulas) != 1 || roller.formulas[0] != "-1d6" {
		t.Errorf("роллер получил %v, ожидалось [-1d6]", roller.formulas)
	}
}

func TestPeriodicModifierHeals(t *testing.T) {
	r := testRoom()
	r.dice = &fixedRoller{total: 5}
	r.conditions = &fakeConditions{list: []*domain.Condition{{
		ID: "sys-regen", Name: "Регенерация", Slug: "regen",
		Modifiers: []domain.Modifier{{
			Target: domain.ModifierTargetHPCurrent, Mode: domain.ModifierAdd,
			Value: "5", Period: domain.ModifierPeriodTurnStart,
		}},
	}}}
	r.combat.Active = true
	r.combat.Combatants["c1"] = &domain.Combatant{
		ID: "c1", Name: "Тролль", TokenID: "tok-1", Initiative: 20, Seq: 1,
		HPCurrent: 3, HPMax: 20, CharacterID: "char-1",
	}
	r.combat.CurrentID = "c1"
	r.handleApplyStatus(domain.ClientMsg{TokenID: "tok-1", StatusSlug: "regen"})

	r.handleTurnStep(1)
	if got := r.combat.Combatants["c1"].HPCurrent; got != 8 {
		t.Errorf("HP = %d, ожидалось 8 (3 + 5)", got)
	}
}

func TestPeriodicModifierKillsMonster(t *testing.T) {
	r := testRoom()
	r.dice = &fixedRoller{total: -12}
	r.conditions = &fakeConditions{list: []*domain.Condition{{
		ID: "sys-burning", Name: "Горит", Slug: "burning",
		Modifiers: []domain.Modifier{{
			Target: domain.ModifierTargetHPCurrent, Mode: domain.ModifierAdd,
			Value: "-2d6", Period: domain.ModifierPeriodTurnStart,
		}},
	}}}
	r.combat.Active = true
	// Монстр (нет CharacterID) — при нуле умирает сразу, тем же путём, что и
	// при ручной правке HP в трекере.
	r.combat.Combatants["c1"] = &domain.Combatant{ID: "c1", Name: "Гоблин", TokenID: "tok-1", Initiative: 20, Seq: 1, HPCurrent: 7, HPMax: 7}
	r.combat.CurrentID = "c1"
	r.handleApplyStatus(domain.ClientMsg{TokenID: "tok-1", StatusSlug: "burning"})

	r.handleTurnStep(1)
	if _, alive := r.combat.Combatants["c1"]; alive {
		t.Error("монстр с нулём хитов должен был выбыть из инициативы")
	}
	if !r.scene.Tokens["tok-1"].Dead {
		t.Error("токен должен быть помечен мёртвым")
	}
}

func TestPeriodicModifierIgnoredOutsideCombatAndBackwards(t *testing.T) {
	r := testRoom()
	r.dice = &fixedRoller{total: -4}
	r.conditions = &fakeConditions{list: []*domain.Condition{{
		ID: "sys-burning", Name: "Горит", Slug: "burning",
		Modifiers: []domain.Modifier{{
			Target: domain.ModifierTargetHPCurrent, Mode: domain.ModifierAdd,
			Value: "-1d6", Period: domain.ModifierPeriodTurnStart,
		}},
	}}}
	r.combat.Combatants["c1"] = &domain.Combatant{ID: "c1", Name: "Гоблин", TokenID: "tok-1", Initiative: 20, Seq: 1, HPCurrent: 10, HPMax: 10, CharacterID: "char-1"}
	r.combat.CurrentID = "c1"
	r.handleApplyStatus(domain.ClientMsg{TokenID: "tok-1", StatusSlug: "burning"})

	r.handleTurnStep(1) // бой не начат — время не идёт
	if got := r.combat.Combatants["c1"].HPCurrent; got != 10 {
		t.Errorf("вне боя HP не должно меняться, получено %d", got)
	}
	r.combat.Active = true
	r.handleTurnStep(-1) // шаг назад — отмена ошибки ДМ, а не течение времени
	if got := r.combat.Combatants["c1"].HPCurrent; got != 10 {
		t.Errorf("шаг назад не должен применять периодические модификаторы, получено %d", got)
	}
}

func TestEffectiveACFromStatuses(t *testing.T) {
	r := testRoom()
	r.conditions = &fakeConditions{list: []*domain.Condition{{
		ID: "sys-hex", Name: "Порча", Slug: "hex",
		Modifiers: []domain.Modifier{mod(domain.ModifierTargetAC, domain.ModifierAdd, "-2")},
	}}}
	cmb := &domain.Combatant{ID: "c1", Name: "Гоблин", TokenID: "tok-1", AC: 15}
	r.combat.Combatants["c1"] = cmb

	if got := r.effectiveStat(cmb, cmb.AC, domain.ModifierTargetAC); got != 15 {
		t.Errorf("без меток КД = %d, ожидалось 15", got)
	}
	r.handleApplyStatus(domain.ClientMsg{CombatantID: "c1", StatusSlug: "hex"})
	if got := r.effectiveStat(cmb, cmb.AC, domain.ModifierTargetAC); got != 13 {
		t.Errorf("КД = %d, ожидалось 13", got)
	}
	// База не тронута — её правит ДМ, эффективное значение считается на лету.
	if cmb.AC != 15 {
		t.Errorf("базовый КД изменился на %d — он должен оставаться прежним", cmb.AC)
	}
}
