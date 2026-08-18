// Локальная камера (letterbox-масштаб мирового пространства + pan/zoom) —
// та же математика, что была в static/js/app.js (getTransform/screenToWorld/
// zoomAt), но как чистые функции: screenW/screenH и scene/camera передаются
// аргументами, а не читаются из замыкания initVTT. Пишут результат не в
// ctx.translate/scale (Canvas2D), а в PIXI.Container.scale/position — сам
// мировой контейнер один на все слои, поэтому камера двигает их разом
// бесплатно через сцен-граф, без пересчёта геометрии слоёв (см. dirty.js).
//
// screenW/screenH — ЛОГИЧЕСКИЙ (CSS-пиксельный) размер экрана Pixi
// (app.screen.width/height), не физический device-pixel размер: Pixi сам
// разруливает devicePixelRatio через renderer.resolution, здесь и в
// PointerEvent.global координаты уже в одном и том же логическом
// пространстве — в отличие от старого Canvas2D-кода, руками умножавшего на
// devicePixelRatio, отдельная конвертация тут не нужна.

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 6;
export const DEFAULT_WORLD_W = 1280;
export const DEFAULT_WORLD_H = 720;

export function worldSize(scene) {
  return { w: (scene && scene.width) || DEFAULT_WORLD_W, h: (scene && scene.height) || DEFAULT_WORLD_H };
}

export function createCamera(scene) {
  const ws = worldSize(scene);
  return { zoom: 1, x: ws.w / 2, y: ws.h / 2 };
}

export function getTransform(screenW, screenH, scene, camera) {
  const ws = worldSize(scene);
  const baseScale = Math.min(screenW / ws.w, screenH / ws.h) || 1;
  const scale = baseScale * camera.zoom;
  return {
    scale,
    offX: screenW / 2 - camera.x * scale,
    offY: screenH / 2 - camera.y * scale,
  };
}

// applyCameraTransform — применяет текущую камеру к мировому контейнеру.
// Вызывается на resize и на любое изменение camera.{zoom,x,y} — дёшево
// (просто матрица трансформации), не требует пересчёта содержимого слоёв.
export function applyCameraTransform(world, screenW, screenH, scene, camera) {
  const { scale, offX, offY } = getTransform(screenW, screenH, scene, camera);
  world.scale.set(scale);
  world.position.set(offX, offY);
  return { scale, offX, offY };
}

export function screenToWorld(sx, sy, screenW, screenH, scene, camera) {
  const { scale, offX, offY } = getTransform(screenW, screenH, scene, camera);
  return { x: (sx - offX) / scale, y: (sy - offY) / scale };
}

// canvasPos — CSS-пиксельные координаты события относительно канваса; в
// логическом (не device-pixel) пространстве Pixi это то же самое, что и
// screen-координаты, конвертация через devicePixelRatio не нужна (см.
// комментарий выше).
export function canvasPos(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  return { sx: e.clientX - rect.left, sy: e.clientY - rect.top };
}

// zoomAt — зум с фиксацией точки под курсором (та же мировая точка остаётся
// под курсором после изменения масштаба). Мутирует camera напрямую.
export function zoomAt(camera, sx, sy, factor, screenW, screenH, scene) {
  const before = screenToWorld(sx, sy, screenW, screenH, scene, camera);
  camera.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.zoom * factor));
  const { scale } = getTransform(screenW, screenH, scene, camera);
  camera.x = before.x - (sx - screenW / 2) / scale;
  camera.y = before.y - (sy - screenH / 2) / scale;
}

export function resetCamera(camera, scene) {
  const ws = worldSize(scene);
  camera.zoom = 1;
  camera.x = ws.w / 2;
  camera.y = ws.h / 2;
}
