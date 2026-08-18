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

// paintMulti — рисует MultiPolygon на Pixi Graphics чистой геометрией (без
// блендов/масок — этот проект уже наступал на баги обоих подходов, см.
// комментарий в vision-fog.js). mode "cut" вырезает дыру в уже залитой
// фигуре, mode "fill" закрашивает style. Кольца полигона, кроме первого
// (outer), — дыры ВНУТРИ него; они всегда противоположны внешнему кольцу по
// смыслу (дыра в вырезанном месте — снова закрашена, дыра в закрашенном —
// снова вырезана). Для "дыра в cut()" нужен refillStyle (чем закрасить
// обратно) — если не задан, дыра просто остаётся как есть (не трогаем).
export function paintMulti(g, multi, w, h, mode, style, refillStyle) {
  for (const poly of multi) {
    if (!poly || !poly.length) continue;
    const outer = clampRing(poly[0], w, h); // плоский [x,y,x,y,...], см. clampRing
    if (outer.length < 8) continue; // меньше 4 точек (8 чисел) в замкнутом кольце — вырожденная/схлопнувшаяся фигура
    if (mode === "cut") g.poly(outer).cut();
    else g.poly(outer).fill(style);
    for (let i = 1; i < poly.length; i++) {
      const hole = clampRing(poly[i], w, h);
      if (hole.length < 8) continue;
      if (mode === "cut") {
        if (refillStyle) g.poly(hole).fill(refillStyle);
      } else {
        g.poly(hole).cut();
      }
    }
  }
}
