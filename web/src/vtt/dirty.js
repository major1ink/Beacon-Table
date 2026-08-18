// Флаги "что реально изменилось со времени последней перерисовки" — корневой
// фикс краша, из-за которого затеян весь переезд на PixiJS (см. план:
// /home/major/.claude/plans/imperative-baking-thunder.md, раздел "Корневой
// фикс"). В старом Canvas2D-движке vision/fog пересчитывались ВНУТРИ draw(),
// которую гонял rAF-цикл видео-фона на каждый кадр — даже если ни один
// токен/стена/фигура тумана не менялись. computeVisibilityPolygon
// (raycasting против всех стен для каждого токена) и blur-заливка тумана —
// дорогие операции, пересчитывать их 60 раз в секунду без необходимости не
// нужно было никогда, Canvas2D просто не проектировался так, чтобы это было
// легко избежать (immediate-mode: перерисовка = redraw всего).
//
// Здесь — противоположный, retained-mode подход: каждый слой знает, ПОЧЕМУ
// он мог устареть, и сам решает, обновляться или нет. markSceneDirty (см.
// net.js: применяется при каждом WS snapshot) диффит новый scene против
// предыдущего и выставляет только те биты, что реально изменились.
export function createDirtyFlags() {
  return {
    tokens: true,
    vision: true, // computeVisibilityPolygon + drawVisionFog — самая дорогая часть
    walls: true,
    buildings: true, // контуры зданий + их "крыша" у игрока (layers/buildings.js)
    manualFog: true, // blur-заливка фигур тумана — вторая дорогая часть
    grid: true,
    background: true,
    worldSize: true, // размеры сцены сменились — камеру надо пересчитать заново
  };
}

// diffAndMarkDirty — сравнивает новый и старый scene, выставляет только
// затронутые биты. Сравнение — по ссылке/JSON, а не построчный дифф: снапшоты
// приходят с частотой WS-сообщений (не кадров), так что даже наивное
// сравнение здесь на порядки дешевле того, что оно заменяет.
export function diffAndMarkDirty(dirty, prevScene, nextScene) {
  if (!prevScene || prevScene.tokens !== nextScene.tokens) {
    dirty.tokens = true;
    dirty.vision = true; // позиции токенов — вход для видимости
    dirty.buildings = true; // и вход для occupied() — есть ли токен внутри контура
  }
  if (!prevScene || prevScene.walls !== nextScene.walls) {
    dirty.walls = true;
    dirty.vision = true;
  }
  if (!prevScene || prevScene.buildings !== nextScene.buildings) {
    dirty.buildings = true;
    dirty.vision = true; // контур здания — тоже препятствие для raycasting'а (см. layers/vision-fog.js)
  }
  if (!prevScene || prevScene.fogAreas !== nextScene.fogAreas) {
    dirty.manualFog = true;
  }
  if (!prevScene || prevScene.grid !== nextScene.grid) {
    dirty.grid = true;
  }
  if (!prevScene || prevScene.mapUrl !== nextScene.mapUrl) {
    dirty.background = true;
  }
  if (!prevScene || prevScene.noteMarkers !== nextScene.noteMarkers) {
    dirty.tokens = true; // значки заметок (layers/note-markers.js) обновляются тем же битом, что и токены — отдельный не нужен, обновление дешёвое
  }
  if (!prevScene || prevScene.fogOfWar !== nextScene.fogOfWar) {
    dirty.vision = true;
  }
  if (!prevScene || prevScene.globalLight !== nextScene.globalLight) {
    dirty.vision = true; // свет "на всю карту" (кнопки тулбара) — вход для видимости, как и стены/токены
  }
  // Размеры сцены — вход не только для геометрии слоёв, но и для КАМЕРЫ:
  // getTransform считает базовый масштаб как min(screen/world). Раньше этот
  // случай не отслеживался вообще, а applyCameraTransform вызывалась только
  // при инициализации (то есть ДО первого снапшота, на дефолтных 1280×720),
  // при ресайзе окна и при ручном пане/зуме. В результате сцена с размерами,
  // отличными от дефолтных, рисовалась с масштабом от ЧУЖОГО мира: карта
  // 3840×2160 при живом world.scale = 1 показывала левый верхний угол вместо
  // всей карты, а camera.x/y продолжали указывать в центр старого мира
  // (640×360 вместо 1920×1080). Чинилось случайным образом — стоило дёрнуть
  // окно или колесо мыши, и камера пересчитывалась правильно.
  if (!prevScene || prevScene.width !== nextScene.width || prevScene.height !== nextScene.height) {
    dirty.worldSize = true;
    dirty.grid = true;
    dirty.vision = true;
    dirty.buildings = true;
    dirty.manualFog = true;
    dirty.background = true;
  }
  // Смена сцены целиком: пан/зум от предыдущей карты к новой отношения не
  // имеют — центр старого мира может вообще лежать за пределами нового.
  if (!prevScene || prevScene.id !== nextScene.id) {
    dirty.resetCamera = true;
  }
}
