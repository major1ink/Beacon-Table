// Граф связей журнала (src/journal-graph.js): раскладка без наложений и
// снимок на доску со ссылками на записи.
import test from "node:test";
import assert from "node:assert/strict";

import { layoutGraph, boardScene, mergeMutual } from "../src/journal-graph.js";

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

test("связь, объявленная в обеих записях, — одна; направленная и другой тип — отдельно", () => {
  const merged = mergeMutual([
    { from: "margo", to: "anselm", type: "семья", secret: true },
    { from: "anselm", to: "margo", type: "семья", secret: false },
    { from: "anselm", to: "margo", type: "враг" },
    { from: "margo", to: "tobias", type: "подчинённый" },
    { from: "tobias", to: "margo", type: "подчинённый" },
    { from: "margo", to: "tobias", type: "" },
  ]);
  assert.deepEqual(
    merged.map((e) => `${e.from}>${e.to}:${e.type}`),
    ["margo>anselm:семья", "anselm>margo:враг", "margo>tobias:подчинённый", "tobias>margo:подчинённый", "margo>tobias:"]
  );
  assert.equal(merged[0].secret, false, "видна игрокам через открытую запись");
});

test("доска: длинное название — широкая карточка без наложений, стрелка от края до края", () => {
  const long = nodes.map((n, i) => ({ ...n, title: i % 3 ? n.title : "Сессия 10 — 29 сентября 2026, пещера кузнеца и колокольня" }));
  const scene = boardScene({ nodes: long, edges }, layoutGraph(long, edges));
  const rects = scene.elements.filter((e) => e.type === "rectangle");
  const wide = rects.find((r) => r.link.includes("Сессия 10"));
  const label = scene.elements.find((e) => e.containerId === wide.id);
  assert.ok(wide.width > 176 && wide.width <= 320, "ширина по названию");
  assert.ok(label.text.includes("\n") && wide.height > 40, "длинное название переносится");
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const [a, b] = [rects[i], rects[j]];
      const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
      assert.ok(apart, `карточки ${a.link} и ${b.link} наложились`);
    }
  const byId = new Map(rects.map((r) => [r.id, r]));
  for (const arrow of scene.elements.filter((e) => e.type === "arrow")) {
    const r = byId.get(arrow.startBinding.elementId);
    const inside = arrow.x > r.x + 1 && arrow.x < r.x + r.width - 1 && arrow.y > r.y + 1 && arrow.y < r.y + r.height - 1;
    assert.ok(!inside, "стрелка начинается не внутри карточки");
  }
});
