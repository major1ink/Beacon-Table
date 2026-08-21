// light-geometry.js — булева алгебра над многоугольниками (объединение,
// пересечение), нужна ТОЛЬКО для освещения (layers/vision-fog.js):
// "видно" = (объединение обзора всех нескрытых токенов) ∩ (объединение
// всех источников света + опциональный глобальный свет на всю карту).
//
// Обзор и свет — каждый по отдельности звёздчатый многоугольник (raycasting
// из geometry.js: computeVisibilityPolygon строит его от ОДНОЙ точки —
// токена или источника света). Но после объединения НЕСКОЛЬКИХ источников
// (два факела и три токена, например) итоговая фигура уже не звёздчатая ни
// от одной точки, а пересечение двух таких фигур — это в общем случае
// точки самопересечения новых рёбер, острова, дыры. Формулой одного
// раycasting'а (как делает vision-fog.js для одного источника) это не
// посчитать — нужна настоящая булева алгебра многоугольников (аналог
// Weiler-Atherton/Greiner-Hormann). Вместо самописной реализации (которую
// негде было бы отладить на живых картах в этой среде — см. историю
// разработки) — обёртка над polygon-clipping (используется в Turf.js,
// корректно обрабатывает вырожденные случаи: общие вершины, касающиеся
// рёбра, дыры).
import polygonClipping from "polygon-clipping";

// EMPTY — пустой MultiPolygon: "фигуры вообще нет" (не путать с "весь мир" —
// для этого есть worldRect ниже).
const EMPTY = [];

// gridUnitsToWorld — переводит радиус света (Token.Light.Bright/Dim), заданный
// в единицах линейки сцены (GridSettings.Unit/UnitsPerCell — по умолчанию
// "фт"/5, то же, что DM вводит в диалоге настройки сетки), в мировые
// (пиксельные) единицы, в которых заданы Wall/Token.X/Y и которые понимает
// computeVisibilityPolygon. 15 при UnitsPerCell=5 и Grid.Size=48 -> 3 клетки
// -> 144px. Единственное место этого счёта — см. domain.TokenLight (Go).
// Fallback'и (48px/клетка, 5 единиц/клетка) — те же дефолты, что и
// domain.NewScene, на случай сцены без явно заданной сетки.
export function gridUnitsToWorld(grid, units) {
  if (!units) return 0;
  const cellSize = grid && grid.size > 0 ? grid.size : 48;
  const unitsPerCell = grid && grid.unitsPerCell > 0 ? grid.unitsPerCell : 5;
  return (units / unitsPerCell) * cellSize;
}

// quantizePoints — САНИТАРНАЯ ОБРАБОТКА результата рейкастинга ПЕРЕД любой
// булевой алгеброй ниже. Прижимает координаты к сетке с шагом quantum и
// выкидывает подряд идущие совпавшие после этого точки.
//
// Зачем: computeVisibilityPolygon пускает в КАЖДЫЙ конец стены по три луча —
// под углами a-EPS, a, a+EPS (EPS = 1e-5, см. geometry.js), чтобы поймать
// край стены. Луч "мимо края" улетает далеко, а вот два других обычно бьют
// в одну и ту же стену на расстоянии radius*EPS друг от друга — при радиусе
// обзора в диагональ карты (~2400px) это доли пикселя. Такие пары дают
// микроскопические рёбра и почти-нулевые по площади "иглы", а их в
// многоугольнике по три штуки на каждый конец каждой стены. Для
// polygon-clipping это яд: на картах с развитой геометрией стен библиотека
// уходит либо в "Unable to find segment ... in SweepLine tree" / "Unable to
// complete output ring", либо в переполнение стека (рекурсия isExteriorRing
// по огромному числу вложенных колец). Замеры на синтетических картах
// (сетка комнат + произвольные короткие стенки, 5 наблюдателей и 6
// источников света): без квантования полный пересчёт освещения падал в 42
// случаях из 60, с квантованием 0.25px — ни одного падения, и на ~10%
// быстрее (меньше вершин на входе).
//
// Шаг 0.25px выбран как заведомо меньше любой видимой на экране величины
// (даже при сильном зуме это четверть пикселя мировых координат), но
// заметно больше тех самых долей пикселя, которыми расходятся EPS-лучи.
export function quantizePoints(points, quantum) {
  if (!quantum) return points;
  const out = [];
  for (const p of points) {
    const x = Math.round(p.x / quantum) * quantum;
    const y = Math.round(p.y / quantum) * quantum;
    const prev = out[out.length - 1];
    if (prev && prev.x === x && prev.y === y) continue;
    out.push({ x, y });
  }
  // Замыкание кольца делает ringFromPoints — здесь совпадение первой и
  // последней точки было бы ещё одним нулевым ребром, снимаем.
  while (out.length > 1 && out[0].x === out[out.length - 1].x && out[0].y === out[out.length - 1].y) out.pop();
  return out;
}

