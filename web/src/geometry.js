// Чистая геометрия — перенесена из static/js/app.js дословно (та же
// математика), но без закрытия над мутируемым `scene`/`camera` из исходного
// IIFE: все входные коллекции (walls/tokens/fogAreas/grid) передаются
// аргументами, а не читаются из внешнего замыкания. Это не меняет поведение,
// только делает функции честно чистыми — вызывающая сторона (interaction.js)
// сама решает, что подставить (обычно ctx.scene.*).

// raySegmentT — параметр t пересечения луча (ox,oy)+(dx,dy) со отрезком
// (ax,ay)-(bx,by), либо null если луч параллелен стене или пересечение вне
// отрезка/позади источника.
export function raySegmentT(ox, oy, dx, dy, ax, ay, bx, by) {
  const ex = bx - ax, ey = by - ay;
  const det = ex * dy - ey * dx;
  if (Math.abs(det) < 1e-9) return null; // луч параллелен стене
  const acx = ax - ox, acy = ay - oy;
  const t = (ex * acy - ey * acx) / det;
  const u = (dx * acy - dy * acx) / det;
  if (t < 0 || u < 0 || u > 1) return null;
  return t;
}

// computeVisibilityPolygon — видимый многоугольник от точки (ox,oy) с учётом
// стен. Классический raycasting: луч в сторону каждого конца стены (±
// крошечный угол, чтобы поймать край) плюс равномерная решётка углов для
// гладкой дуги радиуса там, где стен нет. walls: [{x1,y1,x2,y2}, ...].
//
// ВАЖНО: atan2 всегда возвращает угол в (-π, π], поэтому решётка углов
// окружности должна использовать тот же диапазон, а не [0, 2π) — иначе
// физически соседние направления получают сильно разные числа, сортировка
// разносит их по разным концам массива, и "веер" видимости соединяет
// несмежные точки диагональю через всю освещённую область.
export function computeVisibilityPolygon(ox, oy, radius, walls) {
  const EPS = 0.00001;
  const angles = new Set();
  const STEPS = 48;
  for (let i = 0; i < STEPS; i++) angles.add(-Math.PI + (i / STEPS) * Math.PI * 2);
  for (const w of walls) {
    for (const [wx, wy] of [[w.x1, w.y1], [w.x2, w.y2]]) {
      const a = Math.atan2(wy - oy, wx - ox);
      angles.add(a - EPS);
      angles.add(a);
      angles.add(a + EPS);
    }
  }
  const pts = [];
  for (const a of angles) {
    const dx = Math.cos(a), dy = Math.sin(a);
    let minT = radius;
    for (const w of walls) {
      const t = raySegmentT(ox, oy, dx, dy, w.x1, w.y1, w.x2, w.y2);
      if (t !== null && t < minT) minT = t;
    }
    pts.push({ x: ox + dx * minT, y: oy + dy * minT, a });
  }
  pts.sort((p, q) => p.a - q.a);
  return pts;
}

// distToSegment — расстояние от точки до отрезка (для поиска ближайшей
// стены под курсором).
export function distToSegment(px, py, x1, y1, x2, y2) {
  const { cx, cy } = closestPointOnSegment(px, py, x1, y1, x2, y2);
  return Math.hypot(px - cx, py - cy);
}

// closestPointOnSegment — ближайшая к (px,py) точка НА отрезке (x1,y1)-(x2,y2)
// (проекция, зажатая в [0,1] по длине отрезка) — {cx,cy}. Используется и
// distToSegment (нужно только расстояние), и вставкой новой точки в стену
// (splitWallAt в interaction.js — там нужна сама точка на линии, а не
// сырая позиция курсора, иначе новая вершина "спрыгивает" со стены).
export function closestPointOnSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  return { cx: x1 + t * dx, cy: y1 + t * dy };
}

// wallNear — id ближайшей стены к (x,y) в пределах screenPx экранных
// пикселей (переведённых в мировые единицы через текущий scale), либо null.
// walls: { [id]: {x1,y1,x2,y2} }.
export function wallNear(x, y, walls, scale, screenPx = 12) {
  const threshold = screenPx / scale;
  let best = null, bestDist = threshold;
  for (const id in walls) {
    const w = walls[id];
    const d = distToSegment(x, y, w.x1, w.y1, w.x2, w.y2);
    if (d < bestDist) {
      best = id;
      bestDist = d;
    }
  }
  return best;
}

