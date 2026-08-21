// modifiers.js — применение модификаторов (см. internal/domain/modifier.go)
// на клиенте: эффективный КД/скорость/характеристики на листе персонажа с
// учётом НАДЕТОЙ экипировки и висящих состояний.
//
// ПОЧЕМУ ЭТО КОПИЯ, А НЕ ОДИН КОД С СЕРВЕРОМ. Тот же случай, что и у
// расчёта модификаторов характеристик и бонуса владения (см.
// pages/character-sheet.js: rules-блок): лист персонажа считает свои
// производные числа на месте, на каждый ввод в поле, без похода на сервер —
// иначе КД переставал бы обновляться, пока идёт debounce-автосейв. Сервер
// считает то же самое для трекера инициативы (эффективный КД бойца), и обе
// стороны обязаны давать один и тот же ответ, поэтому порядок применения
// здесь буквально повторяет domain.ApplyModifiers: set → add → min → max.
// Любая правка одного файла требует правки второго — об этом сказано в
// обоих.

export const MODE_ADD = "add";
export const MODE_SET = "set";
export const MODE_MIN = "min";
export const MODE_MAX = "max";

export const PERIOD_NONE = "";
export const PERIOD_TURN_START = "turn-start";
export const PERIOD_TURN_END = "turn-end";

// Цели, которые нужны лично этому модулю для форматирования (полный список
// с подписями приходит с сервера, см. GET /api/modifier-targets и
// modifier-editor.js — дублировать его тут незачем).
export const TARGET_AC = "ac";
export const TARGET_SPEED = "speed";
export const TARGET_HP_MAX = "hp.max";
export const TARGET_HP_CURRENT = "hp.current";
export const TARGET_INITIATIVE = "initiative";
export const ABILITY_TARGETS = {
  str: "abilities.str",
  dex: "abilities.dex",
  con: "abilities.con",
  int: "abilities.int",
  wis: "abilities.wis",
  cha: "abilities.cha",
};

// parseValue — Value как целое число; null у формулы кубов и у мусора
// (зеркало domain.ParseModifierValue).
export function parseValue(value) {
  const s = String(value ?? "").trim();
  if (!/^[+-]?\d+$/.test(s)) return null;
  return parseInt(s, 10);
}

// applyModifiers — база плюс все ПОСТОЯННЫЕ модификаторы указанной цели.
// Зеркало domain.ApplyModifiers, включая порядок и правило «несколько set —
// побеждает наименьший».
export function applyModifiers(base, target, mods) {
  let result = base;
  let setDone = false;
  let add = 0;
  let minVal = null;
  let maxVal = null;

  for (const m of mods || []) {
    if (!m || m.target !== target || (m.period || PERIOD_NONE) !== PERIOD_NONE) continue;
    const v = parseValue(m.value);
    if (v === null) continue;
    switch (m.mode) {
      case MODE_ADD:
        add += v;
        break;
      case MODE_SET:
        if (!setDone || v < result) {
          result = v;
          setDone = true;
        }
        break;
      case MODE_MIN:
        minVal = minVal === null ? v : Math.max(minVal, v);
        break;
      case MODE_MAX:
        maxVal = maxVal === null ? v : Math.min(maxVal, v);
        break;
      default:
        break;
    }
  }

  result += add;
  if (minVal !== null && result < minVal) result = minVal;
  if (maxVal !== null && result > maxVal) result = maxVal;
  return result;
}

// hasModifiersFor — есть ли что применять к этой цели: UI по этому решает,
// показывать ли рядом с числом расшифровку «откуда оно взялось».
export function hasModifiersFor(target, mods) {
  return (mods || []).some(
    (m) => m && m.target === target && (m.period || PERIOD_NONE) === PERIOD_NONE && parseValue(m.value) !== null
  );
}

// collectModifiers — собрать модификаторы из нескольких источников в один
// плоский список. Источник — объект с полем modifiers (карточка предмета,
// наложенная метка) плюс подпись, откуда он: подпись попадает в расшифровку
// («+2 — Щит»), поэтому её проставляем здесь, а не тянем потом обратно.
export function collectModifiers(sources) {
  const out = [];
  for (const src of sources || []) {
    if (!src || !Array.isArray(src.modifiers)) continue;
    for (const m of src.modifiers) {
      if (!m) continue;
      out.push(Object.assign({}, m, { sourceName: src.name || m.note || "" }));
    }
  }
  return out;
}

// explainModifiers — расшифровка «из чего сложилось число» для подсказки:
// [{text: "+2 — Щит"}, ...]. Порядок — как в списке; режимы кроме add
// подписываются словом, потому что «14 — Кольчуга» без пояснения читается
// как прибавка.
const MODE_WORDS = { [MODE_SET]: "ставит", [MODE_MIN]: "не ниже", [MODE_MAX]: "не выше" };

export function explainModifiers(target, mods) {
  const out = [];
  for (const m of mods || []) {
    if (!m || m.target !== target || (m.period || PERIOD_NONE) !== PERIOD_NONE) continue;
    const v = parseValue(m.value);
    if (v === null) continue;
    const num = m.mode === MODE_ADD ? (v >= 0 ? "+" + v : String(v)) : `${MODE_WORDS[m.mode] || ""} ${v}`.trim();
    const from = m.sourceName || m.note || "";
    out.push(from ? `${num} — ${from}` : num);
  }
  return out;
}

// formatModifier — одна запись человеческим текстом для карточки состояния/
// предмета («КД +2», «Скорость ставит 0», «Текущие хиты 1к6 в начале хода»).
// targetLabel приходит из справочника целей (см. /api/modifier-targets).
export function formatModifier(m, targetLabel) {
  const label = targetLabel || m.target;
  const value = String(m.value ?? "").trim();
  const period =
    m.period === PERIOD_TURN_START ? " в начале хода" : m.period === PERIOD_TURN_END ? " в конце хода" : "";
  // «заменить на» в описании читается тяжело («Скорость заменить на 0»),
  // поэтому у set тут стрелка — «Скорость → 0». В расшифровке слагаемых
  // (explainModifiers) наоборот нужно слово: там строка начинается с
  // самого значения, и стрелка в начале ни на что не указывала бы.
  let body;
  if (m.mode === MODE_ADD) {
    body = /^[+-]/.test(value) ? value : "+" + value;
  } else if (m.mode === MODE_SET) {
    body = "→ " + value;
  } else {
    body = `${MODE_WORDS[m.mode] || m.mode} ${value}`;
  }
  return `${label} ${body}${period}${m.note ? ` (${m.note})` : ""}`;
}
