// Разовые подсказки режима обучения (см. web/src/tutorial.js: tourHintOnce,
// clearTourProgress).
import test from "node:test";
import assert from "node:assert/strict";

// localStorage в node нет — минимальная замена с тем же API, что использует
// модуль.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  key: (i) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
};

// tooltip.js (зависимость модуля) вешает слушатели на window/document при
// загрузке — заглушки, как в ws-reconnect.test.js.
globalThis.window = { addEventListener() {} };
globalThis.document = { addEventListener() {} };

const { tourHintOnce, clearTourProgress } = await import("../src/tutorial.js");

test("tourHintOnce показывает подсказку один раз", () => {
  store.clear();
  assert.equal(tourHintOnce("resize-teleport"), true);
  assert.equal(tourHintOnce("resize-teleport"), false);
  // другой ключ — своя подсказка
  assert.equal(tourHintOnce("resize-noteMarker"), true);
});

test("clearTourProgress забывает шаг и показанные подсказки", () => {
  store.clear();
  tourHintOnce("resize-teleport");
  store.set("bt.tutorial.step.dm", "5");
  store.set("unrelated", "x");
  clearTourProgress("dm");
  assert.equal(tourHintOnce("resize-teleport"), true);
  assert.equal(store.has("bt.tutorial.step.dm"), false);
  assert.equal(store.get("unrelated"), "x");
});
