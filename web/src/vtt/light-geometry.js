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

// ---- разность ВЛОЖЕННЫХ мультиполигонов, без polygon-clipping ----
//
// subtractNested(outer, inner) — то же, что differenceMulti(outer, inner), но
// при ГАРАНТИИ, что inner целиком лежит внутри outer. Ровно этот случай — и
// единственный такой — у колец затухания света (ringMultis в vision-plan.js):
// bands[k+1] строится теми же лучами от тех же источников по тем же стенам,
// просто с меньшим радиусом, поэтому вложенность даётся построением.
//
// Зачем отдельная функция вместо честной булевой разности. Именно на этой
// паре polygon-clipping разваливается чаще всего, и лестница квантов
// (QUANTUM_LADDER) её НЕ спасает — замер на боевой "Пещере" (301 стена, 18
// источников, радиусы 20/40 фт, 30 случайных расстановок): из 68 попыток
// (расстановка × квант) 47 умерли на разности bands[k]∖bands[k+1] и лишь
// одна — на объединении (unionAll), а у 10 расстановок из 30 не прошёл НИ
// ОДИН квант лестницы: весь кадр освещения терялся целиком ("сбой пересчёта
// освещения" в консоли, свет замирает на прошлом кадре и сыплется один и тот
// же стек). Причина понятна из самой геометрии: у двух соседних полос
// ГРОМАДНАЯ часть границы совпадает точка-в-точку — там, где
// свет упирается в стену, обе полосы обрезаны одним и тем же отрезком. Пары
// точно коллинеарных налегающих рёбер — худший вход для заметающей прямой, и
// на нём библиотека уходит то в "Unable to find segment ... in SweepLine
// tree", то в "Unable to complete output ring", то в "Infinite loop when
// passing sweep line over endpoints".
//
// Здесь никакой заметающей прямой нет вообще: раз inner внутри outer, то
// разность — это чистая расстановка колец по вложенности. Внешнее кольцо
// каждого куска inner становится ДЫРОЙ в том куске outer, внутрь которого
// попало; дыра внутри куска inner (не освещено на шаге k+1, но освещено на
// k) — наоборот, самостоятельный кусок результата, который сам может
// получить дыры. Ни одного нового ребра не рождается, поэтому падать
// нечему; заодно это ещё и в разы быстрее — на тех 118 разностях того же
// замера, где булева не упала, 49 мс против 815 мс.
//
// Расплата — точность: если после квантования (quantizePoints) inner на
// доли пикселя вылез за outer, вложенность формально нарушена, и такой
// выступ просто останется частью дыры. Расхождение по площади с честной
// разностью на том же замере — не больше 2.3e-4 (сотые доли процента,
// заведомо меньше пикселя на экране).
export function subtractNested(outer, inner) {
  if (!outer || !outer.length) return EMPTY;
  if (!inner || !inner.length) return outer;

  // Кольца раскладываются на две стопки — и обе перемешанные, из обеих
  // фигур сразу:
  //
  //   regions — "залито": внешние кольца outer (свет на шаге k) и ДЫРЫ inner
  //     (на шаге k+1 там уже темно, а на k ещё светло — значит это кусок
  //     результата, а не пустота).
  //   holes — "вырезано": внешние кольца inner (на шаге k+1 светло — из
  //     кольца затухания вон) и ДЫРЫ outer (темно на обоих шагах).
  //
  // Каждая дыра идёт к САМОМУ МЕЛКОМУ куску, внутрь которого попала (отсюда
  // сортировка по площади) — и вот это единственное место, где легко
  // ошибиться: дыру outer нельзя просто оставить при её собственном
  // полигоне. Тёмный карман от стены на шаге k+1 БОЛЬШЕ, чем на k (свет
  // короче — тень длиннее), то есть дыра outer лежит ВНУТРИ дыры inner, а
  // не рядом с ней. Оставленная при своём полигоне, она вырезала бы карман
  // дважды — а второй вырез внутри уже вырезанного означает, что кольца
  // перестают быть непересекающимися, и на стыке источников появляется та
  // самая тёмная кайма, ради отсутствия которой всё это и считается.
  const regions = [];
  const holes = [];
  for (const poly of outer) {
    if (!poly || !poly.length) continue;
    regions.push(makeRegion(poly[0]));
    for (let i = 1; i < poly.length; i++) holes.push(poly[i]);
  }
  for (const poly of inner) {
    if (!poly || !poly.length) continue;
    holes.push(poly[0]);
    for (let i = 1; i < poly.length; i++) regions.push(makeRegion(poly[i]));
  }
  regions.sort((a, b) => a.area - b.area);

  for (const hole of holes) {
    const host = hostFor(regions, hole);
    if (host) host.holes.push(hole);
  }

  const out = [];
  for (const r of regions) {
    let net = r.area;
    for (const hole of r.holes) net -= Math.abs(ringArea(hole));
    // Кусок, съеденный дырами целиком — это в точности случай "полоса не
    // изменилась" (например, globalLight: "bright", где все полосы — весь
    // мир): честная разность вернула бы пусто, вернём пусто и мы. Порог в
    // одну квадратную мировую единицу заодно снимает вырожденные ошмётки
    // толщиной в доли пикселя.
    if (net <= 1) continue;
    out.push([r.ring, ...r.holes]);
  }
  return out;
}

