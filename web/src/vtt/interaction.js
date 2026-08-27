import { Graphics } from "pixi.js";
import { canvasPos, screenToWorld, getTransform, zoomAt, resetCamera } from "./camera.js";
import {
  tokenAt,
  snapToGrid,
  wallNear,
  wallVertexNear,
  snapToWallVertex,
  closestPointOnSegment,
  doorAt,
  fogAreaAt,
  fogVertexNear,
  buildingAt,
  buildingVertexNear,
  noteMarkerAt,
  gridHandleCell,
  formatDistance,
  formatDistanceValue,
  unitsToWorldDistance,
  trackMovementStep,
  clampMoveByWalls,
} from "../geometry.js";
import { NOTE_MARKER_MIN_SIZE, NOTE_MARKER_MAX_SIZE } from "./layers/note-markers.js";
import { MAP_OBJECT_KINDS, createMapObjectFocus, isLocked, mapObjectsOf } from "./map-objects.js";
import { createRulerLine, createDistanceLabel } from "./ruler.js";
import { fetchCharacter, fetchMonster } from "../api.js";

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

  // ---- универсальная механика объектов карты (см. map-objects.js) ----
  // Фокусировка ("покажи, где он") заведена для ВСЕХ ролей, а не только для
  // ДМ: сам жест ничего в мире не меняет — он двигает локальную камеру, — и
  // ровно та же кнопка "найти на карте" понадобится в любом списке объектов
  // на экране игрока.
  const mapObjectFocus = createMapObjectFocus(ctx, applyCameraAndRender);
  document.addEventListener("vtt:focusMapObject", (e) => {
    const { kind, id, minZoom } = e.detail || {};
    const obj = mapObjectsOf(ctx.scene, kind)[id];
    if (obj) mapObjectFocus.focus(obj, { minZoom });
  });

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

  // ---- лимит скорости в бою — общий и для ДМ, и для игрока ----
  // Раньше это было заведено только в ветке ctx.isPlayer (свой токен, свой
  // ход), а ДМ двигал ЛЮБОЙ токен без ограничений вовсе — включая токен
  // текущего бойца в его же ход. По ТЗ максимум перемещения токена = его
  // скорость из карточки, и это должно работать независимо от того, кто
  // именно тащит токен (ДМ чаще всего двигает и монстров, и — с общего
  // экрана — токены игроков). Поэтому механизм один на оба сценария: кэш
  // speedCache (ключ — characterId ИЛИ monsterId) и currentCombatantFor,
  // определяющий, что сейчас именно ход этого токена в активном бою.
  //
  // speedCache подтягивается заново на каждый mousedown (не кешируется
  // намертво) — правка скорости на листе персонажа/карточке бестиария
  // подхватывается к следующему же перетаскиванию, без перезагрузки
  // страницы.
  const speedCache = new Map();
  function parseMonsterWalkSpeed(speedText) {
    // Monster.Speed — свободный текст вида "30 фт., полёт 60 фт. (парит)"
    // (см. web/src/monster-import.js:buildSpeed) — для лимита берём только
    // пешую скорость, первое число в строке.
    if (!speedText) return 0;
    const m = /(\d+)/.exec(speedText);
    return m ? Number(m[1]) : 0;
  }
  function ensureSpeedLoaded(token) {
    if (token.characterId) {
      fetchCharacter(token.characterId)
        .then((c) => speedCache.set(token.characterId, (c.sheet && c.sheet.combat && c.sheet.combat.speed) || 0))
        .catch(() => {});
    } else if (token.monsterId) {
      fetchMonster(token.monsterId)
        .then((m) => speedCache.set(token.monsterId, parseMonsterWalkSpeed(m.speed)))
        .catch(() => {});
    }
  }
  // combatantForToken — боец из трекера инициативы, стоящий за этим токеном,
  // вне зависимости от того, чей сейчас ход (null, если токен в бою не
  // участвует — декорация/фон). Точный TokenID — приоритет и единственный
  // однозначный признак: если на карте два одинаковых монстра ("Гоблин-
  // воитель" и "Гоблин-воитель 2"), у них общий monsterId, и сопоставление
  // по нему различить бойцов не может. characterId/monsterId — фолбэк ТОЛЬКО
  // для бойца, у которого своего TokenID ещё нет (в инициативу добавили, на
  // карту ещё не поставили, см. handlePlaceCombatantToken) — иначе первый
  // подвернувшийся боец с тем же шаблоном перехватывал бы чужой токен (был
  // баг: движение одного гоблина то разрешало двигать обоих, то не
  // разрешало двигать никого).
  function combatantForToken(token) {
    const combat = ctx.combat;
    if (!combat || !Array.isArray(combat.combatants)) return null;
    const exact = combat.combatants.find((c) => c.tokenId === token.id);
    if (exact) return exact;
    return (
      combat.combatants.find(
        (c) =>
          !c.tokenId &&
          ((token.characterId && c.characterId === token.characterId) ||
            (token.monsterId && c.monsterId === token.monsterId))
      ) || null
    );
  }
  // currentCombatantFor — то же самое, но только если сейчас именно его ход
  // (лимит скорости — только в свой ход, см. speedLimitFor).
  function currentCombatantFor(token) {
    if (!ctx.combat || !ctx.combat.active) return null;
    const cmb = combatantForToken(token);
    return cmb && cmb.id === ctx.combat.currentId ? cmb : null;
  }
  // turnBlocksMove — бой идёт, у токена есть боец в трекере инициативы, но
  // сейчас не его ход: двигать нельзя никому, включая ДМ (см.
  // room.go: turnAllowsTokenMove — сервер отбрасывает такую правку молча,
  // тут та же проверка нужна ДО отправки, чтобы токен не дёргался туда-обратно).
  // Токены вне инициативы (декорация/фон) не блокируются — они не участвуют
  // в порядке ходов вовсе.
  function turnBlocksMove(token) {
    if (!ctx.combat || !ctx.combat.active) return false;
    const cmb = combatantForToken(token);
    return !!cmb && cmb.id !== ctx.combat.currentId;
  }
  // speedLimitFor — потолок драга ДЛЯ ЭТОГО mousemove: mировые px
  // (maxAllowed, для trackMovementStep) и тот же потолок в единицах линейки
  // (limitUnits, для подписи "15/30 фт"). speed===0 (лист/карточка не
  // заполнены — 0 нулевое значение по умолчанию, а не осознанно
  // проставленная неподвижность) тоже не ограничивает — иначе
  // свежесозданный персонаж/незаполненный монстр не мог бы сдвинуться в
  // первом же бою.
  function speedLimitFor(token) {
    if (!currentCombatantFor(token)) return { maxAllowed: Infinity, limitUnits: null };
    const key = token.characterId || token.monsterId;
    const speed = key ? speedCache.get(key) : null;
    if (!speed) return { maxAllowed: Infinity, limitUnits: null };
    return { maxAllowed: unitsToWorldDistance(speed, ctx.scene.grid), limitUnits: speed };
  }

  if (ctx.isDM) {
    // Единый активный инструмент вместо трёх независимых булевых флагов.
    let tool = "select"; // 'select' | 'attack' | 'wall' | 'building' | 'fog' | 'grid-edit' | 'ruler'
    // ctx.tool — зеркало локальной `tool` наружу: layers/walls.js,
    // layers/manual-fog.js и layers/buildings.js читают его, чтобы решить,
    // рисовать ли кружки-ручки на вершинах (см. setTool ниже — точки
    // появляются/пропадают СРАЗУ при смене инструмента, ещё до первого
    // клика). Сами линии/контуры по-прежнему видны ДМ всегда, независимо от
    // инструмента — гейтится только возможность их редактировать и сами
    // точки-ручки.
    ctx.tool = tool;
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
    // draggingBuildingPoint — переформовка контура здания инструментом
    // "Здание" (см. mousedown ниже, аналог draggingFogVertex): тащит ровно
    // одну вершину, {buildingId, index}.
    let draggingBuildingPoint = null;
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

    // selectedTokenIds — множественное выделение токенов инструментом
    // "Выбор" (см. mousedown/mousemove/mouseup ниже, аналог рамки-лассо и
    // shift-клика в Foundry). ctx.selectedTokenIds — то же зеркало наружу,
    // что и ctx.tool выше: layers/tokens.js читает его на каждой перерисовке
    // токена, чтобы решить, рисовать ли рамку выделения (selectionRing).
    // marquee — резиновая рамка, которую тянет ДМ по пустому месту карты
    // (не по токену/значку заметки): {x0,y0} — точка mousedown, {x,y} —
    // текущая точка курсора, additive — зажат ли был Shift в момент старта
    // (тогда рамка ДОБАВЛЯЕТ токены к уже выделенным, а не заменяет их).
    // groupDragOrigins — снимок стартовых позиций ВСЕХ выделенных токенов на
    // mousedown (Map<id,{x,y}>): пока "анкорный" токен под курсором
    // (dragTokenId) едет со снаппингом к сетке через обычный
    // trackMovementStep, остальные из группы просто получают ту же дельту
    // от своей исходной позиции — иначе выделение расползалось бы, если бы
    // каждый токен снаппился независимо.
    let selectedTokenIds = new Set();
    ctx.selectedTokenIds = selectedTokenIds;
    let marquee = null;
    let groupDragOrigins = null;

    function setSelection(ids) {
      selectedTokenIds = new Set(ids);
      ctx.selectedTokenIds = selectedTokenIds;
      ctx.dirty.tokens = true;
      ctx.render();
    }

    // lightEditActive — открыта ли ПРЯМО СЕЙЧАС панель "Освещение" (см.
    // pages/dm.js: setSidePanelSection шлёт "vtt:lightEditMode"). Токены
    // света (domain.Token.LightOnly) — это разметка карты, а не фигурки на
    // ней: они стоят там же, где ходят существа, ничем не подписаны и
    // ловятся мышью ровно так же, как монстр. Пока панель освещения
    // закрыта, они полностью выпадают из хит-теста — ни драга, ни ПКМ-меню,
    // ни двойного клика; открыл панель — они, наоборот, получают
    // ПРИОРИТЕТ в стопке (см. prefer в dmTokenAt), чтобы фонарь можно было
    // достать из-под вставшего на него монстра, не убирая монстра.
    let lightEditActive = false;
    document.addEventListener("vtt:lightEditMode", (e) => {
      const next = !!(e.detail && e.detail.active);
      if (next === lightEditActive) return;
      lightEditActive = next;
      // Выход из режима посреди жеста не должен оставить токен света
      // "прилипшим" к курсору.
      if (!lightEditActive && dragTokenId && (ctx.scene.tokens[dragTokenId] || {}).lightOnly) {
        dragTokenId = null;
        distanceLabel.hide();
      }
    });

    // dmTokenAt — единственный хит-тест токенов у ДМ (см. geometry.tokenAt):
    // тут собраны оба правила разом — что вообще видно мыши (токены света
    // только в режиме освещения) и что нельзя трогать (opts.skipLocked —
    // запертые объекты, см. domain.Token.Locked). skipLocked НЕ ставится на
    // ПКМ: контекстное меню запертого токена обязано открываться, иначе
    // замок было бы нечем снять.
    function dmTokenAt(x, y, opts) {
      const skipLocked = !!(opts && opts.skipLocked);
      return tokenAt(x, y, ctx.scene.tokens, {
        filter: (t) => (lightEditActive || !t.lightOnly) && !(skipLocked && isLocked(t)),
        prefer: lightEditActive ? (t) => !!t.lightOnly : null,
      });
    }

    function setTool(name) {
      tool = name || "select";
      ctx.tool = tool;
      attackFromId = null;
      wallChainLast = null;
      wallDragFrom = null;
      draggingWallPoint = null;
      draggingFogVertex = null;
      draggingFogArea = null;
      draggingBuildingPoint = null;
      buildingChain = null;
      fogPath = null;
      gridDragStart = null;
      marquee = null;
      rulerFrom = null;
      rulerLine.clear();
      distanceLabel.hide();
      preview.clear();
      // Смена инструмента сама по себе меняет, что рисовать (точки-ручки на
      // стенах/тумане/здании — только в СВОЁМ инструменте, см. rationale у
      // ctx.tool выше) — без этого точки пропадали/появлялись бы только на
      // следующей реальной правке сцены, а не сразу при переключении.
      ctx.dirty.walls = true;
      ctx.dirty.buildings = true;
      ctx.dirty.manualFog = true;
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

      // Стены/здания/туман редактируются ИСКЛЮЧИТЕЛЬНО в своём инструменте
      // (см. layers/walls.js, layers/manual-fog.js, layers/buildings.js —
      // там же точки-ручки скрываются, когда инструмент не тот). Внутри
      // своего инструмента Ctrl — переключатель "рисуем новое" против
      // "правим существующее": зажат Ctrl — начинаем/продолжаем цепочку
      // нового сегмента/контура (старое поведение самого инструмента); не
      // зажат — тащим вершину/вставляем точку/двигаем фигуру, то, что
      // раньше жило в инструменте "Выбор".
      const createHeld = e.ctrlKey || e.metaKey;

      if (tool === "wall") {
        if (wallChainLast) {
          // Цепочка уже начата — mousedown тут ничего не делает, каждый
          // следующий сегмент коммитится по mouseup (см. там же).
          return;
        }
        if (createHeld) {
          // Первый клик/драг цепочки — просто запоминаем точку, стену шлём
          // только на mouseup (сразу драг = одна стена, клик = только
          // начало цепочки).
          wallDragFrom = snappedPoint(x, y);
          return;
        }
        const vertex = wallVertexNear(x, y, ctx.scene.walls, ctx.world.scale.x || 1);
        if (vertex) {
          draggingWallPoint = vertex;
          return;
        }
        // Клик по линии стены (не по её концу) — не двигать существующую
        // точку, а создать новую прямо тут и сразу утащить её этим же
        // жестом (см. splitWallAt выше).
        const wallId = wallNear(x, y, ctx.scene.walls, ctx.world.scale.x || 1);
        if (wallId) {
          splitWallAt(wallId, ctx.scene.walls[wallId], x, y);
        }
        return;
      }
      if (tool === "building") {
        if (buildingChain || createHeld) {
          // Весь commit — по mouseup (клик за кликом), mousedown тут только
          // проглатывает событие, чтобы не начать драг токена под курсором.
          return;
        }
        const vertex = buildingVertexNear(x, y, ctx.scene.buildings, ctx.world.scale.x || 1);
        if (vertex && !isLocked(ctx.scene.buildings[vertex.buildingId])) draggingBuildingPoint = vertex;
        return;
      }
      if (tool === "fog") {
        if (createHeld) {
          fogPath = [{ x, y }];
          return;
        }
        const scale = ctx.world.scale.x || 1;
        const fogVertex = fogVertexNear(x, y, ctx.scene.fogAreas, scale);
        if (fogVertex && !isLocked(ctx.scene.fogAreas[fogVertex.areaId])) {
          draggingFogVertex = fogVertex;
          return;
        }
        const fogId = fogAreaAt(x, y, ctx.scene.fogAreas);
        if (fogId && !isLocked(ctx.scene.fogAreas[fogId])) {
          draggingFogArea = { id: fogId, startX: x, startY: y, original: ctx.scene.fogAreas[fogId].points.map((p) => ({ x: p.x, y: p.y })) };
        }
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
        // Клик по значку двери (см. layers/doors.js) — единственное, что
        // остаётся доступно в "Выбор" без переключения в режим "Стена":
        // управление уже созданной дверью (открыть/закрыть) не структурная
        // правка стены, поэтому не гейтится инструментом "Стена" — см.
        // includeSecret=true — ДМ может кликом переключить и секретную
        // дверь, не открывая контекстное меню.
        const doorId = doorAt(x, y, ctx.scene.walls, ctx.world.scale.x || 1, true);
        if (doorId) {
          ctx.send({ type: "toggle_door", id: doorId });
          return;
        }
      }

      // skipLocked — запертый токен (domain.Token.Locked) для ЛКМ просто не
      // существует: ни утащить, ни выбрать целью атаки.
      const hitId = dmTokenAt(x, y, { skipLocked: true });
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
        // Shift+клик по токену — только переключить его в/из текущего
        // выделения (как в Foundry), само перетаскивание НЕ начинается: это
        // жест "поправить состав группы", не "подвинуть".
        if (e.shiftKey) {
          const next = new Set(selectedTokenIds);
          if (next.has(hitId)) next.delete(hitId);
          else next.add(hitId);
          setSelection(next);
          return;
        }
        // Клик без Shift по токену, который УЖЕ входит в групповое
        // выделение, — тащим всю группу, состав не трогаем. По токену вне
        // выделения — обычный клик заменяет выделение им одним (ровно как
        // одиночный драг работал раньше).
        if (!selectedTokenIds.has(hitId)) setSelection([hitId]);
        dragTokenId = hitId;
        const t0 = ctx.scene.tokens[hitId];
        dragStart = { x: t0.x, y: t0.y };
        dragLastPos = dragStart;
        dragTraveled = 0;
        ensureSpeedLoaded(t0);
        // Снимок стартовых позиций остальных выделенных токенов — двигать
        // их на mousemove той же дельтой, что и анкорный hitId (см.
        // rationale у groupDragOrigins выше).
        groupDragOrigins = new Map();
        for (const id of selectedTokenIds) {
          const tok = ctx.scene.tokens[id];
          if (tok) groupDragOrigins.set(id, { x: tok.x, y: tok.y });
        }
        return;
      }
      // Значок заметки перетаскивается только инструментом "выбор" — как и
      // токен выше, чтобы не мешать рисованию стен/тумана/здания.
      if (tool === "select") {
        const markerId = noteMarkerAt(x, y, ctx.scene.noteMarkers, 16, (m) => !isLocked(m));
        if (markerId && markerId === resizeArmedNoteMarkerId) {
          // Резайз армирован ИМЕННО для этого значка (см. vtt:armNoteMarkerResize
          // ниже) и mousedown попал по нему — начинаем драг размера, а не
          // перемещения; армирование одноразовое, снимаем сразу.
          resizingNoteMarkerId = markerId;
          resizeArmedNoteMarkerId = null;
        } else if (markerId) {
          dragNoteMarkerId = markerId;
        } else {
          // Пусто под курсором — начинаем резиновую рамку множественного
          // выделения (см. mousemove/mouseup ниже). additive — зажат ли
          // Shift: тогда по mouseup рамка ДОБАВЛЯЕТ токены к уже выделенным
          // вместо замены — тот же приём, что и shift-клик по одному токену
          // выше.
          marquee = { x0: x, y0: y, x, y, additive: e.shiftKey };
        }
      }
    });

    canvas.addEventListener("mousemove", (e) => {
      const { x, y } = mousePos(e);
      const scale = ctx.world.scale.x || 1;

      if (marquee) {
        marquee.x = x;
        marquee.y = y;
        const rx = Math.min(marquee.x0, marquee.x);
        const ry = Math.min(marquee.y0, marquee.y);
        const rw = Math.abs(marquee.x - marquee.x0);
        const rh = Math.abs(marquee.y - marquee.y0);
        preview.clear();
        preview.rect(rx, ry, rw, rh).fill({ color: 0x5dd0ff, alpha: 0.12 }).stroke({ width: 1.5 / scale, color: 0x5dd0ff, alpha: 0.9 });
        return;
      }

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

      if (draggingBuildingPoint) {
        // Переформовка контура здания — двигает ровно одну вершину;
        // "add_building" с тем же id — апсерт на сервере (см.
        // room.go:applyMutation "add_building"), тот же приём, что и у
        // draggingFogVertex выше.
        const b = ctx.scene.buildings[draggingBuildingPoint.buildingId];
        if (b) {
          b.points[draggingBuildingPoint.index] = { x, y };
          ctx.dirty.buildings = true;
          ctx.render();
          ctx.send({ type: "add_building", building: { id: b.id, points: b.points } });
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
      // Токен мог быть заперт (или удалён) уже ПОСЛЕ начала жеста — с
      // другого экрана ДМ или из списка источников света; тогда жест просто
      // прекращается, а не продолжает двигать запертое. Тем же способом
      // обрывается жест, если за это время начался бой (или наступил чужой
      // ход) — ДМ двигает только текущего бойца, как и все остальные, см.
      // turnBlocksMove выше и room.go: turnAllowsTokenMove (сервер такую
      // правку и так отбросит — тут та же проверка ДО отправки, чтобы токен
      // не дёргался туда-обратно).
      if (!t || isLocked(t) || turnBlocksMove(t)) {
        dragTokenId = null;
        distanceLabel.hide();
        groupDragOrigins = null;
        return;
      }
      // Лимит скорости — та же логика, что и у драга игроком своего токена
      // (см. speedLimitFor выше): работает, только пока идёт бой И сейчас
      // ход именно этого токена. Вне боя или не в чужой ход ограничения нет,
      // "Одометр" для подсказки дистанции считается тем же способом
      // (см. geometry.trackMovementStep): накопленный путь, обнуляется
      // только при точном возврате в точку начала жеста.
      const { maxAllowed, limitUnits } = speedLimitFor(t);
      const step = trackMovementStep(dragLastPos, snapped, dragStart, dragTraveled, maxAllowed, ctx.scene.grid);
      t.x = step.pos.x;
      t.y = step.pos.y;
      dragLastPos = step.pos;
      dragTraveled = step.traveled;
      ctx.dirty.tokens = true;
      ctx.dirty.vision = true;
      ctx.dirty.buildings = true; // мог войти/выйти из контура здания — occupied() пересчитать
      ctx.render();
      distanceLabel.show(t.x, t.y, formatDistanceValue(dragTraveled, ctx.scene.grid, limitUnits));
      ctx.send({ type: "move_token", token: t });

      // Остальные токены группового выделения едут ТОЙ ЖЕ дельтой от своей
      // исходной позиции (groupDragOrigins, снятой на mousedown) — без
      // собственного снаппинга: иначе фигура выделения "разъезжалась" бы по
      // сетке, если бы каждый токен подгонялся к ближайшей клетке отдельно.
      if (groupDragOrigins && groupDragOrigins.size > 1) {
        const anchorOrigin = groupDragOrigins.get(dragTokenId) || dragStart;
        const dx = t.x - anchorOrigin.x;
        const dy = t.y - anchorOrigin.y;
        for (const [id, origin] of groupDragOrigins) {
          if (id === dragTokenId) continue;
          const other = ctx.scene.tokens[id];
          if (!other || isLocked(other) || turnBlocksMove(other)) continue;
          other.x = origin.x + dx;
          other.y = origin.y + dy;
          ctx.send({ type: "move_token", token: other });
        }
      }
    });

    canvas.addEventListener("mouseup", (e) => {
      if (marquee) {
        const rx0 = Math.min(marquee.x0, marquee.x);
        const ry0 = Math.min(marquee.y0, marquee.y);
        const rx1 = Math.max(marquee.x0, marquee.x);
        const ry1 = Math.max(marquee.y0, marquee.y);
        // Порог в мировых пикселях — отличить реальную рамку от дрожания
        // руки на обычном клике по пустому месту (тот просто снимает
        // выделение, см. ветку ниже).
        const dragged = Math.hypot(marquee.x - marquee.x0, marquee.y - marquee.y0) > 4;
        preview.clear();
        if (dragged) {
          const hitIds = Object.entries(ctx.scene.tokens)
            .filter(([, tok]) => !tok.lightOnly && !isLocked(tok) && tok.x >= rx0 && tok.x <= rx1 && tok.y >= ry0 && tok.y <= ry1)
            .map(([id]) => id);
          if (marquee.additive) {
            const next = new Set(selectedTokenIds);
            for (const id of hitIds) next.add(id);
            setSelection(next);
          } else {
            setSelection(hitIds);
          }
        } else if (!marquee.additive) {
          // Просто клик по пустому месту карты — снять выделение (как клик
          // по пустоте в Foundry).
          setSelection([]);
        }
        marquee = null;
        return;
      }

      // wallChainLast/wallDragFrom/buildingChain ставятся ТОЛЬКО при
      // зажатом Ctrl на mousedown (см. выше) — значит их наличие тут само
      // по себе означает "идёт рисование нового", и перепроверять Ctrl на
      // mouseup не нужно: отпустить его посреди цепочки — не отмена (можно
      // домышить/докликать цепочку без Ctrl, см. rationale у mousedown).
      // Если ни один из них не взведён — это был жест ПРАВКИ существующего
      // (draggingWallPoint/draggingBuildingPoint/...), обработка ниже.
      if (tool === "wall" && (wallChainLast || wallDragFrom)) {
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

      if (tool === "building" && (buildingChain || e.ctrlKey || e.metaKey)) {
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

      if (draggingBuildingPoint) {
        draggingBuildingPoint = null;
        return;
      }

      dragTokenId = null;
      dragStart = null;
      dragLastPos = null;
      dragTraveled = 0;
      groupDragOrigins = null;
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
      if (marquee) {
        marquee = null;
        preview.clear();
      }
      if (selectedTokenIds.size) setSelection([]);
    });

    // isTypingTarget — активный элемент прямо сейчас принимает текстовый
    // ввод (поле имени токена, чат, любая форма панели). Delete/Backspace в
    // такой момент — это правка текста, а НЕ команда "удалить выделенные
    // токены" (см. keydown ниже), иначе стирание последнего символа в поле
    // сносило бы выделенных монстров со сцены.
    function isTypingTarget() {
      const el = document.activeElement;
      if (!el) return false;
      if (el.isContentEditable) return true;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    }

    // Delete/Backspace — удалить со сцены всё групповое выделение разом
    // (аналог того же действия в Foundry). Тот же remove_token, что шлёт
    // ПКМ-меню одного токена (см. vtt:removeToken ниже) — просто по одному
    // сообщению на каждый выделенный id.
    window.addEventListener("keydown", (e) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (!selectedTokenIds.size || isTypingTarget()) return;
      e.preventDefault();
      for (const id of selectedTokenIds) ctx.send({ type: "remove_token", id });
      setSelection([]);
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
      const hitId = dmTokenAt(x, y, { skipLocked: true });
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
        const marker = ctx.scene.noteMarkers[markerId];
        // library — из какой библиотеки запись (см. domain.NoteMarker):
        // пусто у значков, поставленных до появления журнала, — это заметки ДМ.
        // foundryEntry/foundryFolder — значок из импорта модуля: настоящей
        // заметки ещё нет, pages/dm.js резолвит её по имени на этом клике.
        document.dispatchEvent(
          new CustomEvent("vtt:openNoteMarker", {
            detail: {
              noteId: marker.noteId,
              library: marker.library || "",
              section: marker.section || "",
              foundryEntry: marker.foundryEntry || "",
              foundryFolder: marker.foundryFolder || "",
            },
          })
        );
        return;
      }
    });

    // ПКМ: во время рисования цепочки стен/здания — просто закончить её (не
    // удалять уже поставленное). Дальше — структурные действия над
    // стеной/тумана/зданием (удалить точку, классифицировать сегмент,
    // снести контур целиком) гейтятся СВОИМ инструментом, как и вся правка
    // (см. requirement 1 у mousedown выше): вне "Стена"/"Туман"/"Здание"
    // соответствующий ПКМ просто ничего не делает. Исключение —
    // управление уже существующей дверью (открыть/закрыть/запереть):
    // остаётся доступно и в "Выбор" (см. requirement 5, тот же
    // wallContextMenu, но с урезанным набором пунктов — см.
    // pages/dm.js:vtt:wallContextMenu). Токен/значок заметки — вне этой
    // задачи, доступны как и раньше независимо от инструмента.
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

      if (tool === "wall") {
        const vertex = wallVertexNear(x, y, ctx.scene.walls, scale);
        if (vertex) {
          document.dispatchEvent(
            new CustomEvent("vtt:wallPointContextMenu", { detail: { refs: vertex.refs, pageX: e.clientX, pageY: e.clientY } })
          );
          return;
        }
      }

      // Стена (не по её концу): в "Стена" — полное меню (классификация/
      // удаление сегмента); в "Выбор" — то же меню, но только если на
      // сегменте уже есть дверь (иначе там нечем управлять, и правка
      // структуры недоступна — см. requirement 1). tool в detail — чтобы
      // pages/dm.js показал нужный подмножество пунктов (см. там же).
      if (tool === "wall" || tool === "select") {
        const wallId = wallNear(x, y, ctx.scene.walls, scale);
        const wall = wallId && ctx.scene.walls[wallId];
        if (wall && (tool === "wall" || wall.door)) {
          document.dispatchEvent(
            new CustomEvent("vtt:wallContextMenu", { detail: { id: wallId, wall, tool, pageX: e.clientX, pageY: e.clientY } })
          );
          return;
        }
      }

      const hitId = dmTokenAt(x, y);
      if (hitId) {
        // ids — весь состав группового выделения, если ПКМ пришёлся по
        // токену, который в него входит (и выделено больше одного) — тогда
        // pages/dm.js открывает урезанное "пачечное" меню и применяет
        // действия (инициатива/состояния/свет/удаление) сразу ко всем.
        // Промах мимо выделения или одиночный токен — как раньше, id один.
        const ids = selectedTokenIds.size > 1 && selectedTokenIds.has(hitId) ? [...selectedTokenIds] : [hitId];
        document.dispatchEvent(
          new CustomEvent("vtt:tokenContextMenu", {
            detail: { id: hitId, token: ctx.scene.tokens[hitId], ids, pageX: e.clientX, pageY: e.clientY },
          })
        );
        return;
      }

      // Фигура тумана — ПКМ открывает меню (см. web/dm.html #fogAreaMenu),
      // только в инструменте "Туман" (см. requirement 1).
      if (tool === "fog") {
        const fogId = fogAreaAt(x, y, ctx.scene.fogAreas);
        if (fogId) {
          document.dispatchEvent(
            new CustomEvent("vtt:fogAreaContextMenu", { detail: { id: fogId, pageX: e.clientX, pageY: e.clientY } })
          );
          return;
        }
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

      // Здание (клик внутри контура, в отличие от стен — отдельной точки
      // "конца" тут нет) — ПКМ открывает меню (см. web/dm.html
      // #buildingMenu), как у фигуры тумана/стены, а не удаляет сразу —
      // случайный ПКМ во время осмотра карты в инструменте "Здание" не
      // должен сносить контур без подтверждения. Только в инструменте
      // "Здание" (см. requirement 1).
      if (tool === "building") {
        const buildingId = buildingAt(x, y, ctx.scene.buildings);
        if (buildingId) {
          document.dispatchEvent(
            new CustomEvent("vtt:buildingContextMenu", { detail: { id: buildingId, pageX: e.clientX, pageY: e.clientY } })
          );
          return;
        }
      }

      // Ни во что не попали — это ПКМ по ПУСТОМУ месту карты. Раньше он
      // просто ничего не делал; теперь это точка вставки скопированного
      // объекта (см. pages/dm.js: #canvasMenu / "Вставить"). Мировые
      // координаты идут в detail рядом с экранными: меню рисуется по
      // экранным, а вставлять объект надо ровно туда, куда ткнули на карте,
      // и пересчитывать это заново в dm.js было бы вторым источником правды
      // о камере.
      document.dispatchEvent(
        new CustomEvent("vtt:canvasContextMenu", { detail: { x, y, pageX: e.clientX, pageY: e.clientY } })
      );
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

    // команда из меню здания (см. web/dm.html #buildingMenu)
    document.addEventListener("vtt:removeBuilding", (e) => {
      ctx.send({ type: "remove_building", id: e.detail.id });
    });

    // команда из меню стены (см. web/dm.html #wallMenu) — удаляет ОДИН
    // сегмент целиком (в отличие от vtt:removeWallPoint выше, который берёт
    // все стены, сходящиеся в одной точке).
    document.addEventListener("vtt:removeWall", (e) => {
      ctx.send({ type: "remove_wall", id: e.detail.id });
    });

    // команды из меню стены/двери (см. web/dm.html #wallMenu, pages/dm.js) —
    // классификация сегмента (дверь/секретная/окно/обычная стена) и
    // состояние двери (открыть-закрыть/запереть-отпереть), см.
    // domain.Wall.Door/DoorState/Window и обработчики в service/room.go.
    document.addEventListener("vtt:setWallDoor", (e) => {
      ctx.send({ type: "set_wall_door", id: e.detail.id, door: e.detail.door });
    });
    document.addEventListener("vtt:setWallWindow", (e) => {
      ctx.send({ type: "set_wall_window", id: e.detail.id, window: e.detail.window });
    });
    document.addEventListener("vtt:toggleDoor", (e) => {
      ctx.send({ type: "toggle_door", id: e.detail.id });
    });
    document.addEventListener("vtt:setDoorLock", (e) => {
      ctx.send({ type: "set_door_lock", id: e.detail.id, locked: e.detail.locked });
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
      // Убитый через ПКМ-меню токен мог быть частью группового выделения —
      // не оставляем в selectedTokenIds ссылку на уже несуществующий id.
      if (selectedTokenIds.has(e.detail.id)) {
        const next = new Set(selectedTokenIds);
        next.delete(e.detail.id);
        setSelection(next);
      }
    });

    // vtt:setMapObjectLocked — универсальный замок (см. map-objects.js и
    // domain.Token.Locked): один обработчик на все виды объектов карты
    // вместо своего "vtt:setTokenLocked"/"vtt:setBuildingLocked"/… на
    // каждый. Сервер во всех четырёх случаях делает апсерт целого объекта
    // по id (см. service.Room.applyMutation), поэтому шлём его копию с
    // изменённым флагом — тем же приёмом, что и vtt:setTokenHidden выше.
    document.addEventListener("vtt:setMapObjectLocked", (e) => {
      const { kind, id, locked } = e.detail || {};
      const meta = MAP_OBJECT_KINDS[kind];
      const obj = meta && mapObjectsOf(ctx.scene, kind)[id];
      if (!meta || !obj) return;
      ctx.send({ type: meta.saveType, [meta.payload]: { ...obj, locked: !!locked } });
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
        noteMarker: {
          id: "nm-" + Date.now(),
          noteId: payload.noteId,
          library: payload.library || "",
          label: payload.label,
          x,
          y,
        },
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

    // speedCache/ensureSpeedLoaded/currentCombatantFor — общие с ДМ-веткой
    // выше (см. их определение и обоснование там): характеристика
    // "Скорость" персонажа, подтянутая с сервера отдельным запросом (токен/
    // сцена её не несут — это поле листа персонажа, см.
    // internal/domain/character_sheet.go), и лимит применяется только в свой
    // ход активного боя.

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
      // Клик по значку двери (см. layers/doors.js) — единственное стеновое
      // взаимодействие, доступное игроку (см. authorize/handleToggleDoor в
      // service/room.go): переключает closed<->open. includeSecret=false —
      // игрок не видит и не может кликнуть секретную дверь (сервер её и так
      // отдельно отбрасывает, это просто чтобы клик по "пустому месту" не
      // пытался попасть в неё же случайно). Запертую/секретную сервер молча
      // проигнорирует — тут заранее не различаем, просто шлём попытку.
      const doorId = doorAt(x, y, ctx.scene.walls, ctx.world.scale.x || 1, false);
      if (doorId) {
        ctx.send({ type: "toggle_door", id: doorId });
        return;
      }
      // Хит-тест сразу сужен до того, что игрок вообще МОЖЕТ потащить —
      // свой и незапертый токен. Раньше тут был хит-тест "любой токен", и
      // проверка владельца шла уже после него: стоило собственному токену
      // встать на клетку с монстром, токеном света или ассетом карты, как
      // клик попадал в чужой объект, драг не начинался, и персонаж
      // "залипал" на месте — сойти он не мог, пока ДМ не убирал то, на что
      // он наступил (см. geometry.tokenAt о порядке выбора из стопки).
      const hitId = tokenAt(x, y, ctx.scene.tokens, {
        filter: (t) => t.ownerId === ctx.playerId && !isLocked(t) && !turnBlocksMove(t),
      });
      if (hitId) {
        dragTokenId = hitId;
        const t0 = ctx.scene.tokens[hitId];
        dragStart = { x: t0.x, y: t0.y };
        dragLastPos = dragStart;
        dragTraveled = 0;
        ensureSpeedLoaded(t0);
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
      // Бой мог начаться (или дойти до чужого хода) уже ПОСЛЕ начала жеста —
      // тем же способом, что и isLocked ниже: жест просто обрывается, см.
      // turnBlocksMove выше и room.go: turnAllowsTokenMove.
      if (!t || t.ownerId !== ctx.playerId || isLocked(t) || turnBlocksMove(t)) {
        dragTokenId = null;
        distanceLabel.hide();
        return;
      }
      const snapped = snapToGrid(x, y, ctx.scene.grid);

      // Лимит скорости (см. speedLimitFor выше) — только пока идёт бой И
      // сейчас ход именно этого персонажа (вне своего хода в бою движение уже
      // отсечено проверкой turnBlocksMove выше). Вне боя — без ограничения.
      const { maxAllowed, limitUnits } = speedLimitFor(t);

      // Расстояние — накопленный путь этого жеста (см.
      // geometry.trackMovementStep), а не прямая от точки старта: шаг
      // назад/вбок тоже прибавляется к одометру, как и реальные шаги
      // персонажа, и лимит расходуется соответственно. Обнуляется в ноль
      // (и лимит выдаётся заново), только если токен оказался РОВНО в
      // точке, откуда начался весь жест (dragStart) — именно этот случай
      // и есть "вернул персонажа — верни движение" из уточнения задачи.
      // Стены/закрытые двери/окна физически блокируют перемещение СВОЕГО
      // токена игроком (см. clampMoveByWalls в geometry.js) — путь до
      // снапнутой клетки останавливается чуть НЕ доходя до преграды, если
      // пересекает её. У ДМ (ветка выше) такого ограничения нет — полная
      // авторская власть над картой в смысле стен, лимит скорости в свой
      // ход при этом всё равно применяется (см. speedLimitFor выше).
      const wallClamped = clampMoveByWalls(dragLastPos.x, dragLastPos.y, snapped.x, snapped.y, ctx.scene.walls);

      const step = trackMovementStep(dragLastPos, wallClamped, dragStart, dragTraveled, maxAllowed, ctx.scene.grid);
      t.x = step.pos.x;
      t.y = step.pos.y;
      dragLastPos = step.pos;
      dragTraveled = step.traveled;
      ctx.dirty.tokens = true;
      // Освещение — СРАЗУ, не дожидаясь, пока сервер пришлёт снапшот с этим
      // же перемещением обратно. Раньше тут стоял только dirty.tokens:
      // кружок токена уезжал за курсором мгновенно, а туман вокруг него
      // перерисовывался лишь после круга «отправили -> сервер -> снапшот»,
      // то есть всегда отставал от токена. За столом это читается как
      // «лагает, будто пинг большой», даже когда сервер стоит в той же
      // локальной сети. Лишней работы это не добавляет: пришедший следом
      // снапшот несёт РОВНО ту позицию, которую мы уже применили, и
      // пересчёт на нём отсекается по planInputKey (см. vision-plan.js).
      ctx.dirty.vision = true;
      ctx.dirty.buildings = true; // мог войти/выйти из контура здания — occupied() пересчитать
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
      // Ищем сразу ТРУП С ДОБЫЧЕЙ, а не "любой токен, а потом посмотрим":
      // мародёрствуют обычно стоя прямо на теле, и хит-тест "первый
      // попавшийся" отдавал бы токен того, кто на нём стоит (см. тот же
      // разбор у mousedown выше).
      const hitId = tokenAt(x, y, ctx.scene.tokens, {
        filter: (t) => t.dead && Array.isArray(t.loot) && t.loot.length > 0,
      });
      if (!hitId) return;
      const t = ctx.scene.tokens[hitId];
      const loot = t.loot;
      if (!(ctx.combat && ctx.combat.lootingEnabled)) return;
      e.preventDefault();
      document.dispatchEvent(new CustomEvent("vtt:tokenLootRequest", { detail: { tokenId: hitId, loot, name: t.label } }));
    });
  }
}
