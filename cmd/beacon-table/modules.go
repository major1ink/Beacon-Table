package main

import (
	"io/fs"
	"net/http"
	"path"
	"strings"

	"beacon-table/internal/domain"
	"beacon-table/internal/module"
)

// builtinModules — каталог D&D, пока ещё зашитый в бинарник (systemdata),
// в виде обычных системных модулей. Карточки сохраняют id sys-<имя файла>
// (legacyIds), поэтому миры 0.8.x видят ровно те же карточки. Временная
// мера: в задаче «Вынос D&D из бинарника» эти модули уезжают в отдельный
// репозиторий и ставятся с витрины, а отсюда исчезают.
func builtinModules(systemFS fs.FS) []*module.Module {
	systems := []struct{ id, title string }{
		{"dnd5e-2014", "D&D 5e (2014)"},
		{"dnd5e-2024", "D&D 5e (2024)"},
	}
	out := make([]*module.Module, 0, len(systems))
	for _, s := range systems {
		out = append(out, module.Builtin(systemFS, "systemdata", s.id, &module.Manifest{
			Format:          module.Format,
			ID:              s.id,
			Type:            module.TypeSystem,
			Title:           s.title,
			Version:         "1.0.0",
			Systems:         []string{s.id},
			Description:     "Встроенный каталог SRD: существа, заклинания, предметы, справочник и состояния.",
			License:         "CC-BY-4.0 (SRD 5.2)",
			LegacyIDs:       true,
			Combat:          dndCombatRules(),
			ModifierTargets: dndModifierTargets(),
		}))
	}
	return out
}

// dndCombatRules — правила боя D&D 5e (одинаковые в 2014 и 2024): инициатива
// 1d20 + модификатор Ловкости, персонаж на 0 хитов бросает спасброски от
// смерти (3 успеха — приходит в себя с 1 хитом, 3 провала — смерть),
// существо умирает сразу, опыт — по уровню опасности (таблица DMG,
// "Beating Encounters").
func dndCombatRules() *domain.CombatRules {
	return &domain.CombatRules{
		Initiative: domain.InitiativeRule{Roll: "1d20", Bonus: "abilityMod:dex"},
		ZeroHP: domain.ZeroHPRule{
			Character:  domain.ZeroHPDeathSaves,
			Other:      domain.ZeroHPDead,
			DeathSaves: &domain.DeathSavesRule{Success: 3, Fail: 3, StabilizeHP: 1},
		},
		XP: domain.XPRule{Field: "cr", Table: map[string]int{
			"0": 10, "1/8": 25, "1/4": 50, "1/2": 100,
			"1": 200, "2": 450, "3": 700, "4": 1100, "5": 1800,
			"6": 2300, "7": 2900, "8": 3900, "9": 5000, "10": 5900,
			"11": 7200, "12": 8400, "13": 10000, "14": 11500, "15": 13000,
			"16": 15000, "17": 18000, "18": 20000, "19": 22000, "20": 25000,
			"21": 33000, "22": 41000, "23": 50000, "24": 62000, "25": 75000,
			"26": 90000, "27": 105000, "28": 120000, "29": 135000, "30": 155000,
		}},
	}
}

// dndModifierTargets — шесть характеристик D&D как цели модификаторов: их
// правит лист D&D (web/src/pages/character-sheet.js) и импорт состояний из
// Foundry (web/src/condition-import.js).
func dndModifierTargets() []domain.ModifierTargetInfo {
	return []domain.ModifierTargetInfo{
		{Target: "abilities.str", Label: "Сила", System: true},
		{Target: "abilities.dex", Label: "Ловкость", System: true},
		{Target: "abilities.con", Label: "Телосложение", System: true},
		{Target: "abilities.int", Label: "Интеллект", System: true},
		{Target: "abilities.wis", Label: "Мудрость", System: true},
		{Target: "abilities.cha", Label: "Харизма", System: true},
	}
}

// moduleAssetsURL — картинки модулей: /module-assets/<id модуля>/<путь в
// папке assets модуля>. Карточка модуля ссылается на свою картинку этим
// адресом (imageUrl), поэтому он не настройка.
const moduleAssetsURL = "/module-assets/"

// moduleAssetsHandler раздаёт папку assets модуля по его id. Модуль ищется
// на каждый запрос: установка и удаление модуля видны сразу, без
// перезапуска сервера.
func moduleAssetsHandler(registry *module.Registry) http.Handler {
	return http.StripPrefix(moduleAssetsURL, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, rest, ok := strings.Cut(r.URL.Path, "/")
		if !ok || rest == "" || strings.HasSuffix(rest, "/") {
			http.NotFound(w, r)
			return
		}
		mod, err := registry.Get(id)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		assets, err := fs.Sub(mod.FS, mod.AssetsDir())
		if err != nil {
			http.NotFound(w, r)
			return
		}
		r2 := r.Clone(r.Context())
		r2.URL.Path = "/" + path.Clean(rest)
		http.FileServer(http.FS(assets)).ServeHTTP(w, r2)
	}))
}