// ringFromPoints — {x,y}[] (уже отсортированный по углу результат
// computeVisibilityPolygon) -> замкнутое кольцо [[x,y],...,[x0,y0]] в
// формате polygon-clipping (Ring = Point[], Point = [x,y]).
function ringFromPoints(points) {
  const ring = points.map((p) => [p.x, p.y]);
  if (ring.length) ring.push(ring[0]);
  return ring;
}

// unionAll — объединяет список простых многоугольников (каждый — {x,y}[] от
// computeVisibilityPolygon) в один MultiPolygon. Пустой вход -> EMPTY (не
// "весь мир", а "фигуры нет") — так пустой список источников света честно
// даёт "света нет нигде", а не падает в бесконечный цикл где-то ниже.
export function unionAll(pointArrays) {
  const polys = pointArrays.filter((p) => p.length >= 3).map((p) => [ringFromPoints(p)]);
  if (polys.length === 0) return EMPTY;
  return polygonClipping.union(...polys);
}

// intersectMulti — пересечение двух MultiPolygon (результатов unionAll/
// worldRect). Короткий путь для частого случая "одна из фигур пуста" — не
// дёргаем библиотеку ради заведомо пустого ответа.
export function intersectMulti(a, b) {
  if (!a || !a.length || !b || !b.length) return EMPTY;
  return polygonClipping.intersection(a, b);
}

// differenceMulti/unionMulti — та же булева алгебра, что unionAll/
// intersectMulti, но НАД УЖЕ ГОТОВЫМИ MultiPolygon (не сырыми точками
// raycasting'а — на вход unionAll нужен именно точечный формат одного
// простого многоугольника). Нужны для vision-fog.js: здания блокируют свет
// НЕ участием в самом raycasting'е (это создавало лишние вершины/лучи от
// каждого угла здания для ЛЮБОГО токена на карте — по сути те же "жёсткие"
// тени, что рисуют обычные стены, но не нужные зданию и заметно
// утяжелявшие пересчёт), а простым вычитанием/пересечением уже посчитанных
// (по обычным стенам) многоугольников света с контуром здания.
export function differenceMulti(a, b) {
  if (!a || !a.length) return EMPTY;
  if (!b || !b.length) return a;
  return polygonClipping.difference(a, b);
}

export function unionMulti(a, b) {
  if (!a || !a.length) return b || EMPTY;
  if (!b || !b.length) return a;
  return polygonClipping.union(a, b);
}

// worldRect — MultiPolygon на весь мир целиком (глобальный свет "на всю
// карту" — кнопки тулбара ДМ).
export function worldRect(w, h) {
  return [
    [
      [
        [0, 0],
        [w, 0],
        [w, h],
        [0, h],
        [0, 0],
      ],
    ],
  ];
}

// clampRing — прижимает кольцо к границам мира И одновременно превращает его
// из формата polygon-clipping (массив пар [[x,y],[x,y],...]) в формат,
// который реально понимает PIXI.Polygon: ЛИБО плоский массив чисел
// [x,y,x,y,...], ЛИБО массив объектов {x,y} — см. конструктор Polygon
// (node_modules/pixi.js/lib/maths/shapes/Polygon.js): если первый элемент не
// number, Polygon читает у КАЖДОГО элемента .x/.y, а у пары-массива [x,y]
// такого свойства нет (undefined, не число) — Graphics.poly(pairsArray) не
// падает и не ругается, а тихо строит "дыру" из одних undefined, которая ничего
// не вырезает. Раньше сюда шли {x,y,a}-объекты computeVisibilityPolygon
// напрямую (у них честные .x/.y), поэтому этот баг не проявлялся — он завёлся
// именно с переходом на polygon-clipping (её формат точек — [x,y]-пары, не
// объекты). Отдаём плоский массив — самый однозначный вариант.
function clampRing(ring, w, h) {
  const flat = [];
  for (const [x, y] of ring) {
    flat.push(Math.min(Math.max(x, 0), w), Math.min(Math.max(y, 0), h));
  }
  return flat;
}

