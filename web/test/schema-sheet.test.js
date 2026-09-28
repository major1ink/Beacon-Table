// Раскладка листа по схеме (schema-layout.js): колонки чтения, вкладки
// правки, запись по пути. Сам рисовальщик (schema-sheet.js) требует DOM и
// проверяется вживую.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { deletePath, editTabs, formatNumber, formatSigned, getPath, setPath, viewColumns, visibleIn } from "../src/schema-layout.js";

const sheet = JSON.parse(readFileSync(new URL("../../internal/schema/builtin/sheet.json", import.meta.url), "utf8"));
const titles = (sections) => sections.map((s) => s.title || s.widget);

test("режим секции", () => {
  assert.ok(visibleIn({}, "view") && visibleIn({}, "edit"));
  assert.ok(visibleIn({ mode: "view" }, "view") && !visibleIn({ mode: "view" }, "edit"));
  assert.ok(!visibleIn({ mode: "edit" }, "view"));
});

test("встроенный лист: колонки чтения как у прежнего универсального листа", () => {
  const cols = viewColumns(sheet);
  assert.deepEqual(titles(cols[0]), ["hp", "Бой", "Состояния", "Ресурсы"]);
  assert.deepEqual(titles(cols[1]), ["Характеристики", "Броски"]);
  assert.deepEqual(titles(cols[2]), ["Инвентарь", "Деньги", "Способности", "Заметки"]);
});

test("встроенный лист: вкладки правки", () => {
  const tabs = editTabs(sheet);
  assert.deepEqual(tabs.map((t) => t.id), ["sheet", "inventory"]);
  const [sheetTab] = tabs;
  assert.deepEqual(titles(sheetTab.columns[0]), ["Хиты", "Бой", "Ресурсы"]);
  assert.deepEqual(titles(sheetTab.columns[1]), ["Характеристики", "Броски"]);
  assert.deepEqual(titles(sheetTab.columns[2]), ["Способности", "Заметки"]);
});

test("свои вкладки схемы: порядок, подпись, колонка по умолчанию", () => {
  const tabs = editTabs({
    layout: [
      { title: "A", fields: ["a"], tab: "magic" },
      { title: "B", fields: ["b"] },
      { title: "C", fields: ["c"], tab: "magic", tabTitle: "Магия", column: 3 },
      { title: "D", fields: ["d"], column: 9 },
      { title: "E", widget: "hp", mode: "view" },
    ],
  });
  assert.deepEqual(tabs.map((t) => [t.id, t.title]), [["magic", "Магия"], ["sheet", ""]]);
  assert.deepEqual(titles(tabs[0].columns[0]), ["A"]);
  assert.deepEqual(titles(tabs[0].columns[2]), ["C"]);
  assert.deepEqual(titles(tabs[1].columns[2]), ["D"]);
});

test("запись по пути создаёт объекты и списки", () => {
  const obj = {};
  setPath(obj, "combat.ac", 13);
  setPath(obj, "notes.0", "текст");
  setPath(obj, "a.b.c", 1);
  assert.deepEqual(obj, { combat: { ac: 13 }, notes: ["текст"], a: { b: { c: 1 } } });
  assert.equal(getPath(obj, "notes.0"), "текст");
  deletePath(obj, "a.b.c");
  assert.deepEqual(obj.a, { b: {} });
  deletePath(obj, "нет.такого");
});

test("числа на плитках", () => {
  assert.equal(formatNumber(3), "3");
  assert.equal(formatNumber(10.5), "10.5");
  assert.equal(formatNumber(1 / 3), "0.33");
  assert.equal(formatNumber(null), "—");
  assert.equal(formatSigned(2), "+2");
  assert.equal(formatSigned(-1), "-1");
  assert.equal(formatSigned(0), "+0");
});
