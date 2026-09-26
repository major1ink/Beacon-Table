// universal-stats.js — расчёты универсального листа без DOM (их же читает
// стенд конструктора, см. stand.js): свободные характеристики
// (domain.FreeStat) с модификаторами stat.<ключ> и инициатива-формула
// (CharacterSheet.Initiative).
import { applyModifiers, statTarget } from "./modifiers.js";

// statTargetOf — цель модификатора этой характеристики ("" — у безымянной).
export const statTargetOf = (stat) => statTarget(stat && stat.name);

const intOf = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
};

// statValue — значение характеристики с учётом модификаторов надетых
// предметов и висящих состояний (mods — см. modifiers.js: collectModifiers).
export function statValue(stat, mods) {
  const base = intOf(stat && stat.value);
  const target = statTargetOf(stat);
  return target ? applyModifiers(base, target, mods || []) : base;
}

// standStats — основы stat.<ключ> для стенда конструктора: значения
// характеристик листа без модификаторов. Две характеристики с одним ключом
// — берётся первая, как и при применении на листе.
export function standStats(sheet) {
  const out = {};
  for (const stat of (sheet && sheet.stats) || []) {
    const target = statTargetOf(stat);
    if (target && !(target in out)) out[target] = intOf(stat.value);
  }
  return out;
}

// initiativeFormula — формула броска инициативы из поля листа: русское «к»
// → «d», пробелы убраны; "" — поле пустое.
export function initiativeFormula(sheet) {
  return String((sheet && sheet.initiative) || "")
    .trim()
    .replace(/[кК]/g, "d")
    .replace(/\s+/g, "");
}

// initiativeBase — инициатива для стенда: число, если в поле число, иначе 0
// (формулу кубов стенд не бросает).
export function initiativeBase(sheet) {
  const s = initiativeFormula(sheet);
  return /^[+-]?\d+$/.test(s) ? parseInt(s, 10) : 0;
}
