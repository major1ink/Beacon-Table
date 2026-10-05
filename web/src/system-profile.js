// system-profile.js — единицы и валюты игровой системы мира (см.
// GET /api/system, domain.SystemProfile): ядро хранит вес числом без
// единицы, а деньги листа — словарём «ключ валюты → сумма». Какая единица
// веса и какие валюты, задаёт система (у D&D — «фнт» и пять монет, у «Своей
// системы» — «кг» и «Деньги»).
//
// Куб проверки (rolls.check) — чем бросается голый модификатор в тексте.
// Правило инициативы (initiative) — формула броска инициативы. Размер токена
// (tokenSize) — сторона токена существа в клетках по полю карточки. Модули
// (modules) — подключённые к миру, в порядке подключения.
//
// Загрузка одна на страницу (loadSystemProfile в boot страницы); функции
// форматирования синхронные и до загрузки отдают нейтральный вид — число
// без единицы, без валют.
import { fetchSystemProfile } from "./api.js";

// До загрузки куб проверки — «1d20», как у «Своей системы» (domain.CustomRolls).
let profile = { id: "", title: "", units: { weight: "" }, currencies: [], rolls: { check: "1d20" }, initiative: { roll: "", rollField: "initiative" }, tokenSize: null, modules: [] };
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
            tokenSize: p.tokenSize && p.tokenSize.field && p.tokenSize.table ? p.tokenSize : null,
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

// tokenSizeCells — сторона токена карточки card в клетках по правилу rule;
// значения нет в таблице или правила нет — 1.
export function tokenSizeCells(rule, card) {
  if (!rule || !card) return 1;
  let v = card;
  for (const key of rule.field.split(".")) v = v && typeof v === "object" ? v[key] : undefined;
  const want = String(v ?? "").trim().toLowerCase();
  if (!want) return 1;
  for (const [k, cells] of Object.entries(rule.table)) {
    if (k.trim().toLowerCase() === want) return cells;
  }
  return 1;
}

export const cardTokenCells = (card) => tokenSizeCells(profile.tokenSize, card);

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
