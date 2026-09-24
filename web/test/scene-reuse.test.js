// Переиспользование нетронутых разделов сцены между снапшотами (см. web/src/vtt/dirty.js).
import test from "node:test";
import assert from "node:assert/strict";

import { createDirtyFlags, diffAndMarkDirty, reuseUnchanged } from "../src/vtt/dirty.js";

const scene = () => JSON.parse(JSON.stringify({
  id: "s1",
  width: 100,
  height: 100,
  tokens: { a: { x: 1, y: 2 } },
  walls: { w: { points: [0, 0, 10, 10] } },
  fogAreas: {},
  grid: { size: 50, offsetX: 0, offsetY: 0 },
}));

function clean() {
  const d = createDirtyFlags();
  for (const k of Object.keys(d)) d[k] = false;
  return d;
}

test("эхо хода токена не перестраивает стены, сетку и туман", () => {
  const prev = scene();
  const next = scene();
  next.tokens.a.x = 5;
  reuseUnchanged(prev, next);
  assert.equal(next.walls, prev.walls);
  assert.equal(next.grid, prev.grid);
  assert.notEqual(next.tokens, prev.tokens);

  const dirty = clean();
  diffAndMarkDirty(dirty, prev, next);
  assert.equal(dirty.tokens, true);
  assert.equal(dirty.walls, false);
  assert.equal(dirty.grid, false);
  assert.equal(dirty.manualFog, false);
});

test("совпавший с локальной правкой снапшот ничего не помечает", () => {
  const prev = scene();
  prev.tokens.a.x = 5; // перетаскивание уже сдвинуло токен на месте
  const next = scene();
  next.tokens.a.x = 5;
  reuseUnchanged(prev, next);
  const dirty = clean();
  diffAndMarkDirty(dirty, prev, next);
  assert.equal(dirty.tokens, false);
  assert.equal(dirty.vision, false);
});

test("без прошлой сцены ничего не подменяется", () => {
  const next = scene();
  const walls = next.walls;
  reuseUnchanged(null, next);
  assert.equal(next.walls, walls);
});
