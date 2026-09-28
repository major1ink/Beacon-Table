// Карточка в списках по разделу list схемы (schema-list.js): подпись —
// общие случаи с сервером (internal/schema/testdata/eval-cases.json,
// subtitles), настройки каталога — группы, сортировка, фильтры, поиск.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { compileSchema } from "../src/schema-formula.js";
import { cardSubtitle, catalogConfig } from "../src/schema-list.js";

const readJSON = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const shared = readJSON("../../internal/schema/testdata/eval-cases.json").subtitles;

test("общие случаи: подпись по шаблону", () => {
  assert.ok(shared.length);
  for (const c of shared) {
    for (const [template, want] of c.cases) {
      const compiled = compileSchema({ ...c.schema, list: { subtitle: template } });
      assert.equal(cardSubtitle(compiled, c.data), want, `${c.name}: «${template}»`);
    }
  }
  assert.equal(cardSubtitle(null, { name: "x" }), "");
});

const spells = compileSchema(readJSON("../../internal/schema/builtin/spell.json"));
const cards = [
  { name: "Искра", level: 1, tags: ["огонь"], source: "Хоумбрю" },
  { name: "Буря", level: 3, tags: [] },
  { name: "Амулет", level: 1 },
  { name: "Без круга" },
];

test("встроенное заклинание: группы по кругу, сортировка, фильтр, поиск", () => {
  const cfg = catalogConfig(spells);
  assert.equal(cfg.subText(cards[0]), "1 круг");
  assert.equal(cfg.subText(cards[3]), "");
  assert.equal(cfg.badge(cards[0]), "Хоумбрю");
  assert.equal(cfg.flags, null);
  assert.equal(cfg.extraFilter, null);

  const groups = [...new Set(cards.map(cfg.groupKey))].sort(cfg.groupSort);
  assert.deepEqual(groups, [1, 3, ""]);
  assert.deepEqual(groups.map(cfg.groupLabel), ["Круг 1", "Круг 3", "Без значения: круг"]);

  assert.deepEqual([...cards].sort(cfg.rowSort).map((c) => c.name), ["Амулет", "Искра", "Буря", "Без круга"]);

  const [level] = cfg.sidebar;
  assert.equal(level.title, "Круг");
  assert.deepEqual(cards.flatMap(level.of), ["1", "3", "1"]);
  assert.deepEqual(["10", "3", "1"].sort(level.sort), ["1", "3", "10"]);

  assert.ok(cfg.searchHay(cards[0]).includes("огонь"));
});

test("фильтры по выбору, флажку, тексту, тегам и источнику", () => {
  const compiled = compileSchema({
    fields: {
      kind: { type: "select", path: "kind", label: "Вид", options: [{ value: "beast", label: "Зверь" }, { value: "undead", label: "Нежить" }] },
      flying: { type: "bool", path: "flying", label: "Летает" },
      home: { type: "text", path: "home", label: "Где живёт" },
    },
    list: { filters: ["kind", "flying", "home", "tags", "source", "nope"], group: "kind", sort: ["kind", "name"], search: ["home"] },
  });
  const cfg = catalogConfig(compiled);
  const [kind, flying, home, tags, source] = cfg.sidebar;
  assert.equal(cfg.sidebar.length, 5, "неизвестное поле фильтра пропускается");
  assert.equal(kind.kind, "chips");
  assert.deepEqual(kind.values, ["beast", "undead"]);
  assert.equal(kind.label("undead"), "Нежить");
  assert.equal(flying.kind, "toggles");
  assert.ok(flying.items[0].test({ flying: true }));
  assert.ok(!flying.items[0].test({ flying: false }));
  assert.deepEqual(home.of({ home: " болото " }), ["болото"]);
  assert.deepEqual(home.of({}), []);
  assert.deepEqual(tags.of({ tags: ["а", "б"] }), ["а", "б"]);
  assert.deepEqual(source.of({ source: "  " }), []);

  // Группы по выбору — в порядке вариантов схемы, подпись варианта.
  const list = [{ name: "Б", kind: "undead" }, { name: "А", kind: "beast" }, { name: "В" }];
  const keys = [...new Set(list.map(cfg.groupKey))].sort(cfg.groupSort);
  assert.deepEqual(keys.map(cfg.groupLabel), ["Зверь", "Нежить", "Без значения: вид"]);
  assert.deepEqual([...list].sort(cfg.rowSort).map((x) => x.name), ["А", "Б", "В"]);
  assert.ok(cfg.searchHay({ name: "Х", home: "болото" }).includes("болото"));
});

test("без группы — один список по сортировке", () => {
  const cfg = catalogConfig(compileSchema(readJSON("../../internal/schema/builtin/monster.json")));
  assert.equal(cfg.groupKey, null);
  assert.equal(cfg.subText({ hp: 12, ac: 13 }), "Хиты 12 · Защита 13");
  assert.equal(cfg.subText({ ac: 13 }), "Защита 13");
});
