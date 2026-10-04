// system-profile.js — единицы и валюты игровой системы мира (см.
// GET /api/system, domain.SystemProfile): ядро хранит вес числом без
// единицы, а деньги листа — словарём «ключ валюты → сумма». Какая единица
// веса и какие валюты, задаёт система (у D&D — «фнт» и пять монет, у «Своей
// системы» — «кг» и «Деньги»).
//
// Куб проверки (rolls.check) — чем бросается голый модификатор в тексте.
// Правило инициативы (initiative) — формула броска инициативы. Модули
// (modules) — подключённые к миру, в порядке подключения.
//
// Загрузка одна на страницу (loadSystemProfile в boot страницы); функции
// форматирования синхронные и до загрузки отдают нейтральный вид — число
// без единицы, без валют.
import { fetchSystemProfile } from "./api.js";

// До загрузки куб проверки — «1d20», как у «Своей системы» (domain.CustomRolls).
let profile = { id: "", title: "", units: { weight: "" }, currencies: [], rolls: { check: "1d20" }, initiative: { roll: "", rollField: "initiative" }, modules: [] };
let loading = null;

export function loadSystemProfile() {
  if (!loading) {
    loading = fetchSystemProfile()
      .then((p) => {
        if (p && typeof p === "object") {
          profile = {
            id: p.id || "",
            title: p.title || "",
            units: { weight: (p.units && p.units.weight) || "" },
            currencies: Array.isArray(p.currencies) ? p.currencies : [],
            rolls: { check: p.rolls && typeof p.rolls.check === "string" ? p.rolls.check : "1d20" },
            initiative: { roll: (p.initiative && p.initiative.roll) || "", rollField: (p.initiative && p.initiative.rollField) || "" },
            modules: Array.isArray(p.modules) ? p.modules : [],
          };
        }
        return profile;
      })
      .catch(() => profile);
  }
  return loading;
}

export const weightUnit = () => profile.units.weight;

// checkDie — куб проверки системы («1d20», «2d6»; "" — голый модификатор в
// тексте не бросается), см. inline-rolls.js.
export const checkDie = () => profile.rolls.check;

// initiativeRule — правило инициативы системы: поле карточки с формулой
// (rollField) и запасная формула (roll), см. schema-summary.js: ruleInitiative.
export const initiativeRule = () => profile.initiative;

// systemId — id системы мира; до загрузки профиля пусто.
export const systemId = () => profile.id;

// worldModules — модули мира [{id, title, type}]; moduleTitle — название по
// id (неизвестный модуль — сам id).
export const worldModules = () => profile.modules;
export function moduleTitle(id) {
  const m = profile.modules.find((x) => x.id === id);
  return m ? m.title : id;
}

// formatWeight — «2.5 фнт» / «2.5 кг»; без единицы — просто число.
export function formatWeight(value) {
  const unit = weightUnit();
  const v = String(value || 0);
  return unit ? `${v} ${unit}` : v;
}

export const currencies = () => profile.currencies;

// coinRows — строки кошелька: валюты системы в её порядке, затем ключи из
// coins, которых система не знает (лист перенесли из мира на другой
// системе) — с пометкой other и ключом вместо подписи.
export function coinRows(coins) {
  const known = profile.currencies.map((c) => ({ key: c.key, label: c.label, title: c.title || c.label, other: false }));
  const keys = new Set(known.map((c) => c.key));
  const other = Object.keys(coins || {})
    .filter((k) => !keys.has(k))
    .sort()
    .map((k) => ({ key: k, label: k, title: k, other: true }));
  return known.concat(other);
}
