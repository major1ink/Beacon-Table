// fog-painting.test.js — регрессия на "странные тени": резкие треугольные
// клинья и чёрные пятна с прямыми краями там, где всё должно быть освещено.
//
// Причина не в геометрии освещения (она считается верно, см.
// vision-fog-geometry.test.js), а в том, КАК готовый план отдавался Pixi.
// Graphics.cut() не принимает "из чего вырезать" — он сам ищет цель среди
// последних двух инструкций контекста, поэтому:
//   * заливка, вклиненная между вырезами (заплатка на дыру острова),
//     перехватывала вырез следующего острова — остров оставался чёрным;
//   * повторный cut() по той же заливке не останавливался на ней и вешал
//     дыру ещё и на СОСЕДНИЙ остров — earcut соединял её с контуром
//     перемычкой, давая тонкий треугольный клин.
// Подробности и правило — в light-geometry.js ("ПРАВИЛО РАБОТЫ С Pixi cut()").
//
// Тест гоняет НАСТОЯЩИЙ Pixi GraphicsContext (без WebGL, ему нужен только
// минимальный navigator) и проверяет инвариант напрямую по инструкциям:
// у каждой заливки ровно те дыры, которые ей предназначались.
import test from "node:test";
import assert from "node:assert/strict";

// Pixi при импорте читает navigator (определение окружения/GPU). Канвас и
// WebGL для GraphicsContext не нужны — он чистая структура данных.
// В Node 22 у globalThis.navigator появился собственный getter без сеттера —
// прежнее `globalThis.navigator = ...` роняло весь файл ещё до первого
// теста ("Cannot set property navigator of #<Object> which has only a
// getter"). Присваиваем только если свойства нет вовсе, иначе — оставляем
// родное navigator Node'ы, Pixi устраивает и оно.
if (!globalThis.navigator) {
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node" }, configurable: true });
}
globalThis.self = globalThis.self || globalThis;

const { GraphicsContext } = await import("pixi.js");
const { cutMulti, fillMulti } = await import("../src/vtt/light-geometry.js");

const W = 1000, H = 1000;
const DARK = { color: 0x06060a, alpha: 0.96 };
const DIM = { color: 0x06060a, alpha: 0.55 };

// rect — прямоугольное кольцо в формате polygon-clipping ([x,y]-пары).
const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];

// holePoints — все точки, попавшие в дыру данной fill-инструкции, как
// плоский список координат: по ним легко проверить, чьё это кольцо.
function holePoints(instruction) {
  const hole = instruction.data.hole;
  if (!hole) return [];
  const pts = [];
  for (const ins of hole.instructions) {
    if (ins.action === "poly") pts.push(...ins.data[0]);
  }
  return pts;
}
const covers = (pts, ring) => ring.every(([x, y]) => {
  for (let i = 0; i < pts.length; i += 2) if (pts[i] === x && pts[i + 1] === y) return true;
  return false;
});
const touches = (pts, ring) => ring.some(([x, y]) => {
  for (let i = 0; i < pts.length; i += 2) if (pts[i] === x && pts[i + 1] === y) return true;
  return false;
});

test("остров после дырявого острова всё равно вырезается из тьмы", () => {
  // Раньше: заплатка на дыру острова A вклинивалась между cut(A) и cut(B),
  // перехватывала cut(B) на себя — и B оставался залит сплошной тьмой.
  const withHole = [rect(100, 100, 300, 300), rect(180, 180, 100, 100)];
  const plain = [rect(600, 600, 300, 300)];

  const g = new GraphicsContext();
  g.rect(0, 0, W, H).fill(DARK);
  cutMulti(g, [withHole, plain], W, H, DARK);

  const base = g.instructions[0];
  const pts = holePoints(base);
  assert.ok(covers(pts, withHole[0]), "остров с дырой не вырезан из тьмы");
  assert.ok(covers(pts, plain[0]), "остров ПОСЛЕ дырявого не вырезан из тьмы — он останется чёрным пятном");

  // Заплатка нарисована и сама дыр не набрала.
  const patch = g.instructions[1];
  assert.equal(patch.action, "fill");
  assert.equal(holePoints(patch).length, 0, "в заплатку уехал чужой вырез");
});