function makeRegion(ring) {
  return { ring, holes: [], bb: ringBBox(ring), area: Math.abs(ringArea(ring)) };
}

// hostFor — кусок результата, внутрь которого попадает кольцо ring; regions
// отсортированы по площади, поэтому первое попадание — самый мелкий, то есть
// непосредственный хозяин, а не его прародитель.
//
// Проверяем ОДНОЙ строго внутренней точкой кольца (см. interiorPoint), а не
// его вершинами: у дыры на шаге k и у дыры на шаге k+1 — это один и тот же
// тёмный карман за стеной, только разного размера, и БОЛЬШИНСТВО вершин
// мелкой лежит ТОЧНО на границе крупной (общее обрезанное стеной ребро). Для
// точки на границе чётно-нечётный тест не отвечает ни да, ни нет, поэтому
// голосование по вершинам (первый вариант этой функции) уводило дыру мимо
// настоящего хозяина к его прародителю — она вырезалась второй раз из уже
// вырезанного, и площадь кольца уезжала на четверть.
//
// Одной точки мало для ОДНОГО правила: точка внутри кольца лежит не только
// внутри его хозяина, но и внутри всего, что вложено в само кольцо (тёмный
// карман внутри светового пятна — тоже кусок результата и тоже в списке
// regions). Отсюда проверка площади: хозяин не может быть МЕНЬШЕ своего
// постояльца, а всё, что вложено в кольцо, заведомо меньше — так вложенное
// отсеивается одним сравнением, без второго теста на принадлежность.
//
// fallback по габаритам — только на случай, если строго внутренняя точка не
// нашлась вовсе (вырожденное кольцо нулевой площади).
function hostFor(regions, ring) {
  const own = Math.abs(ringArea(ring));
  // Допуск к сравнению площадей — та же расплата за квантование, что и
  // BBOX_SLACK: источник, целиком запертый в комнате, даёт на соседних шагах
  // ОДНУ И ТУ ЖЕ комнату (радиус больше неё), но прижатую к сетке по-разному,
  // и внутренняя полоса оказывается на несколько квадратных единиц БОЛЬШЕ
  // внешней. Без допуска настоящий хозяин отсеивался бы как «постоялец», дыра
  // оставалась бы неприкаянной, а кольцо — невырезанным (треть лишней площади
  // на замере). Обратная цена допуска — не больше 0.1% площади кольца.
  const slack = own * 1e-3 + 1;
  const probe = interiorPoint(ring);
  if (!probe) {
    const bb = ringBBox(ring);
    for (const r of regions) if (r.area + slack >= own && bboxCovers(r.bb, bb)) return r;
    return null;
  }
  const [px, py] = probe;
  for (const r of regions) {
    if (r.area + slack < own) continue; // вложено в само кольцо — не хозяин, а постоялец
    if (px < r.bb[0] || px > r.bb[2] || py < r.bb[1] || py > r.bb[3]) continue;
    if (pointInRing(r.ring, px, py)) return r;
  }
  return null;
}

