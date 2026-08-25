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
// Наблюдателем считается токен ПАРТИИ — с непустым ownerId (см. sightTokens
// в vision-plan.js). В тестах владелец проставляется здесь автоматически
// всем не-lightOnly токенам, у которых он не задан явно: почти всюду ниже
// токен в списке означает "персонаж, который смотрит", и расписывать это в
// каждом тесте — только шум. Тесты, которым нужен именно БЕЗВЛАДЕЛЬНЫЙ токен
// (монстр), задают ownerId: "" сами.
function makeScene(tokens, globalLight = "bright") {
  const owned = tokens.map((t) => (t.lightOnly || "ownerId" in t ? t : { ...t, ownerId: "p1" }));
  return {
    width: manorWorld.w,
    height: manorWorld.h,
    grid: { ...manorGrid, offsetX: 0, offsetY: 0 },
    fogOfWar: true,
    globalLight,
    walls: Object.fromEntries(manorWalls.map((w) => [w.id, w])),
    tokens: Object.fromEntries(owned.map((t, i) => [`tok-${i}`, t])),
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

// ---- окно: сквозь него видно, но свет оно держит (как в Foundry) ----

// roomWithWindow — комната слева от глухой стены x=400, в стене окно
// (y 180..260). Факел внутри комнаты, наблюдатель снаружи напротив окна.
// Раньше свет и обзор считались по ОДНОМУ списку стен, где окна нет вовсе —
// то есть окно было для света дырой, и факел выстреливал сквозь узкий проём
// резкой иглой света наружу.
function roomWithWindow() {
  return {
    width: 1000,
    height: 800,
    grid: { size: 50, unitsPerCell: 5, unit: "фт", offsetX: 0, offsetY: 0 },
    fogOfWar: true,
    globalLight: "",
    buildings: {},
    walls: {
      a: { id: "a", x1: 400, y1: 0, x2: 400, y2: 180 },
      win: { id: "win", x1: 400, y1: 180, x2: 400, y2: 260, window: true },
      b: { id: "b", x1: 400, y1: 260, x2: 400, y2: 800 },
    },
    tokens: {
      obs: { x: 700, y: 220, size: 20, ownerId: "p1" },
      torch: { x: 300, y: 220, size: 20, lightOnly: true, light: { enabled: true, bright: 10, dim: 20 } },
    },
  };
}

// litAreaRightOfWall — площадь освещённого СНАРУЖИ комнаты (x > 400),
// посчитанная сеткой точек: единственное, что тут важно, — есть свет за
// стеной или нет, точность до пикселя не нужна.
function litAreaRightOfWall(plan) {
  const inRing = (ring, x, y) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  let hits = 0;
  for (let x = 405; x < 1000; x += 5) {
    for (let y = 0; y < 800; y += 5) {
      for (const { poly } of plan.dimIslands) {
        let crossings = 0;
        for (const ring of poly) if (inRing(ring, x, y)) crossings++;
        if (crossings % 2 === 1) {
          hits++;
          break;
        }
      }
    }
  }
  return hits * 25;
}

test("окно не пропускает свет наружу", () => {
  const plan = computeVisionPlan(roomWithWindow(), false, WORKING_QUANTUM);
  assert.equal(litAreaRightOfWall(plan), 0, "свет пробился сквозь окно — окно снова стало дырой для света");
});

test("окно всё ещё пропускает обзор", () => {
  // Та же сцена, что и в тесте выше: свет факела остаётся ВНУТРИ комнаты, а
  // наблюдатель стоит СНАРУЖИ напротив окна — и должен увидеть освещённый
  // кусок комнаты сквозь него. Страховка на то, что окно не «заварили»
  // заодно и для обзора: если бы оно блокировало ещё и взгляд, наблюдатель
  // не увидел бы вообще ничего и dimIslands был бы пуст.
  const plan = computeVisionPlan(roomWithWindow(), false, WORKING_QUANTUM);
  const seenInside = plan.dimIslands.some(({ poly }) => poly[0].some(([x]) => x < 395));
  assert.ok(seenInside, "сквозь окно перестало быть видно — окно блокирует обзор, а не должно");
});

test("монстр без владельца не даёт игроку обзора", () => {
  // Регрессия на боевую "Пещеру": там наблюдателями оказались 3
  // гоблина-воителя, гигантская многоножка и трое NPC — половина открытой
  // игроку карты была открыта их глазами.
  const torch = { x: 1100, y: 1000, lightOnly: true, light: { enabled: true, bright: 20, dim: 40 } };
  const monster = { x: 1100, y: 1000, ownerId: "" }; // стоит ровно в свете, но чужой
  const hero = { x: 400, y: 400, ownerId: "p1" };

  const onlyMonster = computeVisionPlan(makeScene([monster, torch], ""), false, WORKING_QUANTUM);
  assert.equal(onlyMonster.dimIslands.length, 0, "монстр в освещённой точке раскрыл карту игроку");

  // А герой в той же расстановке — раскрывает, иначе тест зелёный по причине
  // "света и так нет".
  const withHero = computeVisionPlan(makeScene([{ ...hero, x: 1100, y: 1000 }, torch], ""), false, WORKING_QUANTUM);
  assert.ok(withHero.dimIslands.length > 0, "токен партии перестал давать обзор — сломан сам отбор наблюдателей");
});

test("токены партии делятся обзором между собой", () => {
  // Выбранное правило — вся партия, а не только свои токены: два героя
  // разных игроков вместе открывают больше, чем каждый по отдельности.
  const torches = [
    { x: 500, y: 500, lightOnly: true, light: { enabled: true, bright: 20, dim: 40 } },
    { x: 1200, y: 1200, lightOnly: true, light: { enabled: true, bright: 20, dim: 40 } },
  ];
  const a = { x: 500, y: 500, ownerId: "p1" };
  const b = { x: 1200, y: 1200, ownerId: "p2" };
  const both = computeVisionPlan(makeScene([a, b, ...torches], ""), false, WORKING_QUANTUM);
  const alone = computeVisionPlan(makeScene([a, ...torches], ""), false, WORKING_QUANTUM);
  const areaOf = (plan) =>
    plan.dimIslands.reduce((sum, { poly }) => {
      let acc = 0;
      for (let k = 0; k < poly[0].length - 1; k++) acc += poly[0][k][0] * poly[0][k + 1][1] - poly[0][k + 1][0] * poly[0][k][1];
      return sum + Math.abs(acc / 2);
    }, 0);
  assert.ok(areaOf(both) > areaOf(alone), "второй персонаж партии ничего не добавил к общему обзору");
});

// ---- memo: кэш между кадрами не меняет результат, только цену ----

test("memo не влияет на результат расчёта", () => {
  const rnd = makeRandom(31337);
  const memo = {};
  for (let i = 0; i < 40; i++) {
    const tokens = [];
    for (let k = 0; k < 1 + Math.floor(rnd() * 4); k++) {
      const t = { x: rnd() * manorWorld.w, y: rnd() * manorWorld.h };
      if (rnd() < 0.5) t.light = { enabled: true, bright: Math.floor(rnd() * 30), dim: Math.floor(rnd() * 50) };
      tokens.push(t);
    }
    const scene = makeScene(tokens, "");
    const withMemo = computeVisionPlanWithFallback(scene, false, memo);
    const clean = computeVisionPlanWithFallback(scene, false);
    assert.deepEqual(withMemo.plan, clean.plan, "кэш слоя света разошёлся с расчётом с нуля");
  }
});

test("сдвиг источника света сбрасывает кэш слоя света", () => {
  // Самый опасный для кэша случай: наблюдатель стоит на месте, а двигается
  // ИСТОЧНИК. Если ключ (lightLayerKey) не учтёт его координаты, игрок будет
  // видеть свет там, где факела уже нет.
  const memo = {};
  const at = (x) => makeScene([{ x: 700, y: 900 }, { x, y: 900, lightOnly: true, light: { enabled: true, bright: 20, dim: 40 } }], "");
  const first = computeVisionPlanWithFallback(at(800), false, memo).plan;
  const moved = computeVisionPlanWithFallback(at(1100), false, memo).plan;
  const fresh = computeVisionPlanWithFallback(at(1100), false).plan;
  assert.notDeepEqual(first.dimIslands, moved.dimIslands, "факел уехал, а освещение осталось прежним — кэш не сбросился");
  assert.deepEqual(moved.dimIslands, fresh.dimIslands);
});

// ---- мягкое затухание света: кольца ----

test("кольца затухания не пересекаются между собой", () => {
  // САМЫЙ важный инвариант мягкого света. Поволока — это полупрозрачная
  // ТЬМА поверх карты: если два кольца наложатся друг на друга, их альфы
  // сложатся, и место наложения станет ТЕМНЕЕ, чем каждое кольцо по
  // отдельности. На стыке двух световых пятен это выглядело бы как тёмная
  // кайма ровно там, где света вдвое больше.
  //
  // Проверяем на расстановке, где источники заведомо перекрываются.
  const rnd = makeRandom(20260825);
  for (let i = 0; i < 30; i++) {
    const cx = 300 + rnd() * 1000;
    const cy = 300 + rnd() * 1000;
    const tokens = [{ x: cx, y: cy }];
    for (let k = 0; k < 3; k++) {
      tokens.push({ x: cx + (rnd() - 0.5) * 200, y: cy + (rnd() - 0.5) * 200, lightOnly: true, light: { enabled: true, bright: 10, dim: 40 } });
    }
    const { plan } = computeVisionPlanWithFallback(makeScene(tokens, ""), false);
    assert.ok(plan, "расчёт не прошёл");
    if (!plan.rings || plan.rings.length < 2) continue;
    // Считаем ТОЧКАМИ, а не булевой алгеброй: у соседних колец граница —
    // одно и то же ребро, и пересечение таких фигур — ровно тот вырожденный
    // случай («касаются, но не перекрываются»), на котором polygon-clipping
    // спотыкается сам. Здесь важно не «чему равна площадь перекрытия», а
    // «есть ли пиксель, который закрасят дважды», — сетка отвечает на это
    // прямо и без вырожденных случаев.
    for (let x = cx - 400; x < cx + 400; x += 11) {
      for (let y = cy - 400; y < cy + 400; y += 11) {
        let hits = 0;
        for (const { multi } of plan.rings) if (multiContains(multi, x, y)) hits++;
        assert.ok(hits <= 1, `точка (${x.toFixed(0)}, ${y.toFixed(0)}) попала в ${hits} колец — на карте это тёмная кайма между источниками`);
      }
    }
  }
});

// multiContains — попадает ли точка в MultiPolygon (even-odd по кольцам:
// первое кольцо полигона внешнее, остальные — дыры).
function multiContains(multi, x, y) {
  for (const poly of multi) {
    let crossings = 0;
    for (const ring of poly) {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) crossings++;
    }
    if (crossings % 2 === 1) return true;
  }
  return false;
}

test("кольца идут от тёмного края к ярко освещённому ядру", () => {
  const torch = { x: 800, y: 900, lightOnly: true, light: { enabled: true, bright: 15, dim: 45 } };
  const { plan } = computeVisionPlanWithFallback(makeScene([{ x: 800, y: 900 }, torch], ""), false);
  assert.ok(plan.rings.length >= 2, `колец всего ${plan.rings.length} — затухание выродилось в ступеньку`);
  const levels = plan.rings.map((r) => r.level);
  assert.deepEqual([...levels].sort((a, b) => a - b), levels, "уровни колец идут не по порядку");
  assert.equal(levels[0], 0, "у самого внешнего кольца level должен быть 0 — это край тусклого света");
  assert.ok(levels[levels.length - 1] < 1, "level 1 — это ядро, его рисовать нечем (полностью прозрачно)");
});

test("сдвиг НАБЛЮДАТЕЛЯ сбрасывает кэш плана", () => {
  // Парная страховка к тесту про сдвиг источника: теперь между кадрами
  // кэшируется не только слой света, но и весь план целиком (planInputKey) и
  // обзор каждого наблюдателя по отдельности (cachedSightPolys). Если хоть
  // одна из этих подписей забудет позицию наблюдателя, игрок увидит освещение
  // с прошлого места — кадр при этом валидный, просто чужой, и на глаз это
  // почти не ловится.
  const memo = {};
  const at = (x) => makeScene([{ x, y: 900 }, { x: 800, y: 900, lightOnly: true, light: { enabled: true, bright: 20, dim: 40 } }], "");
  const first = computeVisionPlanWithFallback(at(700), false, memo);
  const moved = computeVisionPlanWithFallback(at(1200), false, memo);
  const fresh = computeVisionPlanWithFallback(at(1200), false);
  assert.equal(first.unchanged, undefined);
  assert.equal(moved.unchanged, undefined, "наблюдатель уехал, а расчёт решил, что вход не менялся");
  assert.deepEqual(moved.plan.dimIslands, fresh.plan.dimIslands);
});

test("снапшот без изменений геометрии не пересчитывается заново", () => {
  // Бит dirty.vision выставляет ЛЮБОЙ снапшот (бросок кубика, правка HP,
  // инициатива — см. dirty.js), а геометрия при этом та же. Раньше каждый
  // такой снапшот стоил полного пересчёта: десятки миллисекунд
  // заблокированного главного потока на ровном месте.
  const memo = {};
  const scene = makeScene([{ x: 800, y: 900 }, { x: 900, y: 900, lightOnly: true, light: { enabled: true, bright: 20, dim: 40 } }], "");
  const first = computeVisionPlanWithFallback(scene, false, memo);
  const again = computeVisionPlanWithFallback(scene, false, memo);
  assert.equal(again.unchanged, true, "вход не менялся, а расчёт всё равно прошёл целиком");
  assert.equal(again.plan, first.plan, "должен вернуться ТОТ ЖЕ объект плана — vision-fog.js по нему решает не перерисовывать Graphics");
});

test("рабочий квант запоминается между кадрами", () => {
  // На картах, где точный квант падает, лестница каждый кадр доделывала
  // заведомо провальную попытку целиком. Теперь прошлый удачный квант
  // пробуется первым.
  const memo = { quantum: QUANTUM_LADDER[1] };
  const { quantum } = computeVisionPlanWithFallback(makeScene([{ x: 800, y: 800 }]), false, memo);
  assert.equal(quantum, QUANTUM_LADDER[1], "запомненный квант не был опробован первым");
  assert.equal(memo.quantum, QUANTUM_LADDER[1]);
});