test("порядок вырезов не зависит от того, где в списке стоит дырявый остров", () => {
  const withHole = [rect(100, 100, 300, 300), rect(180, 180, 100, 100)];
  const a = [rect(600, 100, 200, 200)];
  const b = [rect(600, 600, 200, 200)];
  for (const order of [[withHole, a, b], [a, withHole, b], [a, b, withHole]]) {
    const g = new GraphicsContext();
    g.rect(0, 0, W, H).fill(DARK);
    cutMulti(g, order, W, H, DARK);
    const pts = holePoints(g.instructions[0]);
    for (const island of order) {
      assert.ok(covers(pts, island[0]), `остров не вырезан при порядке ${order.indexOf(island)}`);
    }
  }
});

test("яркие куски острова не протекают в заливку соседнего острова", () => {
  // Раньше: остров с дырой + отдельный cut() ярких кусков => второй cut()
  // по той же заливке не останавливался и вешал дыру на ПРЕДЫДУЩИЙ остров.
  const island1 = [rect(100, 100, 200, 200)];
  const island2 = [rect(500, 100, 300, 300), rect(560, 160, 80, 80)]; // с дырой
  const bright2 = [[rect(600, 250, 60, 60)]];

  const g = new GraphicsContext();
  fillMulti(g, [island1], W, H, DIM, [], DIM);
  fillMulti(g, [island2], W, H, DIM, bright2, DIM);

  const fills = g.instructions.filter((i) => i.action === "fill");
  const first = fills[0];
  assert.ok(!touches(holePoints(first), bright2[0][0]), "яркий кусок второго острова уехал дырой в заливку первого — это и есть клин-призрак");

  const second = fills[1];
  const pts2 = holePoints(second);
  assert.ok(covers(pts2, island2[1]), "собственная дыра острова не вырезана");
  assert.ok(covers(pts2, bright2[0][0]), "яркий кусок не вырезан из тусклой дымки своего острова");
});

test("на каждую заливку приходится не больше одного cut()", () => {
  // Инвариант из light-geometry.js: второй cut() по той же заливке — это и
  // есть путь, которым дыра уезжает в соседнюю фигуру. Считаем cut()'ы,
  // подменив метод контекста.
  const g = new GraphicsContext();
  const perFill = [];
  const origCut = g.cut.bind(g);
  const origFill = g.fill.bind(g);
  g.fill = (s) => { perFill.push(0); return origFill(s); };
  g.cut = () => { perFill[perFill.length - 1]++; return origCut(); };

  g.rect(0, 0, W, H).fill(DARK);
  cutMulti(g, [
    [rect(100, 100, 200, 200), rect(140, 140, 60, 60)],
    [rect(400, 400, 200, 200)],
    [rect(700, 700, 200, 200), rect(740, 740, 60, 60)],
  ], W, H, DARK);
  fillMulti(g, [[rect(50, 700, 100, 100), rect(70, 720, 30, 30)]], W, H, DIM, [[rect(60, 760, 20, 20)]], DIM);

  assert.deepEqual(perFill.filter((n) => n > 1), [], `есть заливки с несколькими cut(): ${perFill}`);
});

test("вырожденные кольца пропускаются, а не ломают вырез соседей", () => {
  const degenerate = [[[10, 10], [11, 10], [10, 10]]]; // < 4 точек
  const real = [rect(400, 400, 200, 200)];
  const g = new GraphicsContext();
  g.rect(0, 0, W, H).fill(DARK);
  cutMulti(g, [degenerate, real], W, H, DARK);
  assert.ok(covers(holePoints(g.instructions[0]), real[0]));
});

test("пустой список не оставляет висячий cut()", () => {
  // Без островов cut() звать нельзя: он вырезал бы вырожденный остаток пути
  // от предыдущей инструкции прямо из заливки тьмы.
  const g = new GraphicsContext();
  g.rect(0, 0, W, H).fill(DARK);
  cutMulti(g, [], W, H, DARK);
  assert.equal(holePoints(g.instructions[0]).length, 0);
});