// ---- точки стен (вершины) — см. web/src/vtt/interaction.js ----
//
// Стены хранятся как независимые отрезки {id,x1,y1,x2,y2} (см.
// domain.Wall) — общих вершин между ними в данных нет. "Точка"/"вершина" тут
// не отдельная сущность, а координата: концы РАЗНЫХ стен, у которых она
// совпадает (угол комнаты), группируются на лету по факту совпадения
// координат — это и даёт "точки, которые двигаются/удаляются группой".
const WALL_VERTEX_EPS = 0.5; // мировые px — "то же самое место"

// Группировка концов стен — наивно O(n²) (каждый новый конец сравнивается со
// ВСЕМИ уже найденными вершинами): при паре сотен стен (сотни вершин) это
// сотни тысяч Math.hypot за один вызов, а wallVertices дёргается на КАЖДОЕ
// mousemove при драге точки/рисовании цепочки (interaction.js) — то есть
// десятки раз в секунду. Это и была причина заметных подлагиваний. Ключ по
// ячейке сетки со стороной 2×EPS сводит поиск "есть ли рядом точка" к
// перебору 3×3 соседних ячеек (там их считаные единицы) вместо всех вершин
// сразу — тот же результат группировки, на порядки дешевле (сама раскладка
// по ячейкам — inline в addRef ниже).

// wallVertices — уникальные концы всех стен, сгруппированные по совпадению
// координат, в {x, y, refs: [{wallId, which}, ...]} (which: 1 — x1/y1, 2 —
// x2/y2). walls: { [id]: {x1,y1,x2,y2} }.
export function wallVertices(walls) {
  const cellSize = WALL_VERTEX_EPS * 2; // >= EPS: любые две точки ближе EPS лежат в одной или соседней ячейке
  const buckets = new Map(); // "cx,cy" -> вершины этой ячейки
  const verts = [];
  const addRef = (x, y, wallId, which) => {
    const cx = Math.floor(x / cellSize), cy = Math.floor(y / cellSize);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = buckets.get((cx + dx) + "," + (cy + dy));
        if (!bucket) continue;
        for (const v of bucket) {
          if (Math.hypot(v.x - x, v.y - y) < WALL_VERTEX_EPS) {
            v.refs.push({ wallId, which });
            return;
          }
        }
      }
    }
    const v = { x, y, refs: [{ wallId, which }] };
    verts.push(v);
    const key = cx + "," + cy;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(v);
  };
  for (const id in walls) {
    const w = walls[id];
    addRef(w.x1, w.y1, id, 1);
    addRef(w.x2, w.y2, id, 2);
  }
  return verts;
}

// weldWalls — то же "склеивание близких концов", но грубее (eps в мировых px,
// на порядок больше WALL_VERTEX_EPS) и не для редактирования, а для САМОГО
// РАСЧЁТА видимости (см. layers/vision-fog.js). Угол комнаты, нарисованный
// вручную ДО появления точек-вершин (или просто не до конца примагниченный
// DM'ом), почти никогда не совпадает координатами бит-в-бit — а
// computeVisibilityPolygon корректен только на ТОЧНО замкнутом контуре: щель
// в несколько пикселей пропускает один луч насквозь, и токен ВНУТРИ формально
// огороженной комнаты видит всю карту (см. историю бага). weldWalls не
// трогает сохранённые данные стен — только копию, которая идёт в raycasting,
// поэтому не мешает точному редактированию через wallVertices/snapToWallVertex
// выше. eps подобран заметно меньше типичного дверного проёма, чтобы не
// заваривать его тоже.
export function weldWalls(wallList, eps = 12) {
  const cellSize = eps * 2;
  const buckets = new Map();
  function weld(x, y) {
    const cx = Math.floor(x / cellSize), cy = Math.floor(y / cellSize);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = buckets.get((cx + dx) + "," + (cy + dy));
        if (!bucket) continue;
        for (const p of bucket) {
          if (Math.hypot(p.x - x, p.y - y) < eps) return p;
        }
      }
    }
    const p = { x, y };
    const key = cx + "," + cy;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(p);
    return p;
  }
  return wallList.map((w) => {
    const a = weld(w.x1, w.y1);
    const b = weld(w.x2, w.y2);
    return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  });
}

