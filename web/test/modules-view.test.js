import test from "node:test";
import assert from "node:assert/strict";

import { canInstall, canRemove, filterModules, formatSize, marks, mergeModules } from "../src/modules-view.js";

const entries = [
  { id: "dnd5e-2024", title: "D&D 5e (2024)", type: "system", version: "1.0.1", installed: "1.0.0", updatable: true, compatible: true, size: 27839 },
  { id: "dnd5e-2024-srd", title: "SRD 5.2", type: "content", version: "1.0.0", compatible: true, size: 1632534, description: "Существа и заклинания" },
  { id: "future", title: "Будущий", type: "content", version: "2.0.0", compatible: false },
];
const installed = [
  { id: "dnd5e-2024", title: "D&D 5e (2024)", type: "system", version: "1.0.0", source: "builtin", counts: { conditions: 21 } },
  { id: "mine", title: "Моё", type: "content", version: "0.1.0", source: "installed", counts: { bestiary: 2 } },
];

test("слияние каталога и установленного", () => {
  const items = mergeModules(entries, installed);
  assert.deepEqual(items.map((i) => i.id), ["dnd5e-2024", "dnd5e-2024-srd", "future", "mine"]);
  const sys = items[0];
  assert.equal(sys.installedVersion, "1.0.0");
  assert.equal(sys.source, "builtin");
  assert.deepEqual(sys.counts, { conditions: 21 });
  assert.equal(items[3].inCatalog, false);
  assert.equal(items[3].installedVersion, "0.1.0");
});

test("вкладки, виды и поиск", () => {
  const items = mergeModules(entries, installed);
  const ids = (f) => filterModules(items, f).map((i) => i.id);
  assert.deepEqual(ids({ tab: "available", kind: "all", query: "" }), ["dnd5e-2024", "dnd5e-2024-srd", "future"]);
  assert.deepEqual(ids({ tab: "installed", kind: "all", query: "" }), ["dnd5e-2024", "mine"]);
  assert.deepEqual(ids({ tab: "available", kind: "system", query: "" }), ["dnd5e-2024"]);
  assert.deepEqual(ids({ tab: "available", kind: "all", query: " заклинан " }), ["dnd5e-2024-srd"]);
  assert.deepEqual(ids({ tab: "available", kind: "content", query: "SRD" }), ["dnd5e-2024-srd"]);
});

test("кнопки и отметки", () => {
  const items = mergeModules(entries, installed);
  const [sys, srd, future, mine] = items;
  assert.equal(canInstall(sys), true);
  assert.equal(canInstall(srd), true);
  assert.equal(canInstall(future), false);
  assert.equal(canInstall(mine), false);
  assert.deepEqual(marks(sys), [{ text: "Есть обновление", kind: "update" }]);
  assert.deepEqual(marks(mine), [{ text: "Установлен", kind: "on" }]);
  assert.deepEqual(marks(future), [{ text: "Нужно обновить программу", kind: "warn" }]);
  assert.equal(canRemove(mine), true);
  assert.equal(canRemove(sys), false);
});

test("размер", () => {
  assert.equal(formatSize(0), "");
  assert.equal(formatSize(900), "900 Б");
  assert.equal(formatSize(27839), "27 КБ");
  assert.equal(formatSize(1632534), "1,6 МБ");
});
