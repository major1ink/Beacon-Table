import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCell, cellText } from "../src/stat-editor.js";

// Грамматика ячейки статблока: голое число — поставить, знак — прибавить,
// >=/<= — границы, «/ур» — за уровень, кубы — только в «Хиты в ход».
test("parseCell: режимы и суффикс за уровень", () => {
  assert.deepEqual(parseCell("10"), { mode: "set", value: "10", perLevel: false });
  assert.deepEqual(parseCell("−2"), { mode: "add", value: "-2", perLevel: false });
  assert.deepEqual(parseCell(">=10"), { mode: "min", value: "10", perLevel: false });
  assert.deepEqual(parseCell("≤5"), { mode: "max", value: "5", perLevel: false });
  assert.deepEqual(parseCell("-5/ур"), { mode: "add", value: "-5", perLevel: true });
  assert.ok(parseCell("=5/ур").bad, "«за уровень» только с прибавкой");
  assert.ok(parseCell("−1к6").bad, "кубы вне строки хитов — ошибка");
  assert.deepEqual(parseCell("-1d6", { dice: true }), { mode: "add", value: "-1к6" });
  assert.equal(parseCell(""), null);
});

test("cellText: обратная запись", () => {
  assert.equal(cellText({ mode: "add", value: "-5", perLevel: true }), "−5/ур");
  assert.equal(cellText({ mode: "set", value: "0" }), "=0");
  assert.equal(cellText({ mode: "min", value: "10" }), "≥10");
});
