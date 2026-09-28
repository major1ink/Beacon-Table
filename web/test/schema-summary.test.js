// Существо или персонаж «в двух строках» по схеме (schema-summary.js):
// общие поля ядра, короткие плитки характеристик и боевая часть для
// попапа «чем ходит монстр».
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { compileSchema } from "../src/schema-formula.js";
import { compactStats, coreSummary, peekSections } from "../src/schema-summary.js";

const readJSON = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const monster = compileSchema(readJSON("../../internal/schema/builtin/monster.json"));
const sheet = compileSchema(readJSON("../../internal/schema/builtin/sheet.json"));

const wolf = {
  hp: 11,
  ac: 13,
  speed: "40 фт.",
  initiative: "1к20 + @stat.ловкость",
  stats: [{ name: "Ловкость", value: 2, mod: 1 }, { name: "", value: 5 }, { name: "Сила", value: 3 }],
  rolls: [{ name: "Укус", formula: "2к4+2" }],
  traits: "Чутьё",
};

test("встроенное существо: общие поля ядра", () => {
  assert.deepEqual(coreSummary(monster, wolf, []), { hp: "11", hpMax: "11", ac: "13", speed: "40 фт.", initiative: "1d20+2" });
  assert.deepEqual(coreSummary(monster, {}, []), { hp: "", hpMax: "", ac: "", speed: "", initiative: "" });
});

test("встроенный лист: хиты сейчас и макс., модификаторы защиты", () => {
  const hero = { combat: { hpCurrent: 7, hpMax: 12, ac: 14, speed: 30 } };
  const ring = [{ target: "ac", mode: "add", value: "1", source: "Кольцо" }];
  const got = coreSummary(sheet, hero, ring);
  assert.equal(got.hp, "7");
  assert.equal(got.hpMax, "12");
  assert.equal(got.speed, "30");
  assert.equal(got.ac, "15", "защита — с модификатором кольца");
});

test("плитки: свободные характеристики с прочими колонками, пустые имена выпадают", () => {
  assert.deepEqual(
    compactStats(monster, wolf, []).map(({ label, value, note }) => ({ label, value, note })),
    [
      { label: "Ловкость", value: "2", note: "+1" },
      { label: "Сила", value: "3", note: "" },
    ]
  );
  assert.deepEqual(compactStats(null, wolf, []), []);
});

const dnd = compileSchema({
  format: "beacon-schema/v1",
  kind: "monster",
  core: { "hp.max": "hp", ac: "ac", initiative: "ini" },
  fields: {
    hp: { type: "number", path: "hp", label: "Хиты" },
    ac: { type: "number", path: "ac", label: "КД" },
    ini: { type: "computed", formula: "@dex_mod", label: "Инициатива" },
    dex: { type: "number", path: "abilities.dex", label: "Ловкость", short: "Лов" },
    dex_mod: { type: "computed", formula: "floor((@dex - 10) / 2)", label: "Мод. Ловкости" },
    speed: { type: "text", path: "speed", label: "Скорость" },
    bite: { type: "roll", roll: "1d20 + @dex_mod", label: "Укус" },
    actions: { type: "longtext", path: "actions", label: "Действия" },
  },
  layout: [
    { title: "Бой", fields: ["hp", "ac", "ini", "speed"] },
    { title: "Характеристики", fields: ["dex", "dex_mod"] },
    { title: "Атаки", fields: ["bite", "actions"] },
    { title: "Добыча", widget: "inventory" },
    { title: "Правка", fields: ["hp"], mode: "edit" },
  ],
});

test("поля с short — плитки, инициатива-число — со знаком", () => {
  const goblin = { hp: 7, ac: 15, abilities: { dex: 14 } };
  assert.deepEqual(compactStats(dnd, goblin, []).map(({ label, value }) => ({ label, value })), [{ label: "Лов", value: "14" }]);
  assert.equal(coreSummary(dnd, goblin, []).initiative, "+2");
});

test("боевая часть попапа: без полей трекера, плиток и виджетов", () => {
  assert.deepEqual(peekSections(dnd), [
    { title: "Бой", fields: ["speed"] },
    { title: "Характеристики", fields: ["dex_mod"] },
    { title: "Атаки", fields: ["bite", "actions"] },
  ]);
  assert.deepEqual(
    peekSections(monster).map((s) => s.title),
    ["Бой", "Броски", "Способности"]
  );
  assert.deepEqual(peekSections(null), []);
});
