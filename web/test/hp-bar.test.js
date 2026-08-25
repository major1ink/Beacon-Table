// Разбор быстрого ввода хитов и раскладка полоски (web/src/hp-bar.js) —
// общие для трекера ДМ и бланка персонажа, поэтому и проверяются отдельно
// от обоих. Сам жест перетаскивания требует DOM и сюда не попадает.
import test from "node:test";
import assert from "node:assert/strict";

import { parseQuickValue, hpFillRatios } from "../src/hp-bar.js";

test("«+5»/«-5» — изменение, «17» — абсолютное значение", () => {
  assert.deepEqual(parseQuickValue("+5", 10), { delta: 5, value: 15 });
  assert.deepEqual(parseQuickValue("-7", 10), { delta: -7, value: 3 });
  assert.deepEqual(parseQuickValue("17", 10), { delta: null, value: 17 });
});

test("типографский минус и пробелы из чата понимаются как обычные", () => {
  assert.deepEqual(parseQuickValue(" − 4 ", 10), { delta: -4, value: 6 });
  assert.deepEqual(parseQuickValue("–4", 10), { delta: -4, value: 6 });
});

test("мусор и пустое поле не применяются", () => {
  for (const raw of ["", "  ", "abc", "+", "-", "5к6", "1.5"]) {
    assert.equal(parseQuickValue(raw, 10), null, `«${raw}» не должно применяться`);
  }
});

// Доли сравниваем округлёнными: 1 − 0.8 в двоичной арифметике даёт
// 0.19999999999999996, а на вёрстку это не влияет — ширина уходит в CSS
// через toFixed(1).
const pct = (r) => ({ hp: +(r.hp * 100).toFixed(1), temp: +(r.temp * 100).toFixed(1) });

test("хвост временных хитов не вылезает за край полоски", () => {
  assert.deepEqual(pct(hpFillRatios({ current: 5, temp: 0, max: 10 })), { hp: 50, temp: 0 });
  assert.deepEqual(pct(hpFillRatios({ current: 5, temp: 2, max: 10 })), { hp: 50, temp: 20 });
  // Временных хитов больше, чем осталось места, — хвост упирается в край.
  assert.deepEqual(pct(hpFillRatios({ current: 8, temp: 30, max: 10 })), { hp: 80, temp: 20 });
});

test("хиты сверх максимума и уход в минус полоску не ломают", () => {
  assert.deepEqual(pct(hpFillRatios({ current: 14, temp: 0, max: 10 })), { hp: 100, temp: 0 });
  assert.deepEqual(pct(hpFillRatios({ current: -3, temp: 4, max: 10 })), { hp: 0, temp: 40 });
  assert.deepEqual(pct(hpFillRatios({ current: 5, temp: 5, max: 0 })), { hp: 0, temp: 0 });
});
