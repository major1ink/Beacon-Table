// system-profile.js — единицы и валюты игровой системы мира (см.
// GET /api/system, domain.SystemProfile): ядро хранит вес числом без
// единицы, а деньги листа — словарём «ключ валюты → сумма». Какая единица
// веса и какие валюты, задаёт система (у D&D — «фнт» и пять монет, у «Своей
// системы» — «кг» и «Деньги»).
//
// Загрузка одна на страницу (loadSystemProfile в boot страницы); функции
// форматирования синхронные и до загрузки отдают нейтральный вид — число
// без единицы, без валют.
import { fetchSystemProfile } from "./api.js";

let profile = { id: "", title: "", units: { weight: "" }, currencies: [] };
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
          };
        }
        return profile;
      })
      .catch(() => profile);
  }
  return loading;
}

export const weightUnit = () => profile.units.weight;

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
