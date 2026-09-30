// universal-stats.js — основы для стенда конструктора модификаторов (см.
// stand.js) из листа по схеме: свободные характеристики (domain.FreeStat) и
// инициатива (CharacterSheet.Initiative). Значения с модификаторами на
// самом листе считает schema-formula.js.
import { statTarget } from "./modifiers.js";

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
