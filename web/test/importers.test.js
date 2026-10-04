// Импортёры: какие системы понимает каждый и что у неизвестных нет.
import test from "node:test";
import assert from "node:assert/strict";

import { importerFits, importerInfo } from "../src/importers.js";

test("импорт D&D подходит обеим редакциям", () => {
  for (const id of ["foundry-dnd5e", "lss"]) {
    assert.equal(importerFits(id, "dnd5e-2014"), true);
    assert.equal(importerFits(id, "dnd5e-2024"), true);
  }
});

test("импорт D&D не подходит «Своей системе», чужой системе и до загрузки профиля", () => {
  for (const sys of ["custom", "luckworld", ""]) assert.equal(importerFits("lss", sys), false);
  assert.equal(importerFits("lss"), false);
});

test("неизвестный импортёр не подходит нигде", () => {
  assert.equal(importerFits("nope", "dnd5e-2024"), false);
  assert.equal(importerInfo("nope"), undefined);
});

test("предложение ведёт на систему, которую понимает импортёр", () => {
  const info = importerInfo("foundry-dnd5e");
  assert.ok(info.systems.includes(info.offer));
});
