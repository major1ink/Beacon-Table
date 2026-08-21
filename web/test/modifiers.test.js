// modifiers.test.js — применение изменений на клиенте (web/src/modifiers.js)
// и его ПАРИТЕТ с сервером.
//
// Зачем паритет отдельным пунктом: одну и ту же арифметику считают двое —
// сервер для эффективного КД бойца в трекере (internal/service/room_statuses.go:
// effectiveStat) и лист персонажа на месте, без похода на сервер (см.
// pages/character-sheet.js). Разойдись они хоть в одном правиле (порядок
// применения, «несколько set — какой побеждает»), и в трекере у монстра был
// бы один КД, а у игрока в листе — другой. Кейсы ниже намеренно повторяют
// internal/service/modifiers_test.go один в один: если правку внесли только
// в один из двух файлов, падать должно здесь.
import test from "node:test";
import assert from "node:assert/strict";

const { applyModifiers, explainModifiers, collectModifiers, formatModifier, parseValue } = await import(
  "../src/modifiers.js"
);
const { mapFoundryChanges, mapFoundryEffect } = await import("../src/condition-import.js");

const m = (target, mode, value, extra) => Object.assign({ target, mode, value, period: "" }, extra || {});

test("порядок применения не зависит от порядка записей (паритет с domain.ApplyModifiers)", () => {
  const shieldFirst = [m("ac", "add", "2"), m("ac", "set", "14")];
  const armorFirst = [m("ac", "set", "14"), m("ac", "add", "2")];
  assert.equal(applyModifiers(11, "ac", shieldFirst), 16);
  assert.equal(applyModifiers(11, "ac", armorFirst), 16);
});

test("«не выше» перебивает прибавку, «не ниже» не опускает", () => {
  assert.equal(applyModifiers(30, "speed", [m("speed", "add", "10"), m("speed", "max", "0")]), 0);
  assert.equal(applyModifiers(12, "ac", [m("ac", "min", "15")]), 15);
  assert.equal(applyModifiers(18, "ac", [m("ac", "min", "15")]), 18);
});

test("чужая цель, периодический и формула кубов не считаются", () => {
  const mods = [
    m("speed", "add", "10"),
    m("hp.current", "add", "-1d6", { period: "turn-start" }),
    m("ac", "add", "1к6"),
    m("ac", "add", "2"),
  ];
  assert.equal(applyModifiers(10, "ac", mods), 12);
});

test("при двух «заменить на» побеждает наименьший", () => {
  assert.equal(applyModifiers(10, "ac", [m("ac", "set", "18"), m("ac", "set", "14")]), 14);
});

test("parseValue принимает только целые со знаком", () => {
  assert.equal(parseValue(" -2 "), -2);
  assert.equal(parseValue("+3"), 3);
  assert.equal(parseValue("1d6"), null);
  assert.equal(parseValue(""), null);
  assert.equal(parseValue(undefined), null);
});

test("collectModifiers подписывает источник, explainModifiers это показывает", () => {
  const mods = collectModifiers([
    { name: "Кольчуга", modifiers: [m("ac", "set", "14")] },
    { name: "Щит", modifiers: [m("ac", "add", "2")] },
    { name: "Порча", modifiers: [m("ac", "add", "-2")] },
  ]);
  assert.equal(applyModifiers(11, "ac", mods), 14);
  assert.deepEqual(explainModifiers("ac", mods), ["ставит 14 — Кольчуга", "+2 — Щит", "-2 — Порча"]);
});

test("formatModifier читается человеком", () => {
  assert.equal(formatModifier(m("ac", "add", "2", { note: "щит" }), "КД"), "КД +2 (щит)");
  assert.equal(formatModifier(m("speed", "set", "0"), "Скорость"), "Скорость → 0");
  assert.equal(
    formatModifier(m("hp.current", "add", "-1к6", { period: "turn-start", note: "огонь" }), "Текущие хиты"),
    "Текущие хиты -1к6 в начале хода (огонь)"
  );
});

// ---- разбор changes[] из Foundry ----

test("changes[] делятся на применяемые модификаторы и текстовый остаток", () => {
  const { modifiers, leftover } = mapFoundryChanges([
    { key: "system.attributes.ac.bonus", mode: 2, value: "-2" }, // ADD → наш add
    { key: "system.attributes.movement.walk", mode: 5, value: "0" }, // OVERRIDE → set
    { key: "system.abilities.str.value", mode: 4, value: "19" }, // UPGRADE → min
    { key: "system.bonuses.All-Attacks.attack", mode: 2, value: "-2" }, // нашей цели нет
    { key: "system.attributes.ac.bonus", mode: 1, value: "2" }, // MULTIPLY не поддерживаем
    { key: "system.attributes.ac.bonus", mode: 2, value: "@abilities.dex.mod" }, // формула Foundry
  ]);
  assert.deepEqual(
    modifiers.map((x) => `${x.target}/${x.mode}/${x.value}`),
    ["ac/add/-2", "speed/set/0", "abilities.str/min/19"]
  );
  assert.equal(leftover.length, 3, "неподдерживаемое должно уйти в текстовую механику, а не пропасть");
});

test("импорт эффекта заполняет и модификаторы, и остаток текстом", () => {
  const card = mapFoundryEffect({
    name: "Slowed",
    statuses: ["slowed"],
    duration: { rounds: 2 },
    changes: [
      { key: "system.attributes.movement.walk", mode: 5, value: "15" },
      { key: "system.bonuses.abilities.save", mode: 2, value: "-2" },
    ],
  });
  assert.deepEqual(
    card.modifiers.map((x) => `${x.target}/${x.mode}/${x.value}`),
    ["speed/set/15"]
  );
  assert.equal(card.mechanics, "спасброски: прибавить -2");
  assert.equal(card.defaultRounds, 2);
});
