// Граф связей журнала (src/journal-graph.js): раскладка без наложений и
// снимок на доску со ссылками на записи.
import test from "node:test";
import assert from "node:assert/strict";

import { layoutGraph, boardScene } from "../src/journal-graph.js";

const nodes = Array.from({ length: 12 }, (_, i) => ({ id: "n" + i, title: "Запись " + i, folder: i % 2 ? "NPC" : "Места" }));
const edges = nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id, type: i % 3 ? "" : "союзник" }));

test("узлы не налезают друг на друга, раскладка повторяется", () => {
  const pos = layoutGraph(nodes, edges);
  const list = [...pos.values()];
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++)
      assert.ok(Math.abs(list[i].x - list[j].x) >= 176 || Math.abs(list[i].y - list[j].y) >= 40, `узлы ${i} и ${j} наложились`);
  assert.deepEqual(layoutGraph(nodes, edges), pos);
});

test("закреплённый руками узел остаётся на месте", () => {
  const pos = layoutGraph(nodes, edges, new Map([["n3", { x: 999, y: -999 }]]));
  assert.deepEqual(pos.get("n3"), { x: 999, y: -999 });
});

test("доска: карточка со ссылкой на запись и стрелка, привязанная к обеим", () => {
  const scene = boardScene({ nodes: nodes.slice(0, 2), edges: edges.slice(0, 1) }, layoutGraph(nodes, edges));
  const rects = scene.elements.filter((e) => e.type === "rectangle");
  const arrow = scene.elements.find((e) => e.type === "arrow");
  assert.equal(rects.length, 2);
  assert.equal(rects[0].link, "[[Запись 0]]");
  assert.equal(arrow.startBinding.elementId, rects[0].id);
  assert.equal(arrow.endBinding.elementId, rects[1].id);
  assert.ok(rects[1].boundElements.some((b) => b.id === arrow.id));
});
