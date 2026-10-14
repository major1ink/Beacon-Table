import test from "node:test";
import assert from "node:assert/strict";
import { mapFoundryRollTable } from "../src/rolltable-import.js";
import { parseRollTables, rowFor } from "../src/random-table.js";

test("RollTable из Foundry становится бросаемой таблицей", () => {
  const card = mapFoundryRollTable({
    name: "Слухи в таверне",
    description: "<p>Что болтают за кружкой.</p>",
    formula: "1d6",
    results: [
      { range: [3, 6], text: "<p>Мельник | <b>ведьма</b></p>" },
      { range: [1, 2], name: "Старый маяк снова горит" },
    ],
  });
  assert.equal(card.name, "Слухи в таверне");
  assert.deepEqual(card.tags, ["таблица"]);
  assert.ok(card.description.startsWith("Что болтают за кружкой."));
  const [t] = parseRollTables(card.description);
  assert.equal(t.formula, "1d6");
  assert.equal(rowFor(t, 2).text, "Старый маяк снова горит");
  assert.equal(rowFor(t, 5).text, "Мельник / ведьма");
});

test("формула не задана — кость по последнему диапазону", () => {
  const card = mapFoundryRollTable({ name: "Встречи", results: [{ range: [1, 10], text: "Волки" }, { range: [11, 12], text: "Огр" }] });
  assert.equal(parseRollTables(card.description)[0].formula, "1d12");
});
