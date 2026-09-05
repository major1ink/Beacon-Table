// drawing-hit-test.test.js — попадание ПКМ по пометке слоя рисования
// (см. geometry.drawingAt, vtt/layers/drawings.js).
//
// Стереть пометку можно только попав по ней курсором или пальцем, а
// пометка — это линия толщиной в несколько пикселей: без запаса вокруг
// штриха стереть свою стрелку было бы упражнением в меткости. Тест держит
// три вещи, на которых это ломается: сам запас (половина толщины + slack в
// ЭКРАННЫХ px, то есть зависящий от зума), порядок разбора стопки (сверху
// вниз — стираем то, что нарисовано последним) и фильтр прав (игрок ловит
// только свои элементы).
import test from "node:test";
import assert from "node:assert/strict";
import { drawingAt } from "../src/geometry.js";

const line = {
  id: "line",
  kind: "line",
  width: 4,
  points: [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ],
};

test("клик рядом с линией попадает в неё, вдалеке — нет", () => {
  const drawings = { line };
  // Половина толщины (2) + запас 8 экранных px при scale=1.
  assert.equal(drawingAt(50, 9, drawings, 1), "line");
  assert.equal(drawingAt(50, 40, drawings, 1), null);
});

test("запас берётся в экранных пикселях — на зуме он сужается", () => {
  const drawings = { line };
  // scale=4: те же 8 экранных px — это уже 2 мировых, и точка на 9 мировых
  // px от линии перестаёт по ней попадать.
  assert.equal(drawingAt(50, 9, drawings, 4), null);
  assert.equal(drawingAt(50, 3, drawings, 4), "line");
});

test("из стопки достаётся то, что нарисовано последним", () => {
  const drawings = {
    lower: { id: "lower", kind: "line", width: 4, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
    upper: { id: "upper", kind: "line", width: 4, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
  };
  assert.equal(drawingAt(50, 0, drawings, 1), "upper");
});

test("фильтр прав: игрок ловит только свои пометки", () => {
  const drawings = {
    mine: { id: "mine", kind: "line", width: 4, authorId: "acc-1", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
    dm: { id: "dm", kind: "line", width: 4, points: [{ x: 0, y: 50 }, { x: 100, y: 50 }] },
  };
  const own = (d) => d.authorId === "acc-1";
  assert.equal(drawingAt(50, 0, drawings, 1, 8, own), "mine");
  // Пометка ДМ лежит ровно под курсором, но игроку она недоступна.
  assert.equal(drawingAt(50, 50, drawings, 1, 8, own), null);
});

test("круг ловится по самой окружности, а не по заливке", () => {
  const drawings = {
    ring: { id: "ring", kind: "circle", width: 4, points: [{ x: 0, y: 0 }, { x: 50, y: 0 }] },
  };
  assert.equal(drawingAt(50, 0, drawings, 1), "ring");
  // Центр круга — пустое место: круг рисуется контуром, и клик по «дырке»
  // не должен стирать его (иначе большой круг накрыл бы собой всё, что под ним).
  assert.equal(drawingAt(0, 0, drawings, 1), null);
});

test("прямоугольник ловится по рамке, а не по площади", () => {
  const drawings = {
    box: { id: "box", kind: "rect", width: 4, points: [{ x: 0, y: 0 }, { x: 100, y: 60 }] },
  };
  assert.equal(drawingAt(100, 30, drawings, 1), "box");
  assert.equal(drawingAt(50, 30, drawings, 1), null);
});

test("подпись ловится прямоугольником вокруг своего центра", () => {
  const drawings = {
    label: { id: "label", kind: "text", width: 20, text: "ловушка", points: [{ x: 0, y: 0 }] },
  };
  assert.equal(drawingAt(0, 0, drawings, 1), "label");
  assert.equal(drawingAt(0, 200, drawings, 1), null);
});
