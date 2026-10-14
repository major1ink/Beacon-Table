// universal-stats.js — основы для стенда конструктора модификаторов (см.
// stand.js) из листа по схеме: свободные характеристики (domain.FreeStat) и
// инициатива (CharacterSheet.Initiative). Значения с модификаторами на
// самом листе считает schema-formula.js.
import { statTarget } from "./modifiers.js";
import { getPath } from "./schema-layout.js";

const intOf = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
};

// standStats — основы stat.<ключ> для стенда конструктора: значения
// характеристик листа без модификаторов. Две характеристики с одним ключом
// — берётся первая, как и при применении на листе.
export function standStats(sheet) {
  const out = {};
  for (const stat of (sheet && sheet.stats) || []) {
    const target = statTarget(stat && stat.name);
    if (target && !(target in out)) out[target] = intOf(stat.value);
  }
  return out;
}

// schemaBases — основы целей системы для стенда: у каждого числового поля
// схемы с modifierTarget — значение по его пути без модификаторов (у D&D —
// abilities.*). Две цели с одним ключом — берётся первая.
export function schemaBases(schema, data) {
  const out = {};
  for (const f of Object.values((schema && schema.fields) || {})) {
    if (f.type !== "number" || !f.modifierTarget || f.modifierTarget in out) continue;
    const raw = getPath(data, f.path);
    if (raw === undefined || raw === null || raw === "") continue;
    out[f.modifierTarget] = intOf(raw);
  }
  return out;
}
