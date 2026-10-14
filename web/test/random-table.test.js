import test from "node:test";
import assert from "node:assert/strict";
import { parseRollTables, rowFor, hasRollTable } from "../src/random-table.js";

test("случайная таблица: кость в заголовке, числа и диапазоны", () => {
  const md = `# Погода

| к8 | Погода | Эффект |
|---|---|:-:|
| 1–2 | **Ясно** | — |
| 3-5 | Дождь | помеха на Внимательность |
| 6 | Гроза | |
| 7 — 8 | Туман | слабо заслонено |

Текст после.`;
  const [t] = parseRollTables(md);
  assert.equal(t.formula, "1d8");
  assert.deepEqual(t.columns, ["Погода", "Эффект"]);
  assert.equal(t.rows.length, 4);
  assert.equal(rowFor(t, 1).text, "Ясно · —");
  assert.equal(rowFor(t, 4).text, "Дождь · помеха на Внимательность");
  assert.equal(rowFor(t, 6).text, "Гроза");
  assert.equal(rowFor(t, 8).text, "Туман · слабо заслонено");
  assert.equal(rowFor(t, 9), null);
});

test("d100: 00 — это 100, несколько таблиц в тексте", () => {
  const md = "| d100 | Находка |\n|---|---|\n| 01-50 | Ничего |\n| 51-99 | Монета |\n| 00 | Клад |\n\n| 2d6 | Встреча |\n|--|--|\n| 2 | Дракон |";
  const [a, b] = parseRollTables(md);
  assert.equal(rowFor(a, 100).text, "Клад");
  assert.equal(rowFor(a, 7).text, "Ничего");
  assert.equal(b.formula, "2d6");
});

test("обычная таблица — не случайная", () => {
  const md = "| Задача | Сл. |\n|---|---|\n| Лёгкая | 10 |";
  assert.deepEqual(parseRollTables(md), []);
  assert.equal(hasRollTable(md), false);
  assert.equal(hasRollTable("<table><tr><th>d6</th><th>Имя</th></tr><tr><td>1</td><td>Ведана</td></tr></table>"), true);
});