// interiorPoint — точка ЗАВЕДОМО внутри кольца, не на границе. Берём
// горизонталь ровно посередине между двумя соседними по высоте вершинами
// (на такой высоте ни одна вершина не лежит, значит вырожденных пересечений
// не будет), пересекаем её с кольцом и возвращаем середину самого широкого
// внутреннего отрезка — самое "глубокое" место, какое даёт один проход.
function interiorPoint(ring) {
  const n = ringSize(ring);
  if (n < 3) return null;
  const ys = [];
  for (let i = 0; i < n; i++) ys.push(ring[i][1]);
  ys.sort((a, b) => a - b);
  let y = null;
  for (let i = Math.floor(n / 2); i < n; i++) {
    if (ys[i] !== ys[i - 1]) {
      y = (ys[i] + ys[i - 1]) / 2;
      break;
    }
  }
  if (y === null) {
    for (let i = 1; i < n; i++) {
      if (ys[i] !== ys[i - 1]) {
        y = (ys[i] + ys[i - 1]) / 2;
        break;
      }
    }
  }
  if (y === null) return null; // кольцо-отрезок, нулевой высоты
  const xs = [];
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = ring[i][1], yj = ring[j][1];
    if (yi > y === yj > y) continue;
    xs.push(ring[i][0] + ((ring[j][0] - ring[i][0]) * (y - yi)) / (yj - yi));
  }
  if (xs.length < 2) return null;
  xs.sort((a, b) => a - b);
  let bestX = null, bestW = -1;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    const w = xs[i + 1] - xs[i];
    if (w > bestW) {
      bestW = w;
      bestX = (xs[i] + xs[i + 1]) / 2;
    }
  }
  if (bestX === null || bestW <= 0) return null;
  return [bestX, y];
}

// BBOX_SLACK — допуск габаритной проверки, в мировых единицах. Ровно та
// самая доля пикселя, на которую квантование может вытолкнуть внутреннюю
// полосу за внешнюю (см. коммент к subtractNested): без допуска такой кусок
// остался бы вообще без хозяина и не вырезался бы ниоткуда.
const BBOX_SLACK = 1;

function bboxCovers(outerBB, innerBB) {
  return (
    outerBB[0] - BBOX_SLACK <= innerBB[0] &&
    outerBB[1] - BBOX_SLACK <= innerBB[1] &&
    outerBB[2] + BBOX_SLACK >= innerBB[2] &&
    outerBB[3] + BBOX_SLACK >= innerBB[3]
  );
}

// ringSize — число РАЗНЫХ вершин кольца: кольца polygon-clipping (и worldRect)
// замкнуты, то есть последняя точка повторяет первую, и считать её второй раз
// незачем.
function ringSize(ring) {
  const n = ring.length;
  if (n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1]) return n - 1;
  return n;
}

function ringBBox(ring) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ring) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

// ringArea — площадь по формуле шнуровки (знак — направление обхода, здесь не
// важен, берём модуль).
function ringArea(ring) {
  const n = ringSize(ring);
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return a / 2;
}

// pointInRing — тот же чётно-нечётный тест, что geometry.js:pointInPolygon, но
// для колец в формате polygon-clipping ([x,y]-пары, а не {x,y}).
function pointInRing(ring, x, y) {
  const n = ringSize(ring);
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
