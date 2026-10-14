// Ключ свободной характеристики (stat.<ключ>) — зеркало domain.StatKey:
// кейсы повторяют internal/domain/modifier_targets_test.go, чтобы
// конструктор на клиенте и сервер давали один и тот же ключ.
import test from "node:test";
import assert from "node:assert/strict";

import { statKey, statTarget, statLabel, isStatTarget } from "../src/modifiers.js";

test("statKey совпадает с domain.StatKey", () => {
  const cases = {
    Сила: "сила",
    "  Удача  ночью ": "удача_ночью",
    "Сила (атлетика)!": "сила_атлетика",
    "HP-bonus_2": "hp-bonus_2",
    "": "",
    "!!!": "",
    ["а".repeat(40)]: "а".repeat(32),
  };
  for (const [name, want] of Object.entries(cases)) assert.equal(statKey(name), want, name);
});

test("цель и подпись характеристики", () => {
  assert.equal(statTarget("Удача"), "stat.удача");
  assert.equal(statTarget("  "), "");
  assert.equal(statLabel("stat.удача_ночью"), "Удача ночью");
  assert.ok(isStatTarget("stat.сила"));
  assert.ok(!isStatTarget("abilities.str"));
});
