// pages/board.js — страница одной доски: бесконечный холст.
//
// Страница открывает доску по ссылке, показывает её имя и твои права и
// рисует холст в формате Excalidraw (см. internal/excalidraw и
// board/render.js — что именно рисуется, а что показывается заглушкой).
//
// Своих инструментов рисования тут пока нет: доска умеет показать
// импортированное и по нему ездить. Правка — следующая ветка.
import { Application, Container, Graphics } from "pixi.js";
import { fetchBoard, fetchBoardScene } from "../api.js";
import {
  createBoardCamera,
  applyBoardCamera,
  boardScreenToWorld,
  zoomBoardAt,
  fitBoard,
} from "../board/camera.js";
import { renderScene } from "../board/render.js";

const canvas = document.getElementById("board");
const wrap = document.getElementById("canvasWrap");
const statusEl = document.getElementById("status");
const nameEl = document.getElementById("boardName");
const metaEl = document.getElementById("boardMeta");
const readonlyBadge = document.getElementById("readonlyBadge");
const zoomLevel = document.getElementById("zoomLevel");

// boardId — из query-строки: доска открывается плавающим окном по ссылке
// board.html?id=… (см. openBoardWindow в pages/dm.js и pages/player.js).
const boardId = new URLSearchParams(location.search).get("id") || "";

// GRID_STEP — шаг точечной сетки в мировых единицах. Сетка тут не игровая (у
// доски нет клеток и дистанций, в отличие от сцены), а чисто зрительная: на
// пустом бесконечном холсте без неё не понять ни что камера едет, ни какой
// сейчас масштаб.
const GRID_STEP = 64;
// Ниже этого экранного шага точки сливаются в кашу — рисуем каждую вторую,
// четвёртую и так далее.
const MIN_SCREEN_STEP = 12;

const camera = createBoardCamera();

// boot — весь модуль в одной async-функции: top-level await не проходит по
// цели сборки (см. vite.config.js), и остальные страницы устроены так же.
(async function boot() {
const app = new Application();
await app.init({
  canvas,
  resizeTo: wrap,
  backgroundAlpha: 0,
  antialias: true,
  resolution: window.devicePixelRatio || 1,
  autoDensity: true,
});

// world — всё содержимое холста; grid лежит ОТДЕЛЬНО, вне world: сетка
// рисуется сразу в экранных координатах по текущей камере, иначе точки
// масштабировались бы вместе с миром и на отдалении превращались в пыль.
const grid = new Graphics();
const world = new Container();
app.stage.addChild(grid, world);

function screenW() {
  return app.screen.width;
}
function screenH() {
  return app.screen.height;
}

function drawGrid() {
  const w = screenW();
  const h = screenH();
  grid.clear();

  // Шаг сетки на экране; пока он слишком мелкий — прореживаем вдвое.
  let step = GRID_STEP;
  while (step * camera.zoom < MIN_SCREEN_STEP) step *= 2;
  const screenStep = step * camera.zoom;

  const topLeft = boardScreenToWorld(0, 0, camera, w, h);
  const startX = Math.floor(topLeft.x / step) * step;
  const startY = Math.floor(topLeft.y / step) * step;
  const offX = (startX - topLeft.x) * camera.zoom;
  const offY = (startY - topLeft.y) * camera.zoom;

  const radius = camera.zoom > 1.5 ? 1.6 : 1.2;
  for (let x = offX; x <= w; x += screenStep) {
    for (let y = offY; y <= h; y += screenStep) {
      grid.circle(x, y, radius);
    }
  }
  grid.fill({ color: 0xffffff, alpha: 0.12 });

  // Начало координат — единственный ориентир на бесконечном холсте: без него
  // «уехал далеко» невозможно отличить от «уехал совсем далеко».
  const origin = { x: (0 - topLeft.x) * camera.zoom, y: (0 - topLeft.y) * camera.zoom };
  if (origin.x > -40 && origin.x < w + 40 && origin.y > -40 && origin.y < h + 40) {
    grid
      .moveTo(origin.x - 14, origin.y)
      .lineTo(origin.x + 14, origin.y)
      .moveTo(origin.x, origin.y - 14)
      .lineTo(origin.x, origin.y + 14)
      .stroke({ width: 1.5, color: 0x7c6cf0, alpha: 0.5 });
  }
}

function render() {
  applyBoardCamera(world, camera, screenW(), screenH());
  drawGrid();
  zoomLevel.textContent = Math.round(camera.zoom * 100) + "%";
}

new ResizeObserver(() => {
  app.resize();
  render();
}).observe(wrap);

// ---- камера: колесо, перетягивание, два пальца ----

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    zoomBoardAt(camera, e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.15 : 1 / 1.15, screenW(), screenH());
    render();
  },
  { passive: false }
);

