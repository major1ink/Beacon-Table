// fog-shapes.test.js — фигуры зон тумана (см. geometry.js: fogAreaHandles /
// moveFogHandle / snapToFogVertex / fogEdgeNear): прямоугольник после драга
// угла остаётся прямоугольником, круг — кругом, а у многоугольника двигается
// ровно одна вершина.
import test from "node:test";
import assert from "node:assert/strict";
import {
  FOG_CIRCLE_SEGMENTS,
  fogCirclePoints,
  fogRectPoints,
  fogAreaHandles,
  moveFogHandle,
  fogVertexNear,
  fogEdgeNear,
  snapToFogVertex,
  fogAreaAt,
} from "../src/geometry.js";

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test("угол прямоугольника тянет соседей, противоположный стоит", () => {
  const area = { shape: "rect", points: fogRectPoints(0, 0, 100, 50) };
  const moved = moveFogHandle(area, 2, 140, 90); // правый-нижний
  assert.deepEqual(moved, fogRectPoints(0, 0, 140, 90));
  // Перетянули за противоположный угол — фигура «переворачивается», но остаётся прямоугольником.
  const flipped = moveFogHandle(area, 2, -20, -10);
  assert.deepEqual(flipped, fogRectPoints(-20, -10, 0, 0));
});

test("ручка круга меняет радиус, центр остаётся", () => {
  const area = { shape: "circle", points: fogCirclePoints(300, 200, 50) };
  assert.equal(fogAreaHandles(area).length, 4);
  const moved = moveFogHandle(area, 0, 400, 200);
  assert.equal(moved.length, FOG_CIRCLE_SEGMENTS);
  for (const p of moved) assert.ok(near(Math.hypot(p.x - 300, p.y - 200), 100), "вершина сошла с окружности");
});

test("у многоугольника двигается только одна вершина", () => {
  const area = { shape: "poly", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] };
  const moved = moveFogHandle(area, 1, 20, 5);
  assert.deepEqual(moved, [{ x: 0, y: 0 }, { x: 20, y: 5 }, { x: 10, y: 10 }]);
  assert.deepEqual(area.points[1], { x: 10, y: 0 }, "исходный контур изменён на месте");
});

test("ручки ищутся по фигуре: у круга — только четыре осевые", () => {
  const areas = { c: { shape: "circle", points: fogCirclePoints(0, 0, 100) } };
  assert.ok(fogVertexNear(100, 0, areas, 1), "осевая ручка не найдена");
  // Вершина под 10° — не ручка, за неё не схватиться.
  const a = (1 / FOG_CIRCLE_SEGMENTS) * Math.PI * 2;
  assert.equal(fogVertexNear(Math.cos(a) * 100, Math.sin(a) * 100, areas, 1), null);
});

test("сторона многоугольника — точка врезки; у прямоугольника и круга сторон нет", () => {
  const areas = {
    p: { shape: "poly", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }] },
    r: { shape: "rect", points: fogRectPoints(200, 0, 300, 100) },
  };
  const edge = fogEdgeNear(50, 3, areas, 1);
  assert.equal(edge.areaId, "p");
  assert.equal(edge.index, 1);
  assert.ok(near(edge.x, 50) && near(edge.y, 0), "точка врезки не на стороне");
  assert.equal(fogEdgeNear(250, 3, areas, 1), null);
});

test("прилипание к вершинам других зон, но не к самой тащимой ручке", () => {
  const areas = {
    a: { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }] },
    b: { points: [{ x: 105, y: 3 }, { x: 200, y: 0 }, { x: 200, y: 100 }] },
  };
  assert.deepEqual(snapToFogVertex(103, 1, areas, 1, { areaId: "b", index: 0 }), { x: 100, y: 0 });
  assert.equal(snapToFogVertex(500, 500, areas, 1), null);
});

test("вложенные зоны: кликом берётся нарисованная позже", () => {
  const areas = {
    outer: { points: fogRectPoints(0, 0, 100, 100) },
    inner: { points: fogRectPoints(40, 40, 60, 60) },
  };
  assert.equal(fogAreaAt(50, 50, areas), "inner");
  assert.equal(fogAreaAt(10, 10, areas), "outer");
});