// ---- двери/окна в стенах (domain.Wall.Door/DoorState/Window, как в Foundry —
// см. web/src/vtt/layers/doors.js, interaction.js) ----

// wallBlocksSight — блокирует ли этот сегмент обзор ПРЯМО СЕЙЧАС: окно —
// никогда, дверь — только пока не открыта (closed/locked блокируют как
// обычная стена, open — нет), обычная стена — всегда. Используется
// vision-fog.js ПЕРЕД raycasting'ом (фильтрует стены до weldWalls), а не
// внутри самого computeVisibilityPolygon — так открытая дверь/окно просто не
// участвуют в лучах вообще, без отдельной ветки в геометрии.
export function wallBlocksSight(w) {
  if (w.window) return false;
  if (w.door && w.doorState === "open") return false;
  return true;
}

// wallMidpoint — точка значка двери (середина сегмента).
export function wallMidpoint(w) {
  return { x: (w.x1 + w.x2) / 2, y: (w.y1 + w.y2) / 2 };
}

// doorAt — id ближайшей двери (по значку в СЕРЕДИНЕ стены, не по всей линии)
// к (x,y) в пределах screenPx экранных px, либо null. includeSecret=false —
// не учитывать секретные двери (клиентский хит-тест для игрока и для чужого
// клика ДМ мимо инструмента "выбор"; настоящая защита секретных/запертых
// дверей — на сервере, см. service.Room.handleToggleDoor). walls: { [id]:
// {x1,y1,x2,y2,door,...} }.
export function doorAt(x, y, walls, scale, includeSecret, screenPx = 16) {
  const threshold = screenPx / scale;
  let best = null,
    bestDist = threshold;
  for (const id in walls) {
    const w = walls[id];
    if (!w.door) continue;
    if (w.door === "secret" && !includeSecret) continue;
    const { x: mx, y: my } = wallMidpoint(w);
    const d = Math.hypot(mx - x, my - y);
    if (d < bestDist) {
      best = id;
      bestDist = d;
    }
  }
  return best;
}

// wallVertexNear — ближайшая вершина к (x,y) в пределах screenPx экранных
// пикселей, либо null. Та же идиома, что wallNear, но для точек, не стен
// целиком — используется для драга точки и ПКМ-меню "удалить точку".
export function wallVertexNear(x, y, walls, scale, screenPx = 10) {
  const threshold = screenPx / scale;
  let best = null, bestDist = threshold;
  for (const v of wallVertices(walls)) {
    const d = Math.hypot(v.x - x, v.y - y);
    if (d < bestDist) {
      best = v;
      bestDist = d;
    }
  }
  return best;
}

