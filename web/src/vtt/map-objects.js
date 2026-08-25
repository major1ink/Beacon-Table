import { Graphics } from "pixi.js";
import { MAX_ZOOM } from "./camera.js";

// Универсальная механика "объектов карты" — то общее, что есть у токена,
// значка заметки, фигуры тумана и здания, и чего раньше не было ни у кого:
//
//   * БЛОКИРОВКА (domain.*.Locked) — запертый объект не тащится мышью, не
//     правится и не удаляется, пока ДМ не снимет замок. Одна функция
//     isLocked() на все четыре вида — новый вид объекта включается в схему
//     тем, что у него появляется то же поле locked (см. коммент у
//     domain.Token.Locked о том, почему поле одно и то же, а не своё на
//     каждую структуру).
//   * ФОКУСИРОВКА — "покажи мне, где он": камера едет в центр объекта и на
//     пару секунд вокруг него пульсирует кольцо. Нужна везде, где объект
//     ищут по СПИСКУ, а не глазами по карте (список источников света в
//     панели "Освещение" — первый такой список, но не последний).
//
// Оба механизма СОЗНАТЕЛЬНО живут здесь, а не внутри кода панели света:
// требование — применить их дальше ко всем ассетам и объектам карты, и
// цена этого должна быть "добавь вид в MAP_OBJECT_KINDS", а не "скопируй
// ещё раз двести строк".

// MAP_OBJECT_KINDS — вид объекта -> поле сцены, где он лежит, и тип
// WS-сообщения, которым он сохраняется целиком (сервер во всех четырёх
// случаях делает апсерт по id — см. service.Room.applyMutation). Ключ
// ("token"/"noteMarker"/"fogArea"/"building") ходит в detail событий
// vtt:setMapObjectLocked / vtt:focusMapObject.
export const MAP_OBJECT_KINDS = {
  token: { collection: "tokens", saveType: "move_token", payload: "token" },
  noteMarker: { collection: "noteMarkers", saveType: "move_note_marker", payload: "noteMarker" },
  fogArea: { collection: "fogAreas", saveType: "add_fog_area", payload: "fogArea" },
  building: { collection: "buildings", saveType: "add_building", payload: "building" },
};

// isLocked — единственная проверка замка во всём клиенте. Принимает сам
// объект (а не пару вид+id) — вызывающему коду обычно он уже в руках.
export function isLocked(obj) {
  return !!(obj && obj.locked);
}

// mapObjectsOf — коллекция сцены для вида объекта ({} для неизвестного
// вида, чтобы вызывающий код не проверял вид отдельно).
export function mapObjectsOf(scene, kind) {
  const meta = MAP_OBJECT_KINDS[kind];
  return (meta && scene && scene[meta.collection]) || {};
}

// mapObjectCenter — точка, в которую наводится камера при фокусировке.
// У токена/значка это его x/y, у тумана/здания — центр охватывающего
// прямоугольника контура (у них нет собственной "позиции", только точки).
export function mapObjectCenter(obj) {
  if (!obj) return null;
  if (Array.isArray(obj.points) && obj.points.length) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of obj.points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, radius: Math.max(maxX - minX, maxY - minY) / 2 || 24 };
  }
  if (typeof obj.x !== "number" || typeof obj.y !== "number") return null;
  return { x: obj.x, y: obj.y, radius: obj.size || 24 };
}

// createMapObjectFocus — подсветка "вот он" + наведение камеры. Кольцо
// рисуется в МИРОВЫХ координатах (обычный child ctx.world), поэтому едет
// вместе с картой, если ДМ продолжит панить/зумить, пока оно не погасло.
// Толщина линии делится на текущий масштаб — как у всех остальных
// оверлеев ДМ (см. layers/tokens.js: ownerRing).
//
// applyCamera — колбэк вызывающего (interaction.js), который применяет
// изменённую камеру и перерисовывает слои: сама камера тут только
// вычисляется, а знание о том, какие dirty-биты надо поднять после её
// сдвига, остаётся в одном месте (см. markCameraDirty там же).
export function createMapObjectFocus(ctx, applyCamera) {
  const ring = new Graphics();
  ring.visible = false;
  ctx.world.addChild(ring);

  const DURATION_MS = 2200;
  let target = null; // {x,y,radius,start}
  let ticking = false;

  function tick() {
    if (!target) return stop();
    const t = (performance.now() - target.start) / DURATION_MS;
    if (t >= 1) return stop();
    const scale = ctx.world.scale.x || 1;
    // Три волны за время подсветки: кольцо разбегается от объекта наружу и
    // гаснет — заметно боковым зрением на любой карте, но не перекрывает
    // сам объект (заливки нет, только контур).
    const wave = (t * 3) % 1;
    const r = target.radius * (1.15 + wave * 1.6);
    ring.clear();
    ring.circle(target.x, target.y, r).stroke({ width: 3 / scale, color: 0x5dd0ff, alpha: (1 - wave) * (1 - t) });
    ring.circle(target.x, target.y, target.radius * 1.1).stroke({ width: 2 / scale, color: 0x5dd0ff, alpha: 0.75 * (1 - t) });
    ring.visible = true;
  }

  function stop() {
    ring.clear();
    ring.visible = false;
    target = null;
    if (ticking) {
      ctx.app.ticker.remove(tick);
      ticking = false;
    }
  }

  // focus — навести камеру на объект и подсветить его. minZoom: не
  // отдаляем то, что и так рассмотрено вблизи, но и не оставляем объект
  // микроскопическим, если ДМ смотрел на всю карту разом.
  function focus(obj, opts) {
    const c = mapObjectCenter(obj);
    if (!c) return;
    const minZoom = (opts && opts.minZoom) || 1.4;
    ctx.camera.x = c.x;
    ctx.camera.y = c.y;
    if (ctx.camera.zoom < minZoom) ctx.camera.zoom = Math.min(MAX_ZOOM, minZoom);
    if (applyCamera) applyCamera();
    target = { x: c.x, y: c.y, radius: Math.max(16, c.radius), start: performance.now() };
    if (!ticking) {
      ticking = true;
      ctx.app.ticker.add(tick);
    }
    tick();
  }

  return { focus, stop };
}
