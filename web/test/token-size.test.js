// token-size.test.js — привязка токена к сетке с учётом его размера.
import { test } from "node:test";
import assert from "node:assert/strict";
import { snapToGrid, tokenCells } from "../src/geometry.js";
import { tokenSizeCells } from "../src/system-profile.js";

const grid = { size: 50, offsetX: 10, offsetY: 20 };

test("нечётный токен встаёт в центр клетки", () => {
  assert.deepEqual(snapToGrid(70, 80, grid, 1), { x: 85, y: 95 });
  assert.deepEqual(snapToGrid(70, 80, grid, 3), { x: 85, y: 95 });
  assert.deepEqual(snapToGrid(70, 80, grid, 0.5), { x: 85, y: 95 });
});

test("чётный токен встаёт на пересечение линий", () => {
  assert.deepEqual(snapToGrid(70, 80, grid, 2), { x: 60, y: 70 });
  assert.deepEqual(snapToGrid(90, 100, grid, 4), { x: 110, y: 120 });
});

test("без размера ведёт себя как прежде", () => {
  assert.deepEqual(snapToGrid(70, 80, grid), { x: 85, y: 95 });
  assert.deepEqual(snapToGrid(70, 80, null, 2), { x: 70, y: 80 });
});

test("сторона токена в клетках", () => {
  assert.equal(tokenCells({ size: 50 }, grid), 2);
  assert.equal(tokenCells({ size: 25 }, grid), 1);
  assert.equal(tokenCells({}, grid), 1);
  assert.equal(tokenCells({ size: 48 }, null), 2);
});

test("размер токена по карточке и правилу системы", () => {
  const rule = { field: "size", table: { Большой: 2, Крошечный: 0.5 } };
  assert.equal(tokenSizeCells(rule, { size: "Большой" }), 2);
  assert.equal(tokenSizeCells(rule, { size: "  большой " }), 2);
  assert.equal(tokenSizeCells(rule, { size: "Крошечный" }), 0.5);
  assert.equal(tokenSizeCells(rule, { size: "Средний" }), 1);
  assert.equal(tokenSizeCells(rule, {}), 1);
  assert.equal(tokenSizeCells(null, { size: "Большой" }), 1);
  assert.equal(tokenSizeCells({ field: "extra.size", table: { Огромный: 3 } }, { extra: { size: "Огромный" } }), 3);
});