// snapToWallVertex — примагничивание при рисовании/перетаскивании: ближайшая
// вершина в пределах screenPx, кроме тех, чьи refs входят в excludeRefs (сама
// перетаскиваемая точка не должна прилипать сама к себе). Возвращает {x,y}
// или null, если ничего в пороге — именно точное совпадение координат с
// соседней стеной (не просто "рядом") устраняет щели в углах, из-за которых
// computeVisibilityPolygon даёт "осколки" тени/света на стыках стен.
export function snapToWallVertex(x, y, walls, scale, excludeRefs, screenPx = 14) {
  const threshold = screenPx / scale;
  let best = null, bestDist = threshold;
  for (const v of wallVertices(walls)) {
    if (excludeRefs && v.refs.some((r) => excludeRefs.some((e) => e.wallId === r.wallId && e.which === r.which))) continue;
    const d = Math.hypot(v.x - x, v.y - y);
    if (d < bestDist) {
      best = v;
      bestDist = d;
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}

// pointInPolygon — классический ray-casting четырёхугольник/многоугольник.
export function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, yi = points[i].y;
    const xj = points[j].x, yj = points[j].y;
    const hit = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

// fogAreaAt — id фигуры ручного тумана, содержащей точку (x,y), либо null.
// fogAreas: { [id]: {points: [{x,y}, ...]} }.
export function fogAreaAt(x, y, fogAreas) {
  for (const id in fogAreas) {
    const area = fogAreas[id];
    if (area.points.length >= 3 && pointInPolygon(x, y, area.points)) return id;
  }
  return null;
}

// fogVertexNear — ближайшая вершина фигуры ручного тумана к (x,y) в пределах
// screenPx экранных пикселей, либо null — {areaId, index, x, y}. Та же идиома,
// что wallVertexNear, но точки фигуры тумана не группируются между разными
// фигурами (в отличие от стен, углы разных облаков тумана не обязаны
// склеиваться) — index прямо указывает на area.points[index], которую
// перетаскивание в interaction.js подменяет на новую позицию (переформовка
// контура).
export function fogVertexNear(x, y, fogAreas, scale, screenPx = 10) {
  const threshold = screenPx / scale;
  let best = null, bestDist = threshold;
  for (const id in fogAreas) {
    const area = fogAreas[id];
    for (let i = 0; i < area.points.length; i++) {
      const p = area.points[i];
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestDist) {
        best = { areaId: id, index: i, x: p.x, y: p.y };
        bestDist = d;
      }
    }
  }
  return best;
}

// buildingAt — id здания, содержащего точку (x,y), либо null. Та же идиома,
// что fogAreaAt (см. domain.Building — точки замкнутого контура, без
// дублирования первой точки в конце). Используется и для ПКМ-удаления (см.
// interaction.js), и в layers/buildings-roof.js для "крыши" на клиенте
// игрока.
export function buildingAt(x, y, buildings) {
  for (const id in buildings) {
    const b = buildings[id];
    if (b.points.length >= 3 && pointInPolygon(x, y, b.points)) return id;
  }
  return null;
}

// tokenAt — id токена под точкой (x,y), либо null. tokens: { [id]: {x,y,size} }.
export function tokenAt(x, y, tokens) {
  for (const id in tokens) {
    const t = tokens[id];
    if (Math.hypot(t.x - x, t.y - y) < (t.size || 20)) return id;
  }
  return null;
}

// noteMarkerAt — id значка заметки (domain.NoteMarker) под точкой (x,y), либо
// null. Радиус хит-теста следует размеру САМОГО значка (marker.size — см.
// layers/note-markers.js), чтобы увеличенный ДМ-ом значок было так же легко
// подцепить мышью, как и уменьшенный — не подцепить меньше видимой иконки.
export function noteMarkerAt(x, y, noteMarkers, minRadius = 16) {
  for (const id in noteMarkers) {
    const m = noteMarkers[id];
    const r = Math.max(minRadius, (m.size || 0) / 2);
    if (Math.abs(m.x - x) < r && Math.abs(m.y - y) < r) return id;
  }
  return null;
}

// snapToGrid — ближайший центр клетки сетки к точке (x,y). grid: {size,offsetX,offsetY}.
export function snapToGrid(x, y, grid) {
  if (!grid || !grid.size || grid.size <= 0) return { x, y };
  const col = Math.round((x - grid.offsetX - grid.size / 2) / grid.size);
  const row = Math.round((y - grid.offsetY - grid.size / 2) / grid.size);
  return { x: grid.offsetX + col * grid.size + grid.size / 2, y: grid.offsetY + row * grid.size + grid.size / 2 };
}

// gridHandleCell — клетка сетки под точкой (cx,cy) (обычно центр вьюпорта,
// см. interaction.js/layers/grid.js: "ручка" редактора сетки). В отличие от
// snapToGrid (ближайший ЦЕНТР клетки), тут нужен именно охватывающий
// прямоугольник — Math.floor, а не round, чтобы клетка реально содержала
// точку (cx,cy), а не была ближайшей по центру соседней.
export function gridHandleCell(grid, cx, cy) {
  if (!grid || !grid.size || grid.size <= 0) return null;
  const size = grid.size;
  const offsetX = grid.offsetX || 0;
  const offsetY = grid.offsetY || 0;
  const col = Math.floor((cx - offsetX) / size);
  const row = Math.floor((cy - offsetY) / size);
  const x0 = offsetX + col * size;
  const y0 = offsetY + row * size;
  return { col, row, x0, y0, size };
}

// gridChebyshevDistance — расстояние между (0,0) и (dx,dy) в МИРОВЫХ px по
// правилам открытого перемещения D&D 5e: диагональный шаг стоит столько
// же, сколько шаг по стороне клетки — это Chebyshev-метрика
// (max(|dx|,|dy|)), а НЕ честный Евклид (гипотенуза). Раньше здесь был
// Math.hypot — из-за этого диагональный драг на 2 клетки вправо + 1 вниз
// (5-футовая сетка) показывал "11.2 фт" (√5 клеток) вместо ожидаемых по
// столовым правилам "10 фт" (2 клетки, диагональ не длиннее прямого хода).
// Непрерывная, БЕЗ округления до целой клетки — используется и для лимита
// скорости (см. interaction.js), которому нужна гладкая граница драга, а
// не ступенчатая. Целыми клетками считает gridCellsBetween ниже — она и
// нужна для подписи, которую видит игрок. Без сетки считать «клетками»
// нечего — честный Евклид в px, единственное, что тут вообще есть.
export function gridChebyshevDistance(dx, dy, grid) {
  if (grid && grid.size > 0) return Math.max(Math.abs(dx), Math.abs(dy));
  return Math.hypot(dx, dy);
}

// cellsFromWorldDistance — уже готовое скалярное расстояние в МИРОВЫХ px →
// целое число клеток сетки (за столом дистанцию считают по клеткам, а не
// с точностью до пикселя линейки — итоговая цифра, которую видит игрок,
// всегда кратна клетке). null, если сетка выключена — целых клеток без
// сетки не бывает.
export function cellsFromWorldDistance(worldDist, grid) {
  if (!grid || !grid.size || grid.size <= 0) return null;
  return Math.round(worldDist / grid.size);
}

// gridCellsBetween — то же самое, но сама дистанция между двумя точками
// сперва считается по Chebyshev (см. gridChebyshevDistance выше) — для
// разового замера "точка A → точка B" (линейка, конец обычного драга).
export function gridCellsBetween(dx, dy, grid) {
  return cellsFromWorldDistance(gridChebyshevDistance(dx, dy, grid), grid);
}

// unitsFromWorldDistance/worldDistanceToUnits — готовое скалярное
// расстояние (либо dx/dy двух точек) в МИРОВЫХ px → единицы линейки сцены
// (GridSettings.Unit/UnitsPerCell), округлённые до целой клетки. null, если
// сетка выключена. unitsFromWorldDistance нужна отдельно от
// worldDistanceToUnits для НАКОПЛЕННОГО пройденного пути (см.
// trackMovementStep ниже) — это уже не прямая Chebyshev-дистанция между
// стартом и текущей позицией, а сумма шагов за весь жест, её незачем (и
// нельзя корректно) пересчитывать заново по двум точкам.
export function unitsFromWorldDistance(worldDist, grid) {
  const cells = cellsFromWorldDistance(worldDist, grid);
  if (cells == null) return null;
  return cells * (grid.unitsPerCell || 1);
}
export function worldDistanceToUnits(dx, dy, grid) {
  const cells = gridCellsBetween(dx, dy, grid);
  if (cells == null) return null;
  return cells * (grid.unitsPerCell || 1);
}

// unitsToWorldDistance — обратное преобразование: сколько мировых px в
// заданном числе единиц линейки сцены (например, скорость персонажа в
// футах — domain.CombatStats.Speed). Это чистое линейное масштабирование
// (не зависит от метрики/округления выше — тут нет двух точек, которые
// можно мерить по-разному, только один множитель клетки), поэтому не
// округляется до целой клетки — используется как непрерывный порог для
// плавного лимита скорости. Infinity, если сетка выключена — лимит в
// мировых px тогда посчитать нельзя, вызывающая сторона трактует Infinity
// как "ограничение неприменимо".
export function unitsToWorldDistance(units, grid) {
  if (!grid || !grid.size || grid.size <= 0) return Infinity;
  const perCell = grid.unitsPerCell || 1;
  return (units / perCell) * grid.size;
}

// fmtUnitNumber — один знак после запятой, без лишнего ".0".
function fmtUnitNumber(n) {
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

// formatDistanceValue/formatDistance — человекочитаемая подпись расстояния
// в формате, настроенном ДМ для карты (grid.unit, по умолчанию "фт"), по
// правилам открытого перемещения D&D 5e — округлено до целой клетки. Без
// сетки показываем как есть, в мировых px. formatDistance берёт две точки
// (разовый замер линейкой), formatDistanceValue — уже готовое скалярное
// расстояние (накопленный путь, см. trackMovementStep). maxUnits —
// необязательный потолок В ЕДИНИЦАХ ЛИНЕЙКИ (не px — например, скорость
// персонажа как есть, без unitsToWorldDistance): если задан, подпись
// становится "15/30 фт" — сколько прошёл из скольки доступно (лимит
// скорости в бою, см. interaction.js), а не просто "сколько прошёл".
export function formatDistanceValue(worldDist, grid, maxUnits) {
  const units = unitsFromWorldDistance(worldDist, grid);
  if (units == null) return Math.round(worldDist) + " px";
  const unitLabel = grid.unit || "фт";
  if (maxUnits != null) return `${fmtUnitNumber(units)}/${fmtUnitNumber(maxUnits)} ${unitLabel}`;
  return `${fmtUnitNumber(units)} ${unitLabel}`;
}
export function formatDistance(dx, dy, grid) {
  return formatDistanceValue(gridChebyshevDistance(dx, dy, grid), grid);
}

// trackMovementStep — один шаг «одометра» перемещения токена за один
// mousemove: к уже накопленному пройденному расстоянию (traveled)
// прибавляется стоимость хода из lastPos в rawTarget (Chebyshev-клетки —
// см. gridChebyshevDistance: боком/по диагонали тоже прибавляется, а не
// вычитается, ровно как реальные шаги персонажа). Если бюджета
// (maxAllowed, мировые px; Infinity — лимита нет) не хватает на весь ход —
// токен останавливается РОВНО там, где бюджет заканчивается (интерполяция
// по прямой от lastPos к rawTarget), а не блокируется целиком и не
// проезжает мимо.
//
// Возврат РОВНО в стартовую точку всего жеста (dragStart) — особый случай,
// проверяется ДО клэмпа по бюджету и обходит его безусловно: это жест
// "передумал — отпускаю там же, откуда взял" (см. ТЗ: "вернул персонажа —
// верни движение"), а не ещё один шаг, который надо оплачивать скоростью.
// Без этой развязки персонаж, исчерпавший весь бюджет уходя в одну
// сторону, не смог бы вернуться назад ВООБЩЕ (шаг назад стоит ровно
// столько же, сколько шаг вперёд — а бюджета уже 0) — обычный клэмп ниже
// удерживал бы его намертво на границе, и единственный способ отменить
// перемещение (для этого весь механизм и задуман) оказался бы недоступен
// именно тогда, когда он нужнее всего. Любой ДРУГОЙ шаг назад/вбок,
// не доходящий ровно до dragStart, по-прежнему подчиняется общему клэмпу
// и прибавляется к одометру, как обычно.
export function trackMovementStep(lastPos, rawTarget, dragStart, traveled, maxAllowed, grid) {
  if (Math.abs(rawTarget.x - dragStart.x) < 0.01 && Math.abs(rawTarget.y - dragStart.y) < 0.01) {
    return { pos: rawTarget, traveled: 0 };
  }
  const step = gridChebyshevDistance(rawTarget.x - lastPos.x, rawTarget.y - lastPos.y, grid);
  let pos = rawTarget;
  let nextTraveled = traveled + step;
  if (nextTraveled > maxAllowed) {
    const allowedStep = Math.max(0, maxAllowed - traveled);
    const ratio = step > 0 ? allowedStep / step : 0;
    pos = { x: lastPos.x + (rawTarget.x - lastPos.x) * ratio, y: lastPos.y + (rawTarget.y - lastPos.y) * ratio };
    nextTraveled = traveled + allowedStep;
  }
  return { pos, traveled: nextTraveled };
}

// isVideoUrl — по расширению отличает mp4/webm-фон/арт от обычной картинки.
export function isVideoUrl(url) {
  return /\.(mp4|webm|m4v)(\?|#|$)/i.test(url || "");
}

// hexToRgba — тот же хелпер, что был в app.js, используется и сеткой (canvas
// hexToRgba), и — в виде hex→int — цветными Pixi Graphics (см. layers/grid.js).
export function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  if (!m) return `rgba(255, 255, 255, ${alpha})`;
  const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// hexToInt — "#rrggbb" -> 0xrrggbb, для PIXI.Graphics.fill/stroke (которые
// принимают числовой цвет, а не CSS-строку).
export function hexToInt(hex, fallback = 0xffffff) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  return m ? parseInt(m[1], 16) : fallback;
}
