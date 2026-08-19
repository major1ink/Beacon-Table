import { Graphics } from "pixi.js";
import { canvasPos, screenToWorld, getTransform, zoomAt, resetCamera } from "./camera.js";
import {
  tokenAt,
  snapToGrid,
  wallNear,
  wallVertexNear,
  snapToWallVertex,
  closestPointOnSegment,
  fogAreaAt,
  fogVertexNear,
  buildingAt,
  noteMarkerAt,
  gridHandleCell,
  formatDistance,
  formatDistanceValue,
  unitsToWorldDistance,
  trackMovementStep,
} from "../geometry.js";
import { NOTE_MARKER_MIN_SIZE, NOTE_MARKER_MAX_SIZE } from "./layers/note-markers.js";
import { createRulerLine, createDistanceLabel } from "./ruler.js";
import { fetchCharacter } from "../api.js";

// EDGE_HIT_PX — порог (в экранных px) для попадания в край "ручки"
// редактора сетки (см. tool "grid-edit" ниже): ближе к краю квадрата — это
// ресайз, дальше вглубь — перетаскивание всей сетки.
const EDGE_HIT_PX = 10;

// Мышь/инструменты ДМ + драг своего токена у игрока. Порт мышиной части
// static/js/app.js почти без изменений в самой ЛОГИКЕ (те же ветвления по
// инструменту, те же условия commit/cancel) — но hit-тесты и координатная
// математика теперь дёргают чистые функции geometry.js/camera.js, а не
// закрытые внутри draw() ctx-вызовы. Сознательно НЕ переведено на
// PIXI-события конкретных спрайтов (sprite.eventMode/pointerdown) — обычные
// DOM-слушатели на canvas + geometry.tokenAt для хит-теста дают тот же
// результат при заметно меньшем риске (это уже проверенная логика,
// один в один как до переезда), а drag "за пределы" спрайта на федеративных
// Pixi-событиях потребовал бы отдельной аккуратной работы с
// stage-уровневыми globalpointermove, которую негде было бы живьём
// проверить в этой среде. Камере/миру от Pixi нужен только readout текущего
// масштаба (ctx.world.scale.x) — сама хит-геометрия по-прежнему в мировых
// координатах.
export function createInteraction(ctx) {
  const canvas = ctx.canvas;

  function screenW() {
    return ctx.app.screen.width;
  }
  function screenH() {
    return ctx.app.screen.height;
  }

  function mousePos(e) {
    const { sx, sy } = canvasPos(e, canvas);
    return screenToWorld(sx, sy, screenW(), screenH(), ctx.scene, ctx.camera);
  }

  // markCameraDirty — на pan/zoom геометрия LOS/тумана НЕ пересчитывается
  // (она в мировых координатах и двигается вместе с миром бесплатно через
  // сцен-граф — см. dirty.js), но линии с фиксированной ЭКРАННОЙ толщиной
  // (сетка/стены/пунктир тумана у ДМ/кольцо владельца) обязаны
  // перестроиться под новый scale. Это дёшево (простая геометрия линий, не
  // raycasting/blur), поэтому дёргать на каждый шаг пана/зума безопасно.
  function markCameraDirty() {
    ctx.dirty.grid = true;
    ctx.dirty.walls = true;
    ctx.dirty.buildings = true;
    ctx.dirty.tokens = true;
    ctx.dirty.manualFog = true;
  }

  function applyCameraAndRender() {
    ctx.applyCameraTransform();
    markCameraDirty();
    ctx.render();
  }

  // ---- зум колесом, пан средней кнопкой — работают у всех трёх ролей ----
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const { sx, sy } = canvasPos(e, canvas);
      zoomAt(ctx.camera, sx, sy, e.deltaY < 0 ? 1.15 : 1 / 1.15, screenW(), screenH(), ctx.scene);
      applyCameraAndRender();
    },
    { passive: false }
  );

  let panning = null;
  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    const { sx, sy } = canvasPos(e, canvas);
    panning = { sx, sy, camX: ctx.camera.x, camY: ctx.camera.y };
  });
  window.addEventListener("mousemove", (e) => {
    if (!panning) return;
    const { sx, sy } = canvasPos(e, canvas);
    const { scale } = getTransform(screenW(), screenH(), ctx.scene, ctx.camera);
    ctx.camera.x = panning.camX - (sx - panning.sx) / scale;
    ctx.camera.y = panning.camY - (sy - panning.sy) / scale;
    applyCameraAndRender();
  });
  window.addEventListener("mouseup", (e) => {
    if (e.button === 1) panning = null;
  });

  document.addEventListener("vtt:zoomBy", (e) => {
    zoomAt(ctx.camera, screenW() / 2, screenH() / 2, e.detail, screenW(), screenH(), ctx.scene);
    applyCameraAndRender();
  });
  document.addEventListener("vtt:resetView", () => {
    resetCamera(ctx.camera, ctx.scene);
    applyCameraAndRender();
  });

  // tokenAt/snapToGrid используются и ДМ-инструментами ниже, и драгом
  // собственного токена у игрока — поэтому dragTokenId общий на оба блока.
  let dragTokenId = null;
  // dragNoteMarkerId — перетаскивание значка заметки (только ДМ, см. ниже) —
  // тот же приём, что dragTokenId: mousemove мутирует сцену на месте и шлёт
  // move_note_marker на каждый шаг.
  let dragNoteMarkerId = null;
  // resizeArmedNoteMarkerId — значок, для которого ПКМ-меню "📏 Изменить
  // размер" (см. pages/dm.js) включило режим резайза: следующий mousedown
  // ИМЕННО на этом значке начинает драг размера вместо перемещения (см.
  // resizingNoteMarkerId ниже), одноразово — снимается сразу, как только
  // драг начался. Отдельная переменная, а не сразу resizingNoteMarkerId,
  // чтобы клик мимо значка/смена инструмента не запускали резайз случайно.
  let resizeArmedNoteMarkerId = null;
  let resizingNoteMarkerId = null;

  // ---- превью-оверлей для инструментов "Стены"/"Туман" (эфемерно, не
  // проходит через dirty-слои — рисуется/чистится прямо на mousemove) ----
  const preview = new Graphics();
  ctx.world.addChild(preview);

  // ---- линейка (замер расстояния) + подсказка дистанции при драге токена —
  // общая пара графики/подписи и для ДМ, и для игрока (см. ruler.js): сам
  // инструмент "Линейка" и хвост, который тянется за токеном во время
  // перетаскивания, никогда не активны одновременно, поэтому одна пара на
  // оба сценария в обеих ролевых ветках ниже.
  const rulerLine = createRulerLine(ctx);
  const distanceLabel = createDistanceLabel(ctx);

  if (ctx.isDM) {
    // Единый активный инструмент вместо трёх независимых булевых флагов.
    let tool = "select"; // 'select' | 'attack' | 'wall' | 'building' | 'fog' | 'grid-edit'
    let attackFromId = null;
    // wallChainLast — последняя ЗАКОММИЧЕННАЯ точка текущей цепочки стен (см.
    // ниже); wallDragFrom — точка mousedown, пока цепочка ещё не начата (одно
    // "было" на двоих: либо цепочка уже идёт, либо мы ждём mouseup первого
    // клика/драга). draggingWallPoint — вершина существующей стены (см.
    // geometry.wallVertexNear), которую сейчас тащат в инструменте "выбор".
    let wallChainLast = null;
    let wallDragFrom = null;
    let draggingWallPoint = null;
    // draggingFogVertex/draggingFogArea — переформовка/перенос фигуры
    // ручного тумана инструментом "выбор" (см. mousedown/mousemove ниже):
    // draggingFogVertex — тащим ОДНУ вершину контура (index в area.points),
    // draggingFogArea — тащим фигуру целиком (клик внутри неё, не по
    // вершине) — original/startX/startY нужны, чтобы на каждый mousemove
    // применять смещение от исходных точек, а не накапливать дрейф
    // округления по одной и той же точке за много шагов подряд.
    let draggingFogVertex = null;
    let draggingFogArea = null;
    // buildingChain — вершины ещё НЕ отправленного на сервер здания (см. tool
    // "building" ниже). В отличие от wallChainLast, ничего не коммитится на
    // сервер по ходу рисования — ОДНО сообщение "add_building" со всеми
    // точками уходит только в момент явного замыкания контура (клик рядом со
    // стартовой точкой). Отмена (Esc/ПКМ/двойной клик/смена инструмента) на
    // любом шаге просто обнуляет buildingChain — на сервере не остаётся
    // никакого следа незамкнутой попытки (см. domain.Building: контур
    // обязан быть замкнут).
    let buildingChain = null;
    let fogPath = null;
    let gridDragStart = null; // {x,y,offsetX,offsetY} в мировых координатах
    // rulerFrom — стартовая точка текущего замера инструментом "Линейка"
    // (см. tool "ruler" ниже); dragStart/dragLastPos/dragTraveled —
    // "одометр" обычного перетаскивания токена (не завязан на конкретный
    // инструмент — драг токена доступен и в "select", поэтому переменные
    // отдельные от rulerFrom): dragStart — позиция на mousedown (только для
    // проверки "вернулся ровно в старт", см. geometry.trackMovementStep),
    // dragLastPos — последняя зафиксированная позиция (шаг считается от
    // неё, не от dragStart — боком/по диагонали тоже прибавляется, а не
    // вычитается), dragTraveled — накопленное расстояние этого жеста.
    let rulerFrom = null;
    let dragStart = null;
    let dragLastPos = null;
    let dragTraveled = 0;

    function setTool(name) {
      tool = name || "select";
      attackFromId = null;
      wallChainLast = null;
      wallDragFrom = null;
      draggingWallPoint = null;
      draggingFogVertex = null;
      draggingFogArea = null;
      buildingChain = null;
      fogPath = null;
      gridDragStart = null;
      rulerFrom = null;
      rulerLine.clear();
      distanceLabel.hide();
      preview.clear();
      // ctx.gridEditActive/ctx.gridEditHandle читает layers/grid.js — сама
      // подсветка "ручки" (красный квадрат) рисуется там на update(), тут
      // только считаем ЕЁ ОДИН РАЗ (по центру вьюпорта — см. gridHandleCell)
      // при входе в инструмент; дальше клетку двигает/ресайзит только сам
      // драг ниже (mousemove), НЕ пересчёт от камеры на каждый кадр — иначе
      // после переноса сетки клетка перестаёт быть "ближайшей к центру" и
      // подсветка перескакивает на соседнюю прямо на mouseup.
      ctx.gridEditActive = tool === "grid-edit";
      ctx.gridEditHandle = ctx.gridEditActive ? gridHandleCell(ctx.scene.grid, ctx.camera.x, ctx.camera.y) : null;
      if (!ctx.gridEditActive) canvas.style.cursor = "";
      ctx.dirty.grid = true;
      ctx.render();
      document.dispatchEvent(new CustomEvent("vtt:toolChanged", { detail: tool }));
    }
    document.addEventListener("vtt:setTool", (e) => setTool(e.detail));

    // sendAddWall — один сегмент цепочки стен (см. tool "wall" ниже).
    function sendAddWall(from, to) {
      ctx.send({ type: "add_wall", wall: { id: "wall-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6), x1: from.x, y1: from.y, x2: to.x, y2: to.y } });
    }

    // snappedPoint — точка (x,y) под курсором, примагниченная к ближайшей
    // существующей вершине стены в пороге (см. geometry.snapToWallVertex) —
    // именно точное совпадение координат на стыке убирает щели в углах,
    // из-за которых у computeVisibilityPolygon (light-geometry.js) на стыках
    // стен появлялись "осколки" тени/света. excludeRefs — точки, которые не
    // должны примагничиваться сами к себе (при драге существующей вершины).
    function snappedPoint(x, y, excludeRefs) {
      const scale = ctx.world.scale.x || 1;
      return snapToWallVertex(x, y, ctx.scene.walls, scale, excludeRefs) || { x, y };
    }

    // splitWallAt — вставляет новую точку посреди СУЩЕСТВУЮЩЕЙ стены
    // (инструмент "выбор", клик по линии стены, не по её концу — см.
    // mousedown ниже): делит её на две новые в точке вставки и сразу
    // подхватывает эту точку в draggingWallPoint — тем же жестом, которым
    // кликнули, можно потянуть новую вершину, не отпуская кнопку. Точка
    // вставки — проекция курсора НА линию стены (closestPointOnSegment), не
    // сырая позиция курсора, иначе вершина "спрыгивает" со стены при клике
    // чуть в стороне от неё; дальше — обычное примагничивание к соседним
    // вершинам (snappedPoint), поэтому новые точки прилипают друг к другу
    // так же, как и старые.
    function splitWallAt(wallId, w, x, y) {
      const proj = closestPointOnSegment(x, y, w.x1, w.y1, w.x2, w.y2);
      const snapped = snappedPoint(proj.cx, proj.cy, [
        { wallId, which: 1 },
        { wallId, which: 2 },
      ]);
      const base = "wall-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
      const wallA = { id: base + "a", x1: w.x1, y1: w.y1, x2: snapped.x, y2: snapped.y };
      const wallB = { id: base + "b", x1: snapped.x, y1: snapped.y, x2: w.x2, y2: w.y2 };
      // Локальная мутация сразу (как у существующего драга вершины ниже) —
      // без неё первые mousemove драга новой точки били бы мимо (стены с
      // новыми id ещё не существуют в ctx.scene до ответа сервера).
      delete ctx.scene.walls[wallId];
      ctx.scene.walls[wallA.id] = wallA;
      ctx.scene.walls[wallB.id] = wallB;
      ctx.dirty.walls = true;
      ctx.dirty.vision = true;
      ctx.render();
      ctx.send({ type: "split_wall", id: wallId, wall: wallA, wall2: wallB });
      draggingWallPoint = {
        x: snapped.x,
        y: snapped.y,
        refs: [
          { wallId: wallA.id, which: 2 },
          { wallId: wallB.id, which: 1 },
        ],
      };
    }

    // buildingCloseTarget — если (x,y) достаточно близко к СТАРТОВОЙ точке
    // текущей цепочки здания (и в цепочке уже накопилось хотя бы 3 точки —
    // меньше не образуют контур), возвращает саму стартовую точку (клик
    // "прилипает" к ней ровно так же, как к вершине стены); иначе null. Тот
    // же порог, что у snapToWallVertex по умолчанию (14 экранных px) — чтобы
    // жест замыкания ощущался так же, как обычное примагничивание.
    function buildingCloseTarget(x, y) {
      if (!buildingChain || buildingChain.length < 3) return null;
      const scale = ctx.world.scale.x || 1;
      const start = buildingChain[0];
      return Math.hypot(x - start.x, y - start.y) < 14 / scale ? start : null;
    }

    // Полная замена метаданных текущей сцены (сервер не поддерживает PATCH
    // для сцены — см. internal/service/room.go: applyMutation/"update_scene").
    function sceneUpdateMsg(overrides) {
      return Object.assign(
        {
          type: "update_scene",
          sceneId: ctx.scene.id,
          sceneName: ctx.scene.name,
          mapUrl: ctx.scene.mapUrl,
          width: ctx.scene.width,
          height: ctx.scene.height,
          fogOfWar: ctx.scene.fogOfWar !== false,
          grid: ctx.scene.grid,
        },
        overrides
      );
    }

    // hitTestGridHandle — где на подсвеченном квадрате-"ручке" оказалась
    // точка (x,y): null (мимо), {edge:null} (внутри — перенос) или
    // {edge:'left'|'right'|'top'|'bottom'} (у края — ресайз). Общая для
    // mousedown (что начинаем тащить) и mousemove-курсора (что покажем,
    // пока не тащим ничего).
    function hitTestGridHandle(h, x, y) {
      if (!h) return null;
      const scale = ctx.world.scale.x || 1;
      const edgeT = EDGE_HIT_PX / scale;
      const insideX = x >= h.x0 - edgeT && x <= h.x0 + h.size + edgeT;
      const insideY = y >= h.y0 - edgeT && y <= h.y0 + h.size + edgeT;
      if (!insideX || !insideY) return null;

      const distLeft = Math.abs(x - h.x0);
      const distRight = Math.abs(x - (h.x0 + h.size));
      const distTop = Math.abs(y - h.y0);
      const distBottom = Math.abs(y - (h.y0 + h.size));
      const minDist = Math.min(distLeft, distRight, distTop, distBottom);
      if (minDist > edgeT) return { edge: null };
      if (minDist === distLeft) return { edge: "left" };
      if (minDist === distRight) return { edge: "right" };
      if (minDist === distTop) return { edge: "top" };
      return { edge: "bottom" };
    }

    canvas.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return; // только ЛКМ — пан на средней, ПКМ на удаление/меню
      const { x, y } = mousePos(e);

      if (tool === "wall") {
        // Первый клик/драг цепочки — просто запоминаем точку, стену шлём
        // только на mouseup (см. там же: сразу драг = одна стена как
        // раньше, клик = только начало цепочки).
        if (!wallChainLast) wallDragFrom = snappedPoint(x, y);
        return;
      }
      if (tool === "building") {
        // Весь commit — по mouseup (клик за кликом), mousedown тут только
        // проглатывает событие, чтобы не начать драг токена под курсором.
        return;
      }
      if (tool === "fog") {
        fogPath = [{ x, y }];
        return;
      }
      if (tool === "grid-edit") {
        // Драг разрешён только от подсвеченного квадрата (см.
        // layers/grid.js): внутри него — перенос сетки, у края — ресайз
        // (тянем за сторону, противоположная остаётся на месте). Клик мимо
        // квадрата ни к чему не привязывается.
        const h = ctx.gridEditHandle;
        const hit = hitTestGridHandle(h, x, y);
        if (!hit) return;

        gridDragStart = {
          x,
          y,
          offsetX: ctx.scene.grid.offsetX || 0,
          offsetY: ctx.scene.grid.offsetY || 0,
          size: h.size,
          col: h.col,
          row: h.row,
          x0: h.x0,
          y0: h.y0,
          edge: hit.edge, // null — перенос сетки; иначе ресайз за соответствующий край
        };
        return;
      }

      if (tool === "ruler") {
        rulerFrom = { x, y };
        return;
      }

      if (tool === "select") {
        const vertex = wallVertexNear(x, y, ctx.scene.walls, ctx.world.scale.x || 1);
        if (vertex) {
          draggingWallPoint = vertex;
          return;
        }
        // Клик по линии стены (не по её концу) — не двигать существующую
        // точку, а создать новую прямо тут и сразу утащить её этим же
        // жестом (см. splitWallAt выше). Раньше добавить точку посреди
        // стены было нечем — только удалить стену и провести заново.
        const wallId = wallNear(x, y, ctx.scene.walls, ctx.world.scale.x || 1);
        if (wallId) {
          splitWallAt(wallId, ctx.scene.walls[wallId], x, y);
          return;
        }
      }

      const hitId = tokenAt(x, y, ctx.scene.tokens);
      if (tool === "attack") {
        if (!attackFromId) {
          attackFromId = hitId;
        } else if (hitId) {
          const from = ctx.scene.tokens[attackFromId];
          const to = ctx.scene.tokens[hitId];
          if (from && to) {
            ctx.send({ type: "animate_attack", fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, color: "#ff5555" });
          }
          setTool("select");
        }
        return;
      }
      if (hitId) {
        dragTokenId = hitId;
        const t0 = ctx.scene.tokens[hitId];
        dragStart = { x: t0.x, y: t0.y };
        dragLastPos = dragStart;
        dragTraveled = 0;
        return;
      }
      // Значок заметки перетаскивается только инструментом "выбор" — как и
      // вершины стен/токены выше, чтобы не мешать рисованию стен/тумана/etc.
      if (tool === "select") {
        const markerId = noteMarkerAt(x, y, ctx.scene.noteMarkers);
        if (markerId && markerId === resizeArmedNoteMarkerId) {
          // Резайз армирован ИМЕННО для этого значка (см. vtt:armNoteMarkerResize
          // ниже) и mousedown попал по нему — начинаем драг размера, а не
          // перемещения; армирование одноразовое, снимаем сразу.
          resizingNoteMarkerId = markerId;
          resizeArmedNoteMarkerId = null;
        } else if (markerId) {
          dragNoteMarkerId = markerId;
        } else {
          // Ничего из вышеперечисленного не подцепилось — последняя
          // проверка: фигура ручного тумана. Сначала её вершина (точечная
          // переформовка контура), иначе — тело фигуры целиком (перенос) —
          // тот же приоритет "точка, потом целиком", что у стен выше. Было
          // вообще нечем двигать/переформовывать нарисованный туман — только
          // удалить и обвести заново (см. layers/manual-fog.js).
          const scale = ctx.world.scale.x || 1;
          const fogVertex = fogVertexNear(x, y, ctx.scene.fogAreas, scale);
          if (fogVertex) {
            draggingFogVertex = fogVertex;
          } else {
            const fogId = fogAreaAt(x, y, ctx.scene.fogAreas);
            if (fogId) {
              draggingFogArea = { id: fogId, startX: x, startY: y, original: ctx.scene.fogAreas[fogId].points.map((p) => ({ x: p.x, y: p.y })) };
            }
          }
        }
      }
    });

    canvas.addEventListener("mousemove", (e) => {
      const { x, y } = mousePos(e);
      const scale = ctx.world.scale.x || 1;

      if (tool === "wall" && (wallChainLast || wallDragFrom)) {
        const from = wallChainLast || wallDragFrom;
        const to = snappedPoint(x, y);
        preview.clear();
        preview.moveTo(from.x, from.y).lineTo(to.x, to.y).stroke({ width: 2 / scale, color: 0x5dd0ff, alpha: 0.9 });
        return;
      }

      if (tool === "building" && buildingChain) {
        const to = snappedPoint(x, y);
        const closeTarget = buildingCloseTarget(to.x, to.y);
        const pts = buildingChain.concat([closeTarget || to]);
        preview.clear();
        // Пока контур ещё не замкнут — просто пунктирный не отличаем,
        // сплошная ломаная линия (как у стен); в момент, когда курсор
        // "прилипает" к стартовой точке (можно закрыть), дополнительно
        // заливаем получившийся многоугольник полупрозрачным — наглядный
        // "вот что получится, если кликнуть сейчас".
        if (closeTarget) preview.poly(pts).fill({ color: 0xffb454, alpha: 0.15 });
        preview.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) preview.lineTo(pts[i].x, pts[i].y);
        if (closeTarget) preview.lineTo(pts[0].x, pts[0].y);
        preview.stroke({ width: 2 / scale, color: 0xffb454, alpha: 0.9 });
        preview.circle(buildingChain[0].x, buildingChain[0].y, (closeTarget ? 7 : 4) / scale).fill({
          color: 0xffb454,
          alpha: closeTarget ? 0.9 : 0.5,
        });
        return;
      }

      if (tool === "fog" && fogPath) {
        const last = fogPath[fogPath.length - 1];
        if (Math.hypot(x - last.x, y - last.y) > 6) fogPath.push({ x, y });
        preview.clear();
        if (fogPath.length > 1) {
          preview.moveTo(fogPath[0].x, fogPath[0].y);
          for (let i = 1; i < fogPath.length; i++) preview.lineTo(fogPath[i].x, fogPath[i].y);
          preview.stroke({ width: 2 / scale, color: 0x8bc3ff, alpha: 0.85 });
        }
        return;
      }

      if (tool === "grid-edit" && !gridDragStart) {
        // Курсор подсказывает, что будет, если нажать сейчас — до самого
        // драга (см. hitTestGridHandle/mousedown выше): стрелки-ресайз у
        // края квадрата, "рука" внутри него, обычный — мимо.
        const hit = hitTestGridHandle(ctx.gridEditHandle, x, y);
        canvas.style.cursor = !hit ? "" : hit.edge === "left" || hit.edge === "right" ? "ew-resize" : hit.edge === "top" || hit.edge === "bottom" ? "ns-resize" : "move";
      }

      if (tool === "grid-edit" && gridDragStart) {
        // мгновенная локальная правка (как move_token ниже) + шлём на
        // сервер на каждый mousemove — лаг сети на локальной сети за столом
        // не заметен.
        const grid = ctx.scene.grid;
        const MIN_SIZE = 8;
        if (!gridDragStart.edge) {
          // перенос: вся сетка (и подсвеченный квадрат вместе с ней) едет
          // ровно за курсором.
          const dx = x - gridDragStart.x;
          const dy = y - gridDragStart.y;
          grid.offsetX = gridDragStart.offsetX + dx;
          grid.offsetY = gridDragStart.offsetY + dy;
          ctx.gridEditHandle = { x0: gridDragStart.x0 + dx, y0: gridDragStart.y0 + dy, size: gridDragStart.size, col: gridDragStart.col, row: gridDragStart.row };
        } else {
          // ресайз за край: сторона, за которую тащим, идёт к курсору,
          // противоположная остаётся неподвижной в мировых координатах —
          // отсюда пересчёт offsetX/offsetY через "якорную" линию сетки
          // (anchorCol/anchorRow), чтобы её позиция не съехала при смене
          // grid.size (у сетки один размер клетки на оба измерения).
          let anchorX = gridDragStart.x0;
          let anchorCol = gridDragStart.col;
          if (gridDragStart.edge === "left") {
            anchorX = gridDragStart.x0 + gridDragStart.size;
            anchorCol = gridDragStart.col + 1;
          }
          let anchorY = gridDragStart.y0;
          let anchorRow = gridDragStart.row;
          if (gridDragStart.edge === "top") {
            anchorY = gridDragStart.y0 + gridDragStart.size;
            anchorRow = gridDragStart.row + 1;
          }

          let newSize = gridDragStart.size;
          if (gridDragStart.edge === "right") newSize = x - anchorX;
          else if (gridDragStart.edge === "left") newSize = anchorX - x;
          else if (gridDragStart.edge === "bottom") newSize = y - anchorY;
          else if (gridDragStart.edge === "top") newSize = anchorY - y;
          newSize = Math.max(MIN_SIZE, Math.round(newSize));

          grid.size = newSize;
          grid.offsetX = anchorX - anchorCol * newSize;
          grid.offsetY = anchorY - anchorRow * newSize;
          ctx.gridEditHandle = {
            x0: grid.offsetX + gridDragStart.col * newSize,
            y0: grid.offsetY + gridDragStart.row * newSize,
            size: newSize,
            col: gridDragStart.col,
            row: gridDragStart.row,
          };
        }
        ctx.dirty.grid = true;
        ctx.render();
        ctx.send(sceneUpdateMsg({ grid }));
        return;
      }

      if (tool === "ruler" && rulerFrom) {
        const to = { x, y };
        rulerLine.draw(rulerFrom, to);
        const label = formatDistance(to.x - rulerFrom.x, to.y - rulerFrom.y, ctx.scene.grid);
        distanceLabel.show((rulerFrom.x + to.x) / 2, (rulerFrom.y + to.y) / 2, label);
        return;
      }

      if (draggingWallPoint) {
        // Двигает СРАЗУ все стены, у которых тут общий конец (угол
        // комнаты) — одним жестом, не по одной стороне за раз.
        const to = snappedPoint(x, y, draggingWallPoint.refs);
        for (const ref of draggingWallPoint.refs) {
          const w = ctx.scene.walls[ref.wallId];
          if (!w) continue;
          if (ref.which === 1) {
            w.x1 = to.x;
            w.y1 = to.y;
          } else {
            w.x2 = to.x;
            w.y2 = to.y;
          }
        }
        draggingWallPoint.x = to.x;
        draggingWallPoint.y = to.y;
        ctx.dirty.walls = true;
        ctx.dirty.vision = true;
        ctx.render();
        ctx.send({
          type: "move_wall_point",
          wallPoints: draggingWallPoint.refs.map((ref) => ({ wallId: ref.wallId, which: ref.which, x: to.x, y: to.y })),
        });
        return;
      }

      if (draggingFogVertex) {
        // Переформовка контура — двигает ровно одну вершину; "add_fog_area"
        // с тем же id — апсерт на сервере (см. room.go:applyMutation), так
        // им же и обновляем существующую фигуру, отдельного типа сообщения
        // не нужно.
        const area = ctx.scene.fogAreas[draggingFogVertex.areaId];
        if (area) {
          area.points[draggingFogVertex.index] = { x, y };
          ctx.dirty.manualFog = true;
          ctx.render();
          ctx.send({ type: "add_fog_area", fogArea: { id: area.id, points: area.points } });
        }
        return;
      }

      if (draggingFogArea) {
        // Перенос фигуры целиком — смещение от исходных точек (original), не
        // накопление по текущим, иначе дрейф округления на долгом жесте.
        const area = ctx.scene.fogAreas[draggingFogArea.id];
        if (area) {
          const dx = x - draggingFogArea.startX;
          const dy = y - draggingFogArea.startY;
          area.points = draggingFogArea.original.map((p) => ({ x: p.x + dx, y: p.y + dy }));
          ctx.dirty.manualFog = true;
          ctx.render();
          ctx.send({ type: "add_fog_area", fogArea: { id: area.id, points: area.points } });
        }
        return;
      }

      if (resizingNoteMarkerId) {
        const m = ctx.scene.noteMarkers[resizingNoteMarkerId];
        if (!m) return;
        // Размер = расстояние от НЕПОДВИЖНОГО центра значка до курсора —
        // тащишь дальше от иконки, она растёт, тащишь ближе — сжимается.
        // Никакой отдельной "ручки" на краю не нужно: сам значок маленький,
        // и такая схема прощает неточный клик лучше, чем резайз за грань.
        const dist = Math.hypot(x - m.x, y - m.y);
        m.size = Math.min(NOTE_MARKER_MAX_SIZE, Math.max(NOTE_MARKER_MIN_SIZE, Math.round(dist)));
        ctx.dirty.tokens = true;
        ctx.render();
        ctx.send({ type: "move_note_marker", noteMarker: m });
        return;
      }

      if (dragNoteMarkerId) {
        const m = ctx.scene.noteMarkers[dragNoteMarkerId];
        if (!m) return;
        m.x = x;
        m.y = y;
        ctx.dirty.tokens = true;
        ctx.render();
        ctx.send({ type: "move_note_marker", noteMarker: m });
        return;
      }

      if (!dragTokenId) return;
      const snapped = snapToGrid(x, y, ctx.scene.grid);
      const t = ctx.scene.tokens[dragTokenId];
      if (!t) return;
      // У ДМ перемещение ничем не ограничено (maxAllowed=Infinity — полная
      // авторская власть над картой), в отличие от драга игроком СВОЕГО
      // токена в его ход (см. ветку ctx.isPlayer ниже) — но "одометр" для
      // подсказки дистанции считается тем же способом (см.
      // geometry.trackMovementStep): накопленный путь, обнуляется только
      // при точном возврате в точку начала жеста.
      const step = trackMovementStep(dragLastPos, snapped, dragStart, dragTraveled, Infinity, ctx.scene.grid);
      t.x = step.pos.x;
      t.y = step.pos.y;
      dragLastPos = step.pos;
      dragTraveled = step.traveled;
      ctx.dirty.tokens = true;
      ctx.dirty.vision = true;
      ctx.dirty.buildings = true; // мог войти/выйти из контура здания — occupied() пересчитать
      ctx.render();
      distanceLabel.show(t.x, t.y, formatDistanceValue(dragTraveled, ctx.scene.grid));
      ctx.send({ type: "move_token", token: t });
    });

    canvas.addEventListener("mouseup", (e) => {
      if (tool === "wall") {
        const { x, y } = mousePos(e);
        const up = snappedPoint(x, y);
        if (!wallChainLast) {
          // Первое взаимодействие цепочки: сдвиг больше порога — это был
          // драг "одним махом" (старый жест) — сразу коммитим сегмент и
          // цепочка продолжается от точки отпускания; меньше порога — это
          // был просто клик, фиксируем только первую точку цепочки.
          const dragged = wallDragFrom && Math.hypot(up.x - wallDragFrom.x, up.y - wallDragFrom.y) > 6;
          if (dragged) sendAddWall(wallDragFrom, up);
          wallChainLast = dragged ? up : wallDragFrom || up;
          wallDragFrom = null;
          return;
        }
        // Цепочка уже идёт — каждый клик/драг коммитит следующий сегмент от
        // последней точки, не сбрасывая её.
        sendAddWall(wallChainLast, up);
        wallChainLast = up;
        return;
      }

      if (tool === "building") {
        const { x, y } = mousePos(e);
        const pt = snappedPoint(x, y);
        if (!buildingChain) {
          buildingChain = [pt];
          return;
        }
        const closeTarget = buildingCloseTarget(pt.x, pt.y);
        if (closeTarget) {
          // Замыкание — единственный момент, когда здание вообще уходит на
          // сервер, и уходит ЦЕЛИКОМ одним сообщением (не по сегменту, как
          // стены): контур либо существует полностью и замкнутым, либо не
          // существует вовсе.
          ctx.send({
            type: "add_building",
            building: { id: "building-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6), points: buildingChain },
          });
          buildingChain = null;
          preview.clear();
          return;
        }
        buildingChain.push(pt);
        return;
      }

      if (tool === "fog" && fogPath) {
        if (fogPath.length >= 3) {
          ctx.send({ type: "add_fog_area", fogArea: { id: "fog-" + Date.now(), points: fogPath } });
        }
        fogPath = null;
        preview.clear();
        return;
      }

      if (tool === "grid-edit") {
        // ctx.gridEditHandle уже в актуальном состоянии — его выставил
        // последний mousemove драга, тут просто заканчиваем жест.
        gridDragStart = null;
        return;
      }

      if (tool === "ruler") {
        rulerFrom = null;
        rulerLine.clear();
        distanceLabel.hide();
        return;
      }

      if (draggingWallPoint) {
        draggingWallPoint = null;
        return;
      }

      if (draggingFogVertex || draggingFogArea) {
        draggingFogVertex = null;
        draggingFogArea = null;
        return;
      }

      dragTokenId = null;
      dragStart = null;
      dragLastPos = null;
      dragTraveled = 0;
      distanceLabel.hide();
      dragNoteMarkerId = null;
      resizingNoteMarkerId = null; // одноразовый резайз — один драг и всё, армировать заново через меню
    });

    // Escape во время рисования цепочки стен — закончить её без удаления уже
    // поставленных сегментов (переключение инструмента и так это делает).
    window.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (tool === "wall" && (wallChainLast || wallDragFrom)) {
        wallChainLast = null;
        wallDragFrom = null;
        preview.clear();
      }
      if (tool === "building" && buildingChain) {
        buildingChain = null;
        preview.clear();
      }
      if (tool === "ruler" && rulerFrom) {
        rulerFrom = null;
        rulerLine.clear();
        distanceLabel.hide();
      }
    });

    // двойной клик — во время рисования цепочки стен просто заканчивает её
    // (см. tool "wall" выше); иначе — быстрый reveal: и для скрытого токена,
    // и для hidden-метки; на токене света (Token.LightOnly) — вместо reveal
    // мгновенно включает/выключает сам источник (см. domain.Token.LightOnly
    // и #tokenMenuLightToggleBtn в dm.js — та же операция доступна и оттуда).
    canvas.addEventListener("dblclick", (e) => {
      if (tool === "wall" && (wallChainLast || wallDragFrom)) {
        wallChainLast = null;
        wallDragFrom = null;
        preview.clear();
        return;
      }
      // У здания, в отличие от стен, "закончить, не замыкая" не бывает —
      // незамкнутый контур на сервер не уходит вообще (см. domain.Building),
      // поэтому двойной клик во время рисования просто отменяет попытку, а
      // не сохраняет то, что успели поставить.
      if (tool === "building" && buildingChain) {
        buildingChain = null;
        preview.clear();
        return;
      }
      const { x, y } = mousePos(e);
      const hitId = tokenAt(x, y, ctx.scene.tokens);
      if (hitId) {
        const t = ctx.scene.tokens[hitId];
        if (t.lightOnly) {
          toggleTokenLight(hitId);
          return;
        }
        if (t.hidden) {
          ctx.send({ type: "reveal_token", id: hitId });
          return;
        }
      }
      // Значок заметки — не мутация сцены, а чисто клиентская навигация:
      // открыть его в панели "Заметки" (см. pages/dm.js: vtt:openNoteMarker).
      const markerId = noteMarkerAt(x, y, ctx.scene.noteMarkers);
      if (markerId) {
        document.dispatchEvent(new CustomEvent("vtt:openNoteMarker", { detail: { noteId: ctx.scene.noteMarkers[markerId].noteId } }));
        return;
      }
    });

    // ПКМ: во время рисования цепочки стен — просто закончить её (не
    // удалять уже поставленное); на точке стены — меню "удалить точку";
    // рядом со стеной (не по её концу) — удалить её целиком, как раньше; на
    // токене — контекстное меню; внутри тумана-фигуры — тоже меню (см.
    // #fogAreaMenu). Работает всегда, а не только при включённом
    // соответствующем инструменте (кроме самого первого случая).
    canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const { x, y } = mousePos(e);
      const scale = ctx.world.scale.x || 1;

      if (tool === "wall" && (wallChainLast || wallDragFrom)) {
        wallChainLast = null;
        wallDragFrom = null;
        preview.clear();
        return;
      }
      if (tool === "building" && buildingChain) {
        buildingChain = null;
        preview.clear();
        return;
      }

      const vertex = wallVertexNear(x, y, ctx.scene.walls, scale);
      if (vertex) {
        document.dispatchEvent(
          new CustomEvent("vtt:wallPointContextMenu", { detail: { refs: vertex.refs, pageX: e.clientX, pageY: e.clientY } })
        );
        return;
      }

      // Стена (не по её концу) — тоже меню, а не мгновенное удаление (см.
      // #wallMenu) — по той же причине, что и у фигуры тумана: середину
      // стены теперь можно ещё и кликнуть, чтобы вставить точку (см.
      // splitWallAt выше), так что ПКМ рядом с линией больше не однозначно
      // "снести", и снос без подтверждения слишком легко словить случайно.
      const wallId = wallNear(x, y, ctx.scene.walls, scale);
      if (wallId) {
        document.dispatchEvent(new CustomEvent("vtt:wallContextMenu", { detail: { id: wallId, pageX: e.clientX, pageY: e.clientY } }));
        return;
      }

      const hitId = tokenAt(x, y, ctx.scene.tokens);
      if (hitId) {
        document.dispatchEvent(
          new CustomEvent("vtt:tokenContextMenu", {
            detail: { id: hitId, token: ctx.scene.tokens[hitId], pageX: e.clientX, pageY: e.clientY },
          })
        );
        return;
      }

      // Фигура тумана — ПКМ открывает меню (см. web/dm.html #fogAreaMenu),
      // как у токена/значка заметки, а не удаляет сразу — двигать/
      // переформовывать её теперь тоже можно (см. mousedown выше), поэтому
      // ПКМ больше не единственное действие над фигурой, и снос без
      // подтверждения одним кликом стал слишком легко словить случайно.
      const fogId = fogAreaAt(x, y, ctx.scene.fogAreas);
      if (fogId) {
        document.dispatchEvent(
          new CustomEvent("vtt:fogAreaContextMenu", { detail: { id: fogId, pageX: e.clientX, pageY: e.clientY } })
        );
        return;
      }

      // Значок заметки — ПКМ открывает меню (см. web/dm.html #noteMarkerMenu):
      // "Изменить размер" (армирует резайз следующим драгом по значку, см.
      // mousedown/mousemove выше) и "Убрать со сцены" (не удаляет саму
      // заметку, только значок).
      const markerId = noteMarkerAt(x, y, ctx.scene.noteMarkers);
      if (markerId) {
        document.dispatchEvent(
          new CustomEvent("vtt:noteMarkerContextMenu", { detail: { id: markerId, pageX: e.clientX, pageY: e.clientY } })
        );
        return;
      }

      // Здание удаляется целиком по клику внутри контура (нет отдельных
      // вершин-ручек, как у стен, — см. domain.Building/README).
      const buildingId = buildingAt(x, y, ctx.scene.buildings);
      if (buildingId) ctx.send({ type: "remove_building", id: buildingId });
    });

    // команда из меню точки стены (см. web/dm.html #wallPointMenu) — удаляет
    // ВСЕ стены, у которых был конец в этой точке (см. rationale в плане:
    // "удалить точку" = удалить всё, что в ней сходится).
    document.addEventListener("vtt:removeWallPoint", (e) => {
      const wallIds = (e.detail && e.detail.wallIds) || [];
      if (wallIds.length) ctx.send({ type: "remove_wall_point", wallIds });
    });

    // команда из меню фигуры тумана (см. web/dm.html #fogAreaMenu)
    document.addEventListener("vtt:removeFogArea", (e) => {
      ctx.send({ type: "remove_fog_area", id: e.detail.id });
    });

    // команда из меню стены (см. web/dm.html #wallMenu) — удаляет ОДИН
    // сегмент целиком (в отличие от vtt:removeWallPoint выше, который берёт
    // все стены, сходящиеся в одной точке).
    document.addEventListener("vtt:removeWall", (e) => {
      ctx.send({ type: "remove_wall", id: e.detail.id });
    });

    // команды из контекстного меню токена (см. web/dm.html)
    document.addEventListener("vtt:setTokenHidden", (e) => {
      const { id, hidden } = e.detail;
      const t = ctx.scene.tokens[id];
      if (!t) return;
      ctx.send({ type: "move_token", token: { ...t, hidden } });
    });
    document.addEventListener("vtt:setTokenShape", (e) => {
      const { id, shape } = e.detail;
      const t = ctx.scene.tokens[id];
      if (!t) return;
      ctx.send({ type: "move_token", token: { ...t, shape } });
    });
    document.addEventListener("vtt:setTokenLight", (e) => {
      const { id, light } = e.detail;
      const t = ctx.scene.tokens[id];
      if (!t) return;
      ctx.send({ type: "move_token", token: { ...t, light } });
    });
    // toggleTokenLight — общая логика вкл/выкл источника света у токена
    // света: дёргается и двойным кликом по канвасу (см. dblclick выше), и
    // кнопкой "Включить/Выключить свет" в контекстном меню (см. dm.js).
    // Радиусы (bright/dim) не трогает — тушит/зажигает уже настроенный
    // факел, а не сбрасывает его параметры.
    function toggleTokenLight(id) {
      const t = ctx.scene.tokens[id];
      if (!t) return;
      const light = { enabled: !(t.light && t.light.enabled), bright: (t.light && t.light.bright) || 0, dim: (t.light && t.light.dim) || 0 };
      ctx.send({ type: "move_token", token: { ...t, light } });
    }
    document.addEventListener("vtt:toggleTokenLight", (e) => toggleTokenLight(e.detail.id));
    // Владелец/персонаж токена больше не назначается задним числом через
    // это меню (не было vtt:setTokenOwner) — токен сразу создаётся с уже
    // проставленными ownerId/characterId, когда ДМ перетаскивает персонажа
    // из панели "Персонажи" на канвас (см. pages/dm.js: обработчик "drop").
    document.addEventListener("vtt:removeToken", (e) => {
      ctx.send({ type: "remove_token", id: e.detail.id });
    });

    // команды из меню значка заметки (см. web/dm.html #noteMarkerMenu, pages/dm.js)
    document.addEventListener("vtt:armNoteMarkerResize", (e) => {
      resizeArmedNoteMarkerId = e.detail.id;
    });
    document.addEventListener("vtt:removeNoteMarker", (e) => {
      ctx.send({ type: "remove_note_marker", id: e.detail.id });
    });

    // "📍 Поставить на карту" в панели "Заметки" (см. pages/dm.js) — тот же
    // паттерн, что был у старой скрытой заметки: включаем режим постановки,
    // следующий клик по канвасу коммитит значок в этой точке.
    document.addEventListener("vtt:placeNoteMarker", (e) => {
      canvas.dataset.placingNoteMarker = "1";
      canvas.dataset.noteMarkerPayload = JSON.stringify(e.detail);
    });
    canvas.addEventListener("click", (e) => {
      if (canvas.dataset.placingNoteMarker !== "1") return;
      const { x, y } = mousePos(e);
      const payload = JSON.parse(canvas.dataset.noteMarkerPayload);
      ctx.send({
        type: "add_note_marker",
        noteMarker: { id: "nm-" + Date.now(), noteId: payload.noteId, label: payload.label, x, y },
      });
      canvas.dataset.placingNoteMarker = "0";
    });
  }

  // ---- игрок: может тащить только СВОИ токены и бросать кубы ----
  if (ctx.isPlayer) {
    // rulerActive/rulerFrom — инструмент "Линейка" (см. web/player.html:
    // кнопка в топбаре, dispatch того же "vtt:setTool", что и у ДМ, только
    // без остальных ДМ-инструментов — игроку из них доступна только
    // линейка). dragStart — позиция токена на mousedown, общая точка отсчёта
    // и для подсказки дистанции, и для лимита скорости ниже.
    let rulerActive = false;
    let rulerFrom = null;
    // dragStart/dragLastPos/dragTraveled — "одометр" перемещения токена за
    // текущий жест (см. geometry.trackMovementStep): dragStart — позиция на
    // mousedown (только для проверки "вернулся ровно в старт"), dragLastPos
    // — последняя зафиксированная позиция (шаг считается от неё, не от
    // dragStart — боком/по диагонали тоже прибавляется, а не вычитается),
    // dragTraveled — накопленное расстояние, используется и подсказкой, и
    // лимитом скорости ниже.
    let dragStart = null;
    let dragLastPos = null;
    let dragTraveled = 0;

    // speedCache — характеристика "Скорость" (domain.CombatStats.Speed, в
    // единицах линейки сцены, обычно футы) персонажей игрока, подтянутая с
    // сервера отдельным запросом (токен/сцена её не несут — это поле листа
    // персонажа, см. internal/domain/character_sheet.go). Ключ —
    // characterId. Перезапрашивается на каждый mousedown по токену (не
    // кешируется намертво), чтобы правка скорости на листе персонажа
    // подхватывалась к следующему же перетаскиванию, а не требовала
    // перезагрузки страницы.
    const speedCache = new Map();
    function ensureSpeedLoaded(characterId) {
      if (!characterId) return;
      fetchCharacter(characterId)
        .then((c) => speedCache.set(characterId, (c.sheet && c.sheet.combat && c.sheet.combat.speed) || 0))
        .catch(() => {});
    }

    // currentCombatantFor — боец из трекера инициативы, чей СЕЙЧАС ход,
    // если это именно данный токен (лимит скорости — только в свой ход, см.
    // README/уточнение задачи). TokenID у бойца проставляется, когда его
    // добавили в инициативу через ПКМ-меню токена (обычный путь для
    // игровых персонажей, см. room.go:handleAddCombatant) — characterId
    // подстраховывает случай, когда TokenID почему-то не сохранился.
    function currentCombatantFor(token) {
      const combat = ctx.combat;
      if (!combat || !combat.active || !Array.isArray(combat.combatants)) return null;
      return combat.combatants.find(
        (c) => c.id === combat.currentId && (c.tokenId === token.id || (token.characterId && c.characterId === token.characterId))
      );
    }

    // Единственный ДМ-инструмент, доступный игроку, — линейка; событие то
    // же самое ("vtt:setTool"), что дёргает кнопка в топбаре player.html.
    document.addEventListener("vtt:setTool", (e) => {
      rulerActive = e.detail === "ruler";
      rulerFrom = null;
      rulerLine.clear();
      distanceLabel.hide();
    });

    canvas.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const { x, y } = mousePos(e);
      if (rulerActive) {
        rulerFrom = { x, y };
        return;
      }
      const hitId = tokenAt(x, y, ctx.scene.tokens);
      if (hitId && ctx.scene.tokens[hitId].ownerId === ctx.playerId) {
        dragTokenId = hitId;
        const t0 = ctx.scene.tokens[hitId];
        dragStart = { x: t0.x, y: t0.y };
        dragLastPos = dragStart;
        dragTraveled = 0;
        ensureSpeedLoaded(t0.characterId);
      }
    });

    canvas.addEventListener("mousemove", (e) => {
      const { x, y } = mousePos(e);

      if (rulerActive && rulerFrom) {
        const to = { x, y };
        rulerLine.draw(rulerFrom, to);
        const label = formatDistance(to.x - rulerFrom.x, to.y - rulerFrom.y, ctx.scene.grid);
        distanceLabel.show((rulerFrom.x + to.x) / 2, (rulerFrom.y + to.y) / 2, label);
        return;
      }

      if (!dragTokenId) return;
      const t = ctx.scene.tokens[dragTokenId];
      if (!t || t.ownerId !== ctx.playerId) {
        dragTokenId = null;
        distanceLabel.hide();
        return;
      }
      const snapped = snapToGrid(x, y, ctx.scene.grid);

      // Лимит скорости — только пока идёт бой И сейчас ход именно этого
      // персонажа (currentCombatantFor). Вне боя или не в его ход — только
      // подсказка ниже, без ограничения (см. уточнение задачи). speed===0
      // (лист персонажа не заполнен — 0 нулевое значение по умолчанию, а не
      // осознанно проставленная неподвижность) тоже не ограничивает —
      // иначе свежесозданный персонаж не мог бы сдвинуться в первом же бою.
      let maxAllowed = Infinity;
      let limitUnits = null; // потолок В ЕДИНИЦАХ ЛИНЕЙКИ (не px) — для подписи "15/30 фт"
      if (currentCombatantFor(t)) {
        const speed = speedCache.get(t.characterId);
        if (speed) {
          maxAllowed = unitsToWorldDistance(speed, ctx.scene.grid);
          limitUnits = speed;
        }
      }

      // Расстояние — накопленный путь этого жеста (см.
      // geometry.trackMovementStep), а не прямая от точки старта: шаг
      // назад/вбок тоже прибавляется к одометру, как и реальные шаги
      // персонажа, и лимит расходуется соответственно. Обнуляется в ноль
      // (и лимит выдаётся заново), только если токен оказался РОВНО в
      // точке, откуда начался весь жест (dragStart) — именно этот случай
      // и есть "вернул персонажа — верни движение" из уточнения задачи.
      const step = trackMovementStep(dragLastPos, snapped, dragStart, dragTraveled, maxAllowed, ctx.scene.grid);
      t.x = step.pos.x;
      t.y = step.pos.y;
      dragLastPos = step.pos;
      dragTraveled = step.traveled;
      ctx.dirty.tokens = true;
      ctx.render();
      distanceLabel.show(t.x, t.y, formatDistanceValue(dragTraveled, ctx.scene.grid, limitUnits));
      ctx.send({ type: "move_own_token", token: { id: t.id, x: t.x, y: t.y } });
    });

    canvas.addEventListener("mouseup", () => {
      if (rulerActive) {
        rulerFrom = null;
        rulerLine.clear();
        distanceLabel.hide();
        return;
      }
      dragTokenId = null;
      dragStart = null;
      dragLastPos = null;
      dragTraveled = 0;
      distanceLabel.hide();
    });

    // ПКМ на мёртвом токене (кости, см. domain.Token.Dead) с непустым Loot,
    // пока ДМ включил CombatState.LootingEnabled (ctx.combat, обновляется
    // net.js на каждый "combat_state") — открыть модалку лута (см.
    // pages/player.js: "vtt:tokenLootRequest"). У игрока в остальном нет
    // контекстного меню токенов (см. ветку ctx.isDM выше) — это
    // единственный ПКМ-сценарий на карте для роли player, поэтому просто
    // ничего не делаем на любом другом ПКМ, вместо полноценного меню.
    canvas.addEventListener("contextmenu", (e) => {
      const { x, y } = mousePos(e);
      const hitId = tokenAt(x, y, ctx.scene.tokens);
      if (!hitId) return;
      const t = ctx.scene.tokens[hitId];
      const loot = Array.isArray(t.loot) ? t.loot : [];
      if (!t.dead || loot.length === 0 || !(ctx.combat && ctx.combat.lootingEnabled)) return;
      e.preventDefault();
      document.dispatchEvent(new CustomEvent("vtt:tokenLootRequest", { detail: { tokenId: hitId, loot, name: t.label } }));
    });
  }
}