// ---- ПРАВИЛО РАБОТЫ С Pixi cut() (нарушение = кривые тени на экране) ----
//
// Graphics.cut() не принимает "из чего вырезать" — он сам ищет цель среди
// инструкций контекста, и делает это так (node_modules/pixi.js/lib/scene/
// graphics/shared/GraphicsContext.js:cut):
//
//   for (let i = 0; i < 2; i++) {
//     const lastInstruction = this.instructions[this.instructions.length-1-i];
//     ...
//     if (lastInstruction.data.hole) { lastInstruction.data.hole.addPath(p); }
//     else { lastInstruction.data.hole = p; break; }          // <-- break ТОЛЬКО здесь
//   }
//
// Отсюда два капкана, на оба этот проект уже наступал:
//
//   1. Любая fill-инструкция, вклиненная МЕЖДУ вырезами, перехватывает
//      следующий cut() на себя. Заплатка "закрасить дыру острова обратно
//      тьмой" — это именно такая вклиненная заливка: остров, который
//      рисуется сразу после неё, не вырезается из тьмы вообще и остаётся
//      чёрным пятном с резкими прямыми краями.
//   2. ПОВТОРНЫЙ cut() по заливке, у которой дыра уже есть, не
//      останавливается (нет break) и лезет ещё и в ПРЕДПОСЛЕДНЮЮ инструкцию —
//      то есть вешает дыру на ЧУЖУЮ, соседнюю фигуру. Дыра при этом лежит
//      вне её контура, earcut соединяет её с внешним кольцом перемычкой, и
//      на экране появляется тонкий треугольный "клин" из ниоткуда.
//
// Отсюда правило, которое соблюдают функции ниже: НА ОДНУ ЗАЛИВКУ — РОВНО
// ОДИН cut(), и между заливкой и её cut() не должно быть других инструкций.
// Несколько колец вырезаются не несколькими cut(), а одним — Pixi копит
// подряд идущие poly() в один путь (_activePath чистится только в fill/cut),
// и такой путь уезжает в дыру целиком, как несколько subpath'ов.

// cutRings — вырезать НАБОР колец из последней fill-инструкции ровно одним
// cut() (см. правило выше). Возвращает false, если вырезать было нечего —
// тогда cut() не зовётся вообще, иначе он вырезал бы вырожденный остаток
// пути от предыдущей инструкции.
function cutRings(g, rings) {
  let any = false;
  for (const ring of rings) {
    if (ring.length < 8) continue; // меньше 4 точек (8 чисел) в замкнутом кольце — вырожденная/схлопнувшаяся фигура
    g.poly(ring);
    any = true;
  }
  if (any) g.cut();
  return any;
}

// ringsOf — MultiPolygon -> { outers, holes } в плоском формате Pixi, с
// отсеянными вырожденными кольцами. Кольца полигона, кроме первого (outer),
// это дыры ВНУТРИ него — по смыслу они всегда противоположны внешнему
// кольцу (дыра в вырезанном месте — снова закрашена, дыра в закрашенном —
// снова вырезана).
function ringsOf(multi, w, h) {
  const outers = [];
  const holes = [];
  for (const poly of multi) {
    if (!poly || !poly.length) continue;
    const outer = clampRing(poly[0], w, h); // плоский [x,y,x,y,...], см. clampRing
    if (outer.length < 8) continue;
    outers.push(outer);
    for (let i = 1; i < poly.length; i++) {
      const hole = clampRing(poly[i], w, h);
      if (hole.length >= 8) holes.push(hole);
    }
  }
  return { outers, holes };
}

// cutMulti — вырезать MultiPolygon из уже залитой фигуры (у vision-fog.js
// это сплошная заливка тьмы). Сначала ОДНИМ cut() уходят все внешние
// кольца, и только потом — заплатки refillStyle на дыры островов: заливка,
// поставленная раньше, перехватила бы вырез следующего острова (капкан №1 в
// правиле выше). На порядок рисования это не влияет — cut() не рисует, он
// правит уже созданную заливку, так что заплатки как ложились поверх тьмы,
// так и ложатся. Без refillStyle дыры просто остаются вырезанными.
export function cutMulti(g, multi, w, h, refillStyle) {
  const { outers, holes } = ringsOf(multi, w, h);
  cutRings(g, outers);
  if (!refillStyle) return;
  for (const hole of holes) g.poly(hole).fill(refillStyle);
}

// fillMulti — закрасить MultiPolygon style'ом, вырезав его собственные дыры.
// extraCuts — дополнительные MultiPolygon'ы, которые надо вырезать из ТОЙ ЖЕ
// заливки (у vision-fog.js это ярко освещённые куски внутри тускло
// освещённого острова). Они идут в тот же единственный cut(), а не отдельным
// вызовом: второй cut() по той же заливке — это капкан №2 из правила выше,
// и именно он рисовал клинья-призраки поверх соседнего острова.
export function fillMulti(g, multi, w, h, style, extraCuts = [], extraRefillStyle = null) {
  for (const poly of multi) {
    if (!poly || !poly.length) continue;
    const outer = clampRing(poly[0], w, h);
    if (outer.length < 8) continue;
    const own = [];
    for (let i = 1; i < poly.length; i++) {
      const hole = clampRing(poly[i], w, h);
      if (hole.length >= 8) own.push(hole);
    }
    const extra = ringsOf(extraCuts, w, h);
    g.poly(outer).fill(style);
    cutRings(g, own.concat(extra.outers));
    // Дыра внутри вырезанного куска — снова часть заливки, возвращаем
    // заплаткой ПОСЛЕ cut() (до него она перехватила бы этот же cut()).
    if (extraRefillStyle) for (const hole of extra.holes) g.poly(hole).fill(extraRefillStyle);
  }
}
