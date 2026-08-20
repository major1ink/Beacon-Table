// vision-fog-geometry.test.js — регрессия на падения polygon-clipping в
// пересчёте освещения.
//
// История: на боевой карте "Зимнее поместье" (см. fixtures/walls-manor.js)
// консоль игрока непрерывно сыпала
//   "Unable to find segment #… in SweepLine tree"
//   "Unable to complete output ring starting at …"
//   "RangeError: Maximum call stack size exceeded" (рекурсия isExteriorRing)
// — освещение зависало на последнем удачном кадре, токены переставали
// двигаться. Причина — сырой результат computeVisibilityPolygon: в каждый
// конец стены пускается по три луча (a-EPS, a, a+EPS), два из них обычно
// бьют в одну стену на расстоянии radius*EPS друг от друга, то есть в доли
// пикселя. Такие микро-рёбра polygon-clipping не переваривает. Лечится
// квантованием точек перед булевой алгеброй (quantizePoints в
// light-geometry.js) плюс аварийной лестницей более грубых квантов
// (QUANTUM_LADDER в vision-plan.js).
//
// Тест держит обе части: `computeVisionPlan` на рабочем кванте не должен
// падать вообще, а `computeVisionPlanWithFallback` — обязан вернуть план
// при любой расстановке токенов и источников света.
import test from "node:test";
import assert from "node:assert/strict";
import { computeVisionPlan, computeVisionPlanWithFallback, QUANTUM_LADDER } from "../src/vtt/vision-plan.js";
import { computeVisibilityPolygon } from "../src/geometry.js";
import { unionAll } from "../src/vtt/light-geometry.js";
import { manorWalls, manorWorld, manorGrid } from "./fixtures/walls-manor.js";

const WORKING_QUANTUM = QUANTUM_LADDER[0];

// makeScene — снапшот сцены в том виде, в каком его видит vision-plan.js
// (домены walls/tokens — словари по id, как приходит с сервера).
function makeScene(tokens, globalLight = "bright") {
  return {
    width: manorWorld.w,
    height: manorWorld.h,
    grid: { ...manorGrid, offsetX: 0, offsetY: 0 },
    fogOfWar: true,
    globalLight,
    walls: Object.fromEntries(manorWalls.map((w) => [w.id, w])),
    tokens: Object.fromEntries(tokens.map((t, i) => [`tok-${i}`, t])),
    buildings: {},
  };
}

// Детерминированный ГПСЧ — тест не должен "иногда падать" и не должен
// "иногда проходить": одна и та же расстановка на каждом прогоне.
function makeRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

test("сырой рейкастинг на этой карте действительно ломает polygon-clipping (без квантования)", () => {
  // Страховка на саму фикстуру: если геометрию карты когда-нибудь
  // «причешут» и вырожденные случаи из неё уйдут, тесты ниже станут
  // зелёными по причине «нечего ловить». Этот тест сломается первым и
  // скажет, что фикстура протухла.
  const rnd = makeRandom(987);
  const sightRadius = Math.hypot(manorWorld.w, manorWorld.h) + 50;
  let failures = 0;
  for (let i = 0; i < 200; i++) {
    const polys = [];
    for (let k = 0; k < 3; k++) {
      polys.push(computeVisibilityPolygon(rnd() * manorWorld.w, rnd() * manorWorld.h, sightRadius, manorWalls));
    }
    try {
      unionAll(polys); // БЕЗ quantizePoints — как было до фикса
    } catch {
      failures++;
    }
  }
  assert.ok(failures > 0, "фикстура больше не воспроизводит падения polygon-clipping — обновите её реальной проблемной картой");
});

test("рабочий квант выдерживает любую расстановку наблюдателей", () => {
  const rnd = makeRandom(4242);
  for (let i = 0; i < 200; i++) {
    const tokens = [];
    for (let k = 0; k < 1 + Math.floor(rnd() * 5); k++) {
      tokens.push({ x: rnd() * manorWorld.w, y: rnd() * manorWorld.h });
    }
    const plan = computeVisionPlan(makeScene(tokens), false, WORKING_QUANTUM);
    assert.equal(plan.skip, false);
  }
});

test("расстановка токенов, источников света и globalLight не роняет расчёт", () => {
  const rnd = makeRandom(777);
  const globals = ["", "dim", "bright"];
  for (let i = 0; i < 300; i++) {
    const tokens = [];
    for (let k = 0; k < 1 + Math.floor(rnd() * 7); k++) {
      const t = { x: rnd() * manorWorld.w, y: rnd() * manorWorld.h };
      const roll = rnd();
      // Свет задаётся в единицах линейки сцены (фт), как в диалоге токена.
      if (roll < 0.5) t.light = { enabled: true, bright: Math.floor(rnd() * 40), dim: Math.floor(rnd() * 60) };
      if (roll > 0.85) t.lightOnly = true;
      tokens.push(t);
    }
    const { plan, error } = computeVisionPlanWithFallback(makeScene(tokens, globals[Math.floor(rnd() * 3)]), false);
    assert.ok(plan, `расчёт не прошёл ни на одном шаге QUANTUM_LADDER: ${error && error.message}`);
  }
});

test("токены на позициях из боевого лога считаются без ошибок", () => {
  // Координаты, вокруг которых падала библиотека в консоли игрока:
  // "Unable to find segment #97759 [1403.11…, 807.12…]" и
  // "Unable to complete output ring starting at [1046.45…, 1472.18…]".
  const hotspots = [
    [1403.1112077308487, 807.1258595805101],
    [1046.45535539787, 1472.183697550483],
    [791.7045203344998, 860.3098367506262],
    [791.7045203344998, 920.3098367506262],
  ];
  for (const [x, y] of hotspots) {
    const plan = computeVisionPlan(makeScene([{ x, y }]), false, WORKING_QUANTUM);
    assert.equal(plan.skip, false);
  }
  // ...и все они на карте одновременно.
  const plan = computeVisionPlan(makeScene(hotspots.map(([x, y]) => ({ x, y }))), false, WORKING_QUANTUM);
  assert.ok(plan.dimIslands.length > 0);
});

test("DM и выключенный туман войны пропускают расчёт целиком", () => {
  const tokens = [{ x: 800, y: 800 }];
  assert.deepEqual(computeVisionPlan(makeScene(tokens), true, WORKING_QUANTUM), { skip: true });
  const noFog = makeScene(tokens);
  noFog.fogOfWar = false;
  assert.deepEqual(computeVisionPlan(noFog, false, WORKING_QUANTUM), { skip: true });
});

test("без источников света и без globalLight игрок не видит ничего", () => {
  const plan = computeVisionPlan(makeScene([{ x: 800, y: 800 }], ""), false, WORKING_QUANTUM);
  assert.equal(plan.skip, false);
  assert.equal(plan.dimIslands.length, 0);
});

test("одни lightOnly-факелы без наблюдателя не раскрывают карту", () => {
  const torches = [
    { x: 700, y: 900, lightOnly: true, light: { enabled: true, bright: 20, dim: 40 } },
    { x: 1100, y: 1000, lightOnly: true, light: { enabled: true, bright: 20, dim: 40 } },
  ];
  const plan = computeVisionPlan(makeScene(torches), false, WORKING_QUANTUM);
  assert.equal(plan.dimIslands.length, 0);
});
