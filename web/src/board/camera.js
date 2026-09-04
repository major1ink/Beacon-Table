// board/camera.js — камера бесконечного холста.
//
// Отдельная от vtt/camera.js намеренно. Та считает базовый масштаб как
// min(экран/мир) — вписывает карту сцены в окно, и без размеров мира просто
// не имеет смысла. У доски мира нет: холст бесконечен, «вписать» нечего, а
// зум — абсолютный, а не относительно какого-то исходного вписывания.
// Протаскивать через все функции сцены флаг «а тут мира нет» значило бы
// усложнить работающий код ради чужого случая; сорок строк рядом честнее.
//
// Модель: camera.x/camera.y — мировая точка в ЦЕНТРЕ экрана, zoom —
// экранных пикселей на мировой. Ровно как у сцены, минус базовый масштаб.

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

export function createBoardCamera() {
  return { x: 0, y: 0, zoom: 1 };
}

export function boardTransform(camera, screenW, screenH) {
  const scale = camera.zoom;
  return { scale, offX: screenW / 2 - camera.x * scale, offY: screenH / 2 - camera.y * scale };
}

// applyBoardCamera — положить мир Pixi по камере. Возвращает transform,
// чтобы вызывающему не считать его второй раз.
export function applyBoardCamera(world, camera, screenW, screenH) {
  const t = boardTransform(camera, screenW, screenH);
  world.scale.set(t.scale);
  world.position.set(t.offX, t.offY);
  return t;
}

export function boardScreenToWorld(sx, sy, camera, screenW, screenH) {
  const { scale, offX, offY } = boardTransform(camera, screenW, screenH);
  return { x: (sx - offX) / scale, y: (sy - offY) / scale };
}

// zoomBoardAt — зум вокруг точки экрана: мировая точка под курсором остаётся
// под курсором. Иначе колесо утаскивало бы холст в сторону от того места, на
// которое смотришь.
export function zoomBoardAt(camera, sx, sy, factor, screenW, screenH) {
  const before = boardScreenToWorld(sx, sy, camera, screenW, screenH);
  camera.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.zoom * factor));
  const after = boardScreenToWorld(sx, sy, camera, screenW, screenH);
  camera.x += before.x - after.x;
  camera.y += before.y - after.y;
}

// fitBoard — «показать всё»: вписать переданные границы в экран. bounds
// пустой (на доске пока ничего нет) — просто вернуть камеру в начало
// координат с масштабом 1:1, потому что вписывать нечего.
export function fitBoard(camera, bounds, screenW, screenH, padding = 80) {
  if (!bounds || bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) {
    camera.x = 0;
    camera.y = 0;
    camera.zoom = 1;
    return;
  }
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  const zoom = Math.min((screenW - padding * 2) / w, (screenH - padding * 2) / h) || 1;
  camera.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
  camera.x = bounds.minX + w / 2;
  camera.y = bounds.minY + h / 2;
}