// Одиночное перетягивание тащит холст: рисовать пока нечем, и любой другой
// смысл у него был бы выдуманным. Когда появятся инструменты, пан переедет на
// среднюю кнопку и пробел, как на сцене.
let panning = null;
const touches = new Map();
let pinch = null;

canvas.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "touch") {
    const rect = canvas.getBoundingClientRect();
    touches.set(e.pointerId, { sx: e.clientX - rect.left, sy: e.clientY - rect.top });
    if (touches.size === 2) {
      panning = null;
      pinch = pinchFrame();
    }
    if (touches.size !== 1) return;
  }
  if (pinch) return;
  panning = { sx: e.clientX, sy: e.clientY, camX: camera.x, camY: camera.y };
  canvas.classList.add("panning");
});

function pinchFrame() {
  const [a, b] = [...touches.values()];
  return { dist: Math.hypot(a.sx - b.sx, a.sy - b.sy) || 1, cx: (a.sx + b.sx) / 2, cy: (a.sy + b.sy) / 2 };
}

window.addEventListener("pointermove", (e) => {
  if (touches.has(e.pointerId)) {
    const rect = canvas.getBoundingClientRect();
    touches.set(e.pointerId, { sx: e.clientX - rect.left, sy: e.clientY - rect.top });
    if (pinch && touches.size >= 2) {
      const now = pinchFrame();
      zoomBoardAt(camera, now.cx, now.cy, now.dist / pinch.dist, screenW(), screenH());
      camera.x -= (now.cx - pinch.cx) / camera.zoom;
      camera.y -= (now.cy - pinch.cy) / camera.zoom;
      pinch = now;
      render();
      return;
    }
  }
  if (!panning) return;
  camera.x = panning.camX - (e.clientX - panning.sx) / camera.zoom;
  camera.y = panning.camY - (e.clientY - panning.sy) / camera.zoom;
  render();
});

function endPointer(e) {
  if (touches.has(e.pointerId)) {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
  }
  panning = null;
  canvas.classList.remove("panning");
}
window.addEventListener("pointerup", endPointer);
window.addEventListener("pointercancel", endPointer);

document.getElementById("zoomInBtn").onclick = () => {
  zoomBoardAt(camera, screenW() / 2, screenH() / 2, 1.3, screenW(), screenH());
  render();
};
document.getElementById("zoomOutBtn").onclick = () => {
  zoomBoardAt(camera, screenW() / 2, screenH() / 2, 1 / 1.3, screenW(), screenH());
  render();
};
// contentBounds — габариты нарисованного; «Сброс» вписывает именно их, а на
// пустой доске возвращает в начало координат (см. fitBoard).
let contentBounds = null;
document.getElementById("zoomResetBtn").onclick = () => {
  fitBoard(camera, contentBounds, screenW(), screenH());
  render();
};

// ---- загрузка доски ----

async function load() {
  if (!boardId) {
    statusEl.textContent = "Доска не указана.";
    return;
  }
  try {
    const board = await fetchBoard(boardId);
    nameEl.textContent = board.name;
    document.title = "Beacon Table — " + board.name;
    const who = board.ownerName ? "автор: " + board.ownerName : "заведена ДМ";
    metaEl.textContent = board.shared ? who + " · общая" : who + " · личная";
    // canEdit приходит уже посчитанным сервером — клиент права не
    // пересчитывает (см. boardJSON в internal/api/http/board_handlers.go).
    readonlyBadge.classList.toggle("on", !board.canEdit);

    const scene = await fetchBoardScene(boardId);
    const bounds = renderScene(world, scene);
    const count = (scene.elements || []).filter((e) => e && !e.isDeleted).length;
    if (count === 0) {
      statusEl.textContent = "Холст пустой. Импортируй доску из Excalidraw или дождись инструментов рисования.";
    } else {
      statusEl.textContent = "";
      // Открываем сразу по содержимому: на бесконечном холсте начало
      // координат может оказаться далеко от того, что на доске нарисовано.
      fitBoard(camera, bounds, screenW(), screenH());
      contentBounds = bounds;
    }
    render();
  } catch (err) {
    statusEl.textContent = err && err.message ? err.message : "Не удалось открыть доску.";
  }
}

render();
await load();
})();